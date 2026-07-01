import { logger } from "../utils/logger.js";
import { stableStringify } from "../utils/stable-stringify.js";

/**
 * 主动缓存注入器（参考 daili 项目策略）
 *
 * 两阶段注入：
 *   阶段一：injectSystemCache — system prompt 逐 block 稳定性分析
 *   阶段二：injectMessagesCache — messages 前缀断点选择
 *
 * 两阶段共享 state { markers, records }，受 maxCacheMarkers 上限约束
 */

export interface InjectConfig {
  minCacheTokens: number;
  maxCacheMarkers: number;
  cacheLatestUser: boolean;
  debug: boolean;
  /** @deprecated Qwen3.5+ 仅支持 message 级缓存，阶梯策略已废弃，保留字段向后兼容 */
  tierInterval: number;
  /** @deprecated Qwen3.5+ 仅支持 message 级缓存，智能尾部桩已废弃，保留字段向后兼容 */
  tailMinValueTokens: number;
  /** @deprecated Qwen3.5+ 仅支持 message 级缓存，block 间隔限制已废弃，保留字段向后兼容 */
  maxBlockGap: number;
}

const DEFAULT_CONFIG: InjectConfig = {
  minCacheTokens: 1024,
  // 官方 Qwen3.5+ 显式缓存支持最多 4 个 marker（system + skills/tools + project 上下文 + 对话历史）
  maxCacheMarkers: 4,
  cacheLatestUser: true,
  debug: false,
  tierInterval: 0,
  tailMinValueTokens: 0,
  maxBlockGap: 0,
};

// ─── Token 估算 ───

/**
 * 用 V8 高度优化的原生正则替代 for...of 字符串迭代
 * 网关层常处理几万字 RAG 上下文，正则比 char iteration 快几十倍
 * - CJK 字符：约 1.5 token/字
 * - 其他字符：约 0.25 token/字符（4 字符 ≈ 1 token）
 */
const CJK_RE = /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + otherCount * 0.25);
}

// ─── 文本提取（支持嵌套 content） ───

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).join("\n");
  if (!content || typeof content !== "object") return "";
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return "";
}

// ─── cache_control 检查与注入 ───

function hasCacheControl(content: unknown): boolean {
  return Array.isArray(content) && (content as any[]).some(
    (b: any) => b?.cache_control?.type === "ephemeral"
  );
}

function isCacheableBlock(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.cache_control?.type === "ephemeral") return false;
  return block.type === "text" && extractText(block).length > 0;
}

function addCacheControlToLastCacheable(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
  }
  if (!Array.isArray(content) || hasCacheControl(content)) return content;

  const arr = content as any[];
  // 优先找最后一个 text 类型的可缓存 block
  let idx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.type === "text" && isCacheableBlock(arr[i])) { idx = i; break; }
  }
  // 回退：任意可缓存 block
  if (idx === -1) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (isCacheableBlock(arr[i])) { idx = i; break; }
    }
  }
  // 最后回退：如果全是 tool_result / image_url / 非 text 块，宁可放弃缓存也不破坏 API 协议
  // —— OpenAI/Anthropic 对 messages 结构有严格校验，擅自追加 text 块可能 400
  // tool_result 应走 addCacheControlToLastToolResultBlock 单独路径（Anthropic 模式）
  if (idx === -1) {
    return content;
  }

  return arr.map((block: any, i: number) =>
    i === idx ? { ...block, cache_control: { type: "ephemeral" } } : block
  );
}

// ─── 稳定性判断 ───
//
// 设计原则：normalizer 已经清理了所有可替换的动态值（时间戳→[TIMESTAMP]、UUID→[UUID] 等）
// isDynamicText 只检测 normalizer 无法处理的、真正会导致前缀不稳定的模式
// 不要重复检测 normalizer 已经覆盖的模式（时间戳格式、UUID 格式、IP 格式等）

function isDynamicTextLocal(text: string, normalizer?: any): boolean {
  if (!text || text.length < 10) return false;
  // 如果有 normalizer，优先使用它的判断（它了解完整的清理能力）
  if (normalizer?.isDynamicText) return normalizer.isDynamicText(text);
  // 否则做基本检测（normalizer 缺失或漏清理时的兜底）
  return (
    // git 命令输出
    /git\s+(status|diff|log|show)\b/i.test(text) ||
    // 中文日志关键词
    /错误日志|报错日志/i.test(text) ||
    // ISO 8601 时间戳（normalizer 应清理过，但兜底拦截更稳）
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) ||
    // 32+ 位 hex（MD5/SHA1/UUID 不带连字符）
    /[a-f0-9]{32}/i.test(text)
  );
}

