import { Hono } from "hono";
import type { UpstreamManager } from "../upstream/manager.js";
import type { PromptNormalizer } from "../core/normalizer.js";
import type { RequestLogger } from "../core/request-logger.js";
import type { CacheWarmer } from "../core/cache-warmer.js";
import { injectCacheControl } from "../core/cache-injector.js";
import { forwardWithRetry } from "../upstream/forwarder.js";
import { logger } from "../utils/logger.js";
import { hashSystemPrompt } from "../core/query-extractor.js";
import type { Message } from "../core/types.js";

export function createProxyRoute(
  upstreamMgr: UpstreamManager,
  normalizer: PromptNormalizer,
  requestLogger: RequestLogger,
  cacheWarmer: CacheWarmer,
): Hono {
  const app = new Hono();
  const inflight = new Map<string, Promise<Response>>();

  // 双端点：OpenAI → /v1/*，Anthropic → /v1/messages
  // 不做格式转换，客户端根据需要选择端点
  app.all("/v1/*", proxyHandler);
  app.post("/v1/messages", proxyHandler);
  // URL 路径透传上游选择：/x-upstream/:name/v1/...
  // 让智能体在 baseURL 里就指定上游，免去自定义 header
  app.all("/x-upstream/:name/v1/*", proxyHandler);
  app.post("/x-upstream/:name/v1/messages", proxyHandler);

  async function proxyHandler(c: any) {
      let path = c.req.path;
      // 从路径里提取上游名并重写路径为标准 /v1/...
      // 同时把上游名注入到 header map，让下游 c.req.header() 也能读到
      const pathUpstreamMatch = path.match(/^\/x-upstream\/([^\/]+)\/(.+)$/);
      if (pathUpstreamMatch) {
        const [, upstreamFromPath, rest] = pathUpstreamMatch;
        const merged: Record<string, string> = {};
        c.req.raw.headers.forEach((v: string, k: string) => { merged[k.toLowerCase()] = v; });
        merged["x-upstream"] = upstreamFromPath;
        // 覆盖 Hono 的 header() 返回值，使下游 c.req.header() 看到带 x-upstream 的表
        c.req.header = (name?: string) => {
          if (name) return merged[name.toLowerCase()];
          return merged;
        };
        path = "/" + rest;
      }

      let upstream;
      let upstreamName: string;
      try {
        upstreamName = upstreamMgr.resolveName(c.req.header() as Record<string, string>);
        upstream = upstreamMgr.resolve(c.req.header() as Record<string, string>);
      } catch (e) {
        return c.json({ error: { message: (e as Error).message } }, 400);
      }

      const method = c.req.method;
      let body: any = undefined;
      if (method !== "GET" && method !== "HEAD") {
        try { body = await c.req.json(); } catch { /* 非 JSON */ }
      }

      // 解析 body 后再决定上游：让 body.model 优先于 x-upstream header
      // 这样多上游可以并存，客户端不需要每个请求手动指定 header
      if (body?.model && !c.req.header()["x-upstream"]) {
        const routed = upstreamMgr.resolveByModel(body.model);
        if (routed) {
          upstream = routed.upstream;
          upstreamName = routed.name;
          logger.info(`[Route] body.model="${body.model}" → ${upstreamName}`);
        } else {
          logger.warn(`[Route] body.model="${body.model}" 未匹配任何上游，兜底到 ${upstreamName}`);
        }
      }

      const startTime = Date.now();
      const isChat = (method === "POST") && body?.messages;
      // 主动缓存断点索引（每条被打了 cache_control 的 messages[i] 的下标）
      let activeCachePointIndexes: number[] = [];

      // ── 请求稳定化 ──
      if (isChat) {
        // 根据 upstream.cacheMode + normalization 决定 normalizer 模式（每个请求独立，无 race condition）
        // active 默认 safe（生产优先），可配置 aggressive（缓存优先）
        // "none" 模式下 normalizer 会原样返回，不清理任何动态字段
        const normalized = normalizer.normalize(body.messages, upstream.cacheMode, upstream.normalization);
        // 检查当前模型是否支持多模态（模型级优先，上游级兜底）
        const modelConf = upstream.models.find(m => m.id === body.model);
        const supportsMultimodal = modelConf?.imageInput ?? upstream.multimodal;
        body.messages = supportsMultimodal
          ? normalized
          : normalizer.sanitizeForUpstream(normalized);

        // ── 流式请求自动注入 stream_options ──
        // 让上游在流结束时返回 usage，用于统计
        // 只在 OpenAI 格式时注入，Anthropic 格式不支持此字段
        if (body.stream === true && !body.stream_options && upstream.apiFormat === "openai") {
          body.stream_options = { include_usage: true };
        }

        // ── Anthropic 协议要求 max_tokens 必填且 > 0 ──
        // OpenAI 客户端通常不传 max_tokens（模型自定），但 Anthropic 协议强制必填
        // 这里为 anthropic 格式的请求补上默认值，避免 400 "requires a positive maxTokens value"
        // 8192 是 Anthropic 多数模型的合理默认上限
        ensureAnthropicMaxTokens(body, upstream.apiFormat);

        // ── 主动缓存注入 ──
        // cacheMode="active": 注入 cache_control（仅 Anthropic 路径打 marker；OpenAI 路径只做标准化）
        //                    适用于百炼、Anthropic 等支持 cache_control 的厂商
        // cacheMode="implicit": 不注入 cache_control，但 normalizer 已在上方切到 implicit 激进模式
        //                    适用于 DeepSeek、智谱、Kimi 等无 cache_control 但有 prefix cache 的厂商
        // cacheMode="none": 跳过所有缓存优化
        // apiFormat 由请求路径决定：/v1/messages → anthropic，其它 → openai
        const apiFormat: "anthropic" | "openai" = path.endsWith("/v1/messages") ? "anthropic" : "openai";
        activeCachePointIndexes = [];

        if (upstream.cacheMode === "active" && apiFormat === "anthropic" && upstream.supportsCacheControl) {
          const injected = injectCacheControl(body, {
            maxCacheMarkers: 4,
            debug: process.env.DEBUG_CACHE_PROXY === "1",
          }, normalizer, apiFormat);
          body = injected.body;
          activeCachePointIndexes = injected.messageIndexes;
          logger.info(`[CacheInject] ${injected.markers} markers, ${activeCachePointIndexes.length} points (format=${apiFormat})`);
        } else if (upstream.cacheMode === "implicit") {
          // implicit 模式：依赖厂商自身 prefix cache，不打 cache_control
          // normalizer 已经在上方切到 implicit 激进模式（让 messages 字节稳定）
          logger.info(`[CacheImplicit] mode=implicit format=${apiFormat} - rely on vendor prefix cache`);
        } else if (upstream.cacheMode === "active" && apiFormat === "anthropic" && !upstream.supportsCacheControl) {
          // active 模式但上游 anthropic 兼容端点不识别 cache_control 字段
          // 跳过 cache_control 注入（否则会 400 invalid params）
          // normalizer 仍按 active 保守清理；命中率靠厂商自身 prefix cache 兜底
          logger.info(`[CacheInject] Skipped: upstream "${upstreamName}" supportsCacheControl=false (anthropic 兼容端点不识别 cache_control)`);
        }

        // 请求去重
        const dedupeKey = simpleHash(JSON.stringify(body.messages));
        const existing = inflight.get(dedupeKey);
        if (existing) {
          logger.info(`[Dedup] Reusing in-flight [${upstreamName}]`);
          return (await existing).clone();
        }
      }

      // ── 转发 ──
      const doForward = async (): Promise<Response> => {
        try {
          const reqHeaders = { ...c.req.header() } as Record<string, string>;
          // 把 resolveByModel 选出的 upstream 注入到 x-upstream header
          // 这样 forwardWithRetry 内的 resolveName 才能拿到正确的当前上游
          reqHeaders["x-upstream"] = upstreamName;
          if (isChat) {
            const ph = hashSystemPrompt(body.messages as Message[]);
            if (ph) reqHeaders["x-prefix-hash"] = ph;
          }

          const result = await forwardWithRetry(upstreamMgr, path, method, body, reqHeaders);

          // ── 记录请求日志（所有请求，包括错误和流式）──
          const logRequest = (usage?: { input: number; output: number; cacheHit: number; cacheMiss: number }) => {
            if (!isChat) return;
            const u = usage || { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
            requestLogger.log({
              timestamp: Date.now(), upstream: upstreamName, model: body.model || "unknown", path,
              stream: body.stream === true,
              vendorCacheHitTokens: u.cacheHit, vendorCacheMissTokens: u.cacheMiss,
              promptTokens: u.input, completionTokens: u.output,
              latencyMs: Date.now() - startTime,
              cachePoints: activeCachePointIndexes,
            });
          };

          if (result.status >= 400) {
            const errBody = typeof result.body === "string"
              ? result.body
              : await readStream(result.body as ReadableStream);
            logger.error(`[Upstream] ${result.status}: ${errBody.slice(0, 300)}`);
            logRequest();
            return new Response(errBody, {
              status: result.status,
              headers: { "Content-Type": result.headers["content-type"] || "application/json" },
            });
          }

          const ct = result.headers["content-type"] || "";

          // 流式透传 + TransformStream 捕获 usage
          if (ct.includes("text/event-stream") && result.body instanceof ReadableStream) {
            const chunks: string[] = [];
            const decoder = new TextDecoder();
            const t = new TransformStream({
              transform(chunk, controller) {
                chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
                controller.enqueue(chunk);
              },
              flush() {
                // flush decoder 缓冲
                chunks.push(decoder.decode());
                const text = chunks.join("");
                const usage = extractUsageFromSSE(text);
                logRequest(usage);
                // 流式请求也更新缓存预热器
                if (cacheWarmer) {
                  cacheWarmer.update(body);
                }
              },
            });
            return new Response(result.body.pipeThrough(t), {
              status: result.status,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                ...(isChat && activeCachePointIndexes.length > 0
                  ? { "X-Cache-Points": activeCachePointIndexes.join(",") }
                  : {}),
              },
            });
          }

          const bodyText = await readStream(result.body as ReadableStream);
          logRequest(extractUsage(bodyText));

          // 更新缓存预热器
          if (cacheWarmer) {
            cacheWarmer.update(body);
          }

          return new Response(bodyText, {
            status: result.status,
            headers: {
              "Content-Type": ct || "application/json",
              ...(isChat && activeCachePointIndexes.length > 0
                ? { "X-Cache-Points": activeCachePointIndexes.join(",") }
                : {}),
            },
          });
        } catch (e) {
          logger.error(`Forward error:`, e);
          return new Response(
            JSON.stringify({ error: { message: (e as Error).message } }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
      };

      if (isChat) {
        const dedupeKey = simpleHash(JSON.stringify(body.messages));
        const promise = doForward();
        inflight.set(dedupeKey, promise);
        try { return await promise; } finally { inflight.delete(dedupeKey); }
      }

      return doForward();
  }

  return app;
}

// ─── 工具函数 ───

async function readStream(stream: ReadableStream): Promise<string> {
  if (typeof stream === "string") return stream;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `h-${Math.abs(h).toString(36)}`;
}

/**
 * 从 SSE 文本中提取 usage
 * 支持两种格式：
 * - OpenAI: chunk.usage 含 prompt_tokens / completion_tokens
 *   （stream_options: { include_usage: true } 时，最后一个 chunk 才有完整 usage）
 * - Anthropic:
 *   - message_start 事件的 data.message.usage 含 input_tokens / cache_read_input_tokens / cache_creation_input_tokens
 *   - message_delta 事件的 data.usage 含最终的 output_tokens
 *   需要把两者合并
 */
export function extractUsageFromSSE(sseText: string): { input: number; output: number; cacheHit: number; cacheMiss: number } {
  const lines = sseText.split("\n");
  let openaiUsage: any = null;     // OpenAI：取最后一个含 usage 的 chunk
  let anthropicUsage: any = null;  // Anthropic：合并 message_start + message_delta

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    // 兼容两种格式：SSE 规范要求 "data: <value>"（带空格），但 Anthropic/部分服务省略空格
    const data = line.slice(5).replace(/^ /, "");
    if (data === "[DONE]" || !data) continue;
    let chunk: any;
    try { chunk = JSON.parse(data); } catch { continue; }

    // OpenAI 顶层 usage（最后出现的才是最终值）
    if (chunk.usage && (chunk.usage.prompt_tokens !== undefined || chunk.usage.completion_tokens !== undefined)) {
      openaiUsage = chunk.usage;
    }

    // Anthropic message_start: data.message.usage
    if (chunk.type === "message_start" && chunk.message?.usage) {
      anthropicUsage = { ...(anthropicUsage || {}), ...chunk.message.usage };
    }

    // Anthropic message_delta: data.usage（output_tokens 在这里）
    if (chunk.type === "message_delta" && chunk.usage) {
      anthropicUsage = { ...(anthropicUsage || {}), ...chunk.usage };
    }
  }

  if (openaiUsage) return extractUsageFields(openaiUsage);
  if (anthropicUsage) return extractUsageFields(anthropicUsage);
  return { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
}

export function extractUsage(bodyText: string): { input: number; output: number; cacheHit: number; cacheMiss: number } {
  try {
    const parsed = JSON.parse(bodyText);
    return extractUsageFields(parsed.usage || {});
  } catch {
    return { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
  }
}

/**
 * 从 usage 对象提取缓存相关字段
 * 支持多种格式：
 * - OpenAI: prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - Anthropic: cache_read_input_tokens / cache_creation_input_tokens
 * - 百炼: prompt_tokens_details.cached_tokens / cache_creation_input_tokens
 */
export function extractUsageFields(u: any): { input: number; output: number; cacheHit: number; cacheMiss: number } {
  const output = u.completion_tokens || u.output_tokens || 0;

  // 缓存命中：优先 OpenAI 顶层 → Anthropic 顶层 → 百炼嵌套
  let cacheHit = u.prompt_cache_hit_tokens || u.cache_read_input_tokens || 0;
  if (cacheHit === 0 && u.prompt_tokens_details?.cached_tokens) {
    cacheHit = u.prompt_tokens_details.cached_tokens;
  }
  if (cacheHit === 0 && u.input_tokens_details?.cached_tokens) {
    cacheHit = u.input_tokens_details.cached_tokens;
  }

  // 缓存创建：优先 Anthropic 顶层 → OpenAI 顶层 → 百炼嵌套
  let cacheMiss = u.prompt_cache_miss_tokens || u.cache_creation_input_tokens || 0;
  if (cacheMiss === 0 && u.prompt_tokens_details?.cache_creation_input_tokens) {
    cacheMiss = u.prompt_tokens_details.cache_creation_input_tokens;
  }
  if (cacheMiss === 0 && u.input_tokens_details?.cache_creation_input_tokens) {
    cacheMiss = u.input_tokens_details.cache_creation_input_tokens;
  }

  // 输入总量归一化：
  // 关键陷阱——不能靠 input 字段名判断口径：
  //   - 原生 Anthropic（api.anthropic.com）：用 input_tokens，且【不含】缓存
  //   - 百炼 Anthropic 兼容（/apps/anthropic）：用 input_tokens，但【已含】缓存
  //   - OpenAI / 百炼 OpenAI 兼容：用 prompt_tokens 或 input_tokens，均【已含】缓存
  // 可靠判定信号 = 缓存字段位置：
  //   - 缓存字段在顶层（cache_read_input_tokens / cache_creation_input_tokens）→ 原生 Anthropic → 需加回
  //   - 缓存字段在 prompt_tokens_details / input_tokens_details 嵌套 → OpenAI 家族（含百炼）→ 已含，不加
  let input = u.prompt_tokens || u.input_tokens || 0;
  const isAnthropicNative =
    u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
  if (isAnthropicNative && u.input_tokens !== undefined) {
    input = u.input_tokens + cacheHit + cacheMiss;
  }

  return { input, output, cacheHit, cacheMiss };
}

/**
 * 为 anthropic 格式请求补全 max_tokens（Anthropic 协议要求必填且 > 0）
 * - 缺失 / 0 / 负数 / NaN / Infinity → 注入 8192（Anthropic 多数模型默认上限）
 * - 已传合法正整数 → 不动
 * - openai 格式 → 不动（OpenAI 协议 max_tokens 可选）
 */
export function ensureAnthropicMaxTokens(body: any, apiFormat: "anthropic" | "openai"): void {
  if (apiFormat !== "anthropic") return;
  const v = body?.max_tokens;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    if (body) body.max_tokens = 8192;
  }
}
