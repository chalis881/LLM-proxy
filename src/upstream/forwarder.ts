import type { UpstreamConfig } from "../core/types.js";
import type { UpstreamManager } from "./manager.js";
import { logger } from "../utils/logger.js";
import { stableStringify } from "../utils/stable-stringify.js";

export interface ForwardResult {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | string;
  headers: Record<string, string>;
  errorBody?: string;
}

/**
 * 读取 ReadableStream 为 string
 */
async function readStreamBody(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * 单次请求转发
 */
export async function forward(
  upstream: UpstreamConfig,
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<ForwardResult> {
  const base = upstream.baseURL.replace(/\/$/, "");

  // 按 API 格式 + 请求路径构建 URL
  // 只有 POST 聊天请求用 Anthropic 格式，其他请求（GET models 等）原样转发
  const isChatRequest = method === "POST" && (path.includes("chat/completions") || path.includes("messages"));
  let url: string;
  if (upstream.apiFormat === "anthropic" && isChatRequest) {
    url = `${base}/messages`;
  } else {
    url = base.endsWith("/v1") && path.startsWith("/v1")
      ? `${base}${path.slice(3)}`
      : `${base}${path}`;
  }

  // Anthropic 格式用 x-api-key，OpenAI 格式用 Bearer
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (upstream.apiFormat === "anthropic") {
    upstreamHeaders["x-api-key"] = upstream.apiKey;
    upstreamHeaders["anthropic-version"] = "2023-06-01";
  } else {
    upstreamHeaders["Authorization"] = `Bearer ${upstream.apiKey}`;
  }

  // 上游透传头：只保留对厂商侧前缀字节稳定且真正需要的字段
  // 客户端发来的 content-length / content-encoding / accept-encoding 等
  // 会让相同语义请求产生不同字节，破坏厂商隐式缓存
  const PASSTHROUGH_HEADERS = new Set([
    "accept",
    "anthropic-version",
    "x-request-id",
  ]);

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "x-prefix-hash" || lower === "host" || lower === "content-length") continue;
    if (!PASSTHROUGH_HEADERS.has(lower)) continue;
    upstreamHeaders[lower] = value;
  }

  // 稳定序列化：对象 key 按字典序深度排列
  // 消除客户端 JSON key 顺序差异导致的字节漂移，提升厂商 prefix cache 命中率
  // 不改任何 value，只让相同语义的 body 产生相同字节
  const bodyStr = body ? stableStringify(body) : undefined;
  logger.info(`→ ${method} ${url}`);

  // 调试模式下记录请求体（截断避免日志过大）
  if (process.env.DEBUG) {
    const truncated = bodyStr && bodyStr.length > 500
      ? bodyStr.slice(0, 500) + `... (${bodyStr.length} chars)`
      : bodyStr;
    logger.debug(`→ Body: ${truncated}`);
  }

  const resp = await fetch(url, {
    method,
    headers: upstreamHeaders,
    body: bodyStr,
  });

  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  logger.info(`← ${resp.status} ${resp.statusText}`);

  // 错误响应：读取 body 以便透传错误详情
  if (resp.status >= 400) {
    let errorBody = "";
    if (resp.body) {
      try {
        errorBody = await readStreamBody(resp.body as ReadableStream<Uint8Array>);
        // 记录上游错误详情
        logger.warn(`[Upstream Error] ${resp.status} ${url}`);
        logger.warn(`[Upstream Error] Body: ${errorBody.slice(0, 1000)}`);
      } catch {
        // 读取失败忽略
      }
    }

    // 为 5xx 错误提供建议
    if (resp.status >= 500) {
      logger.warn(`[Upstream Error] 5xx 错误，将尝试重试或故障转移`);
    }

    return {
      ok: false,
      status: resp.status,
      body: errorBody || `Upstream returned ${resp.status}`,
      headers: respHeaders,
      errorBody,
    };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    body: resp.body as ReadableStream<Uint8Array>,
    headers: respHeaders,
  };
}

/**
 * 带重试 + 故障转移的转发
 * - 5xx 错误自动重试（最多 maxRetries 次）
 * - 网络错误自动重试
 * - 重试时切换到下一个上游
 */
export async function forwardWithRetry(
  upstreamMgr: UpstreamManager,
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string>,
  maxRetries?: number,
): Promise<ForwardResult> {
  const originalUpstream = upstreamMgr.resolveName(headers);
  const fallbacks = upstreamMgr.getFallbackNames(originalUpstream);

  // 构建尝试顺序：当前上游 + 其他上游
  const attempts = [originalUpstream, ...fallbacks];
  // 默认尝试所有上游（至少 3 次）
  const maxAttempts = maxRetries !== undefined ? maxRetries + 1 : Math.max(attempts.length, 3);
  const errors: string[] = [];

  for (let i = 0; i < attempts.length && i < maxAttempts; i++) {
    const name = attempts[i];
    try {
      const upstream = upstreamMgr.getByName(name);
      if (!upstream) continue;

      const result = await forward(upstream, path, method, body, headers);

      // 成功（非 5xx）直接返回
      if (result.status < 500) {
        if (i > 0) {
          logger.info(`[Retry] 故障转移成功: ${originalUpstream} → ${name}`);
        }
        return result;
      }

      // 5xx 错误，记录并尝试下一个
      errors.push(`${name}: ${result.status} ${result.errorBody?.slice(0, 200) || ""}`);
      if (i < maxAttempts - 1) {
        logger.warn(`[Retry] Upstream "${name}" 返回 ${result.status}，切换到下一个...`);
      }
    } catch (e) {
      const errMsg = (e as Error).message;
      errors.push(`${name}: ${errMsg}`);
      logger.warn(`[Retry] Upstream "${name}" 网络错误: ${errMsg}`);
      if (i < maxAttempts - 1) {
        logger.warn(`[Retry] 切换到下一个上游...`);
      }
    }
  }

  // 所有上游都失败了，返回最后一个错误
  const lastError = errors[errors.length - 1] || "Unknown error";
  logger.error(`[Retry] 所有上游均失败: ${errors.join(" → ")}`);
  throw new Error(`All upstreams failed: ${lastError}`);
}