function isStableMessage(msg: any, normalizer?: any): boolean {
  const text = extractText(msg.content);
  // 空文本不破坏稳定性链（虽然没有缓存价值）
  if (!text) return true;
  return !isDynamicTextLocal(text, normalizer);
}

function isDynamicBlock(block: any, normalizer?: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.type !== "text") return false;
  return isDynamicTextLocal(extractText(block), normalizer);
}

// ─── 缓存断点选择 ───

interface CacheCandidate {
  index: number;
  prefixTokens: number;
  messageTokens: number;
}

function selectCachePoints(messages: any[], config: InjectConfig, normalizer?: any, remainingMarkers?: number, baseTokens = 0): CacheCandidate[] {
  const cap = remainingMarkers ?? config.maxCacheMarkers;
  if (cap <= 0) return [];

  // 跳过 system（由 injectSystemCache 单独处理）
  const startIndex = messages.findIndex((m) => m.role !== "system");
  const begin = startIndex === -1 ? messages.length : startIndex;
  const lastIndex = messages.length - 1;

  if (begin > lastIndex) return [];

  // 对非 system 段累计 token 和稳定性
  let prefixTokens = 0;
  const msgInfos: Array<{ index: number; prefixTokens: number; messageTokens: number; stable: boolean }> = [];
  let prefixIsStable = true;
  for (let i = begin; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateTokens(extractText(msg.content));
    prefixTokens += msgTokens;
    const msgStable = isStableMessage(msg, normalizer);
    prefixIsStable = prefixIsStable && msgStable;
    if (msgTokens > 0) {
      msgInfos.push({ index: i, prefixTokens, messageTokens: msgTokens, stable: prefixIsStable });
    }
  }

  if (msgInfos.length === 0) return [];

  // message 级分层策略：
  // cap=1: 末尾
  // cap=2: 1/2 + 末尾
  // cap=3: 1/3 + 2/3 + 末尾
  // cap=4: 1/4 + 2/4 + 3/4 + 末尾
  // 然后用 stable 字段过滤：中间断点前缀不稳定则剔除（写入有 25% 额外开销，必 miss 的断点宁可不打）
  // 末尾保留：动态内容下一轮会成为稳定历史，仍有缓存价值（多轮/工具循环场景）
  const positions: number[] = [];
  for (let k = 1; k <= cap; k++) {
    const frac = k / cap;
    const idealMsgInfoIndex = Math.min(Math.round(frac * (msgInfos.length - 1)), msgInfos.length - 1);
    positions.push(idealMsgInfoIndex);
  }

  // 去重
  const uniquePositions = [...new Set(positions)];
  const tailPos = msgInfos.length - 1;

  const result: CacheCandidate[] = [];
  for (const pos of uniquePositions) {
    const info = msgInfos[pos];
    // 全局前缀基准：阶段一 system 段（含 tools）已累计的 token + messages 段前缀
    // 官方文档「缓存内容最少 1024 Token」指截断点之前的全部内容，不是 messages 段独立累计
    // 修复"大 system + 小 messages"场景：末尾断点被错误过滤，导致 cacheLatestUser 失效
    // （末尾位置由 k=cap 时 frac=1.0 必然落入 positions，唯一可能丢失它的就是这道门槛）
    if (baseTokens + info.prefixTokens < config.minCacheTokens) continue;
    // 中间断点前缀不稳定 → 下一轮必然 miss，缓存写入有 25% 额外开销，打这种断点纯亏
    // 末尾保留：动态内容下一轮会成为稳定历史，仍有缓存价值（多轮/工具循环场景）
    if (pos !== tailPos && !info.stable) continue;
    result.push({
      index: info.index,
      prefixTokens: info.prefixTokens,
      messageTokens: info.messageTokens,
    });
  }

  return result;
}

// ─── 两阶段注入 ───

interface InjectState {
  markers: number;
  records: Array<{ target: string; tokens?: number; role?: string; messageTokens?: number; prefixTokens?: number }>;
}

/**
 * 阶段一：system prompt 缓存注入
 * - 字符串 system：整体判断
 * - 数组 system：Qwen3.5+ 仅支持消息级截断，system 数组整体稳定才打标，打在最后一个 text block 上
 * - 包含 body.tools：tools 定义是 system prompt 的一部分，参与缓存计算
 * - 多 system message：Qwen3.5+ 会合并为整体，仅打 1 个 marker
 */
function injectSystemCache(
  body: Record<string, unknown>,
  state: InjectState,
  config: InjectConfig,
  normalizer?: any,
): Record<string, unknown> {
  if (state.markers >= 1) return body;

  // tools token 估算：tools 字段也是缓存前缀的一部分（与 system 一起参与）
  // 用 stableStringify 保证 byte-stable
  const toolsTokens = Array.isArray(body.tools)
    ? estimateTokens(stableStringify(body.tools))
    : 0;

  // OpenAI 风格回退：body.system 不存在但 messages[0]=system
  if (!body.system) {
    const messages = Array.isArray(body.messages) ? body.messages as any[] : [];
    if (messages.length === 0 || messages[0].role !== "system") return body;
    // 多 system message 合并：Qwen3.5+ 会把多条 system 合并为整体
    // 这里只处理 messages[0]，selectCachePoints 会跳过所有 system role
    const text = extractText(messages[0].content);
    const tokens = estimateTokens(text) + toolsTokens;
    if (tokens < config.minCacheTokens || isDynamicTextLocal(text, normalizer)) return body;

    state.markers++;
    state.records.push({ target: "messages[0]", tokens, role: "system" });
    return {
      ...body,
      messages: [
        { ...messages[0], content: addCacheControlToLastCacheable(messages[0].content) },
        ...messages.slice(1),
      ],
    };
  }

  // 非数组：整体判断
  if (!Array.isArray(body.system)) {
    const text = extractText(body.system);
    const tokens = estimateTokens(text) + toolsTokens;
    if (tokens < config.minCacheTokens || isDynamicTextLocal(text, normalizer)) return body;

    state.markers++;
    state.records.push({ target: "system", tokens });
    return { ...body, system: addCacheControlToLastCacheable(body.system) };
  }

  // 数组：Qwen3.5+ 仅支持消息级截断，system 数组被厂商当作整体缓存单元
  // 不能像旧模型那样在中间 block 截断——若 system 中间含动态内容，
  // 整个 system 都不应打标（否则厂商会把含动态内容的整个 system 当缓存 → 脏缓存/命中失败）
  const blocks = body.system as any[];
  let totalSystemTokens = toolsTokens;
  let allStable = true;
  for (const block of blocks) {
    totalSystemTokens += estimateTokens(extractText(block));
    if (isDynamicBlock(block, normalizer)) allStable = false;
  }

  if (!allStable || totalSystemTokens < config.minCacheTokens) return body;

  // 在最后一个可缓存 text block 上打标（厂商按整个 system 建缓存，标记位置仅在记录用）
  let chosenIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isCacheableBlock(blocks[i])) { chosenIdx = i; break; }
  }
  if (chosenIdx === -1) return body;

  state.markers++;
  state.records.push({ target: `system[${chosenIdx}]`, tokens: totalSystemTokens });

  const nextSystem = blocks.map((block: any, i: number) => {
    if (i !== chosenIdx) return block;
    if (block.cache_control?.type === "ephemeral") return block;
    return { ...block, cache_control: { type: "ephemeral" } };
  });

  return { ...body, system: nextSystem };
}

/**
 * 阶段二：messages 缓存注入
 */
function injectMessagesCache(
  body: Record<string, unknown>,
  state: InjectState,
  config: InjectConfig,
  normalizer?: any,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages as any[] : [];
  if (messages.length === 0 || state.markers >= config.maxCacheMarkers) return body;

  const remaining = config.maxCacheMarkers - state.markers;
  // baseTokens：阶段一 system 段已累计的 token（含 tools），作为 messages 段门槛的全局基准
  // 覆盖三种 system 形态：body.system（Anthropic）、system[i]、messages[0]=system（OpenAI 风格）
  const baseTokens = state.records
    .filter((r) => r.target.startsWith("system") || (r.role === "system" && r.target.startsWith("messages[")))
    .reduce((s, r) => s + (r.tokens ?? 0), 0);
  const points = selectCachePoints(messages, config, normalizer, remaining, baseTokens);
  if (points.length === 0) return body;

  const selected = new Map(points.map(p => [p.index, p]));
  const nextMessages = messages.map((msg: any, i: number) => {
    const p = selected.get(i);
    if (!p) return msg;
    if (hasCacheControl(msg.content)) return msg;

    state.markers++;
    state.records.push({
      target: `messages[${i}]`,
      role: msg.role,
      messageTokens: p.messageTokens,
      prefixTokens: p.prefixTokens,
    });

    return { ...msg, content: addCacheControlToLastCacheable(msg.content) };
  });

  return { ...body, messages: nextMessages };
}

/**
 * 阶段二 - Anthropic 模式：messages 缓存注入
 * - 关键差异：末尾断点选 assistant 消息的最后一个 tool_use block（不是整条 user 包装的 tool_result）
 * - 工具调用循环里，下一次请求的"前 N 段"会因为这个断点命中 → 节省 input tokens
 */
function injectMessagesCacheAnthropic(
  body: Record<string, unknown>,
  state: InjectState,
  config: InjectConfig,
  normalizer?: any,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages as any[] : [];
  if (messages.length === 0 || state.markers >= config.maxCacheMarkers) return body;

  const remaining = config.maxCacheMarkers - state.markers;
  // baseTokens：阶段一 system 段已累计的 token（含 tools），作为 messages 段门槛的全局基准
  const baseTokens = state.records
    .filter((r) => r.target.startsWith("system") || (r.role === "system" && r.target.startsWith("messages[")))
    .reduce((s, r) => s + (r.tokens ?? 0), 0);
  const points = selectCachePoints(messages, config, normalizer, remaining, baseTokens);
  if (points.length === 0) return body;

  const selected = new Map(points.map(p => [p.index, p]));
  const nextMessages = messages.map((msg: any, i: number) => {
    const p = selected.get(i);
    if (!p) return msg;
    if (hasCacheControl(msg.content)) return msg;

    state.markers++;
    state.records.push({
      target: `messages[${i}]`,
      role: msg.role,
      messageTokens: p.messageTokens,
      prefixTokens: p.prefixTokens,
    });

    // Anthropic: assistant with tool_use → 打在 tool_use block
    if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === "tool_use")) {
      return { ...msg, content: addCacheControlToLastToolUseBlock(msg.content) };
    }

    // Anthropic: user with tool_result → 打在 tool_result block
    if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === "tool_result")) {
      return { ...msg, content: addCacheControlToLastToolResultBlock(msg.content) };
    }

    return { ...msg, content: addCacheControlToLastCacheable(msg.content) };
  });

  return { ...body, messages: nextMessages };
}

/**
 * 把 cache_control 加到最后一个 tool_use block 上（而不是 text block）
 * 适用于 Anthropic 模式的"末尾工具决策点"断点
 *
 * 设计说明：为什么只打最后一个 tool_use？
 * Anthropic prefix cache 是前缀包含关系（不是并列累加）：
 * 打在最后一个 tool_use block 上已经能覆盖前面所有 tool_use 的前缀，
 * 厂商侧会按完整前缀命中缓存。重复打前面的 tool_use 是浪费且会创建重复段。
 */
function addCacheControlToLastToolUseBlock(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const arr = content as any[];
  // 找最后一个 tool_use block
  let idx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.type === "tool_use" && !arr[i]?.cache_control) { idx = i; break; }
  }
  if (idx === -1) return content;
  return arr.map((b: any, i: number) =>
    i === idx ? { ...b, cache_control: { type: "ephemeral" } } : b
  );
}

/**
 * 把 cache_control 加到最后一个 tool_result block 上
 * 适用于 Anthropic 模式的"末尾工具反馈"断点（大段 tool_result 内容如读文件返回的文档）
 * 关键：cache_control 直接打在 tool_result 块上，覆盖整个文件内容
 */
function addCacheControlToLastToolResultBlock(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const arr = content as any[];
  // 找最后一个没有 cache_control 的 tool_result block
  let idx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.type === "tool_result" && !arr[i]?.cache_control) { idx = i; break; }
  }
  if (idx === -1) return content;
  return arr.map((b: any, i: number) =>
    i === idx ? { ...b, cache_control: { type: "ephemeral" } } : b
  );
}

// ─── 注入入口 ───

export interface InjectResult {
  body: Record<string, unknown>;
  markers: number;
  tokens: number;
  messageIndexes: number[];
}

/**
 * 探测 body 是否是 OpenAI 风格（messages[0]=system 且 body.system 不存在）
 * 仅返回下标偏移量，不修改 body
 */
function detectSystemOffset(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages as any[] : [];
  if (messages.length === 0) return 0;
  if (messages[0].role !== "system") return 0;
  if (body.system) return 0;
  return 1;
}

export function injectCacheControl(
  body: Record<string, unknown>,
  config?: Partial<InjectConfig>,
  normalizer?: any,
  apiFormat: "anthropic" | "openai" = "openai",
): InjectResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state: InjectState = { markers: 0, records: [] };

  // 不修改 body，仅在 messages 阶段跳过第一条 system（OpenAI 风格把 system 当 messages[0]）
  // → 避免 system 段被 messages 阶段重复打 cache_control，同时不破坏原始请求体
  const systemOffset = detectSystemOffset(body);

  // 两阶段注入：system 先消耗配额，messages 用剩余配额
  const withSystem = injectSystemCache(body, state, cfg, normalizer);
  // Anthropic 模式：messages 末尾优先选 tool_use 块（在 assistant 消息的 tool_use block 上打 cache_control）
  // OpenAI 模式：messages 末尾优先选 user/tool 整条消息
  const withMessages = apiFormat === "anthropic"
    ? injectMessagesCacheAnthropic(withSystem, state, cfg, normalizer)
    : injectMessagesCache(withSystem, state, cfg, normalizer);

  // 厂商 prefix cache 是包含关系（不是并列累加）：
  // - 同一个 messages 阶段打了多个 cache_control 时，厂商内部按最长前缀建一个连续段
  // - system 段和 messages 段是独立的
  // 正确口径：system 取其独立 tokens；messages 阶段取所有 record 的最大 prefixTokens
  // 这样日志不会夸大缓存 token 数，避免成本核算失真
  const messagesPrefixTokens = state.records
    .filter((r) => r.target.startsWith("messages["))
    .reduce((max, r) => Math.max(max, r.prefixTokens ?? 0), 0);
  // 当 system 阶段处理的是 messages[0]=system（OpenAI 风格）时，r.target="messages[0]" 且 r.role="system"
  // 这种情况下它已经被 messages 段的前缀覆盖，不应再独立累加
  // 当 system 阶段处理的是 body.system 字段（Anthropic 风格）时，r.target="system[...]"，与 messages 段独立
  const hasOpenAIStyleSystem = state.records.some((r) => r.role === "system" && r.target.startsWith("messages["));
  const systemTokens = hasOpenAIStyleSystem
    ? 0
    : state.records
        .filter((r) => r.target.startsWith("system"))
        .reduce((sum, r) => sum + (r.tokens ?? 0), 0);
  const totalTokens = systemTokens + messagesPrefixTokens;
  const messageIndexes = state.records
    .map((r) => {
      const match = r.target.match(/^messages\[(\d+)\]$/);
      if (!match) return null;
      const raw = parseInt(match[1], 10);
      // system 阶段如果处理的是 messages[0]=system（OpenAI 风格），原始下标就是 0
      if (r.role === "system" && raw === 0) return 0;
      return raw + systemOffset;
    })
    .filter((v): v is number => v !== null);

  if (cfg.debug && state.markers > 0) {
    logger.info(`[CacheInject] ${state.markers} markers, ~${totalTokens} cached tokens (format=${apiFormat})`);
    logger.info(`[CacheInject] Details: ${JSON.stringify(state.records)}`);
  }

  // 诊断日志：markers=0 且有 messages 时，输出原因
  if (state.markers === 0) {
    const messages = Array.isArray(body.messages) ? body.messages as any[] : [];
    if (messages.length > 0) {
      // 计算总 token 数和前缀稳定性
      let totalTokens = 0;
      let prefixIsStable = true;
      for (const msg of messages) {
        const msgTokens = estimateTokens(extractText(msg.content));
        totalTokens += msgTokens;
        if (prefixIsStable && !isStableMessage(msg, normalizer)) {
          prefixIsStable = false;
        }
      }

      if (totalTokens < cfg.minCacheTokens) {
        logger.warn(`[CacheInject] No markers: total tokens (${totalTokens}) < minCacheTokens (${cfg.minCacheTokens})`);
      } else if (!prefixIsStable) {
        logger.warn(`[CacheInject] No markers: prefix is unstable (dynamic content detected)`);
      } else {
        logger.warn(`[CacheInject] No markers: unknown reason (tokens=${totalTokens}, stable=${prefixIsStable})`);
      }
    }
  }

  return { body: withMessages, markers: state.markers, tokens: totalTokens, messageIndexes };
}
