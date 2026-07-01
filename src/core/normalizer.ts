import type { Message, ContentPart, NormalizationMode } from "./types.js";
import { logger } from "../utils/logger.js";

interface NormalizeConfig {
  reorderRoles: boolean;
  stripTimestamps: boolean;
}

const defaultConfig: NormalizeConfig = {
  reorderRoles: true,
  stripTimestamps: true,
};

/**
 * Prompt 标准化器 — 提升 L1 缓存命中率
 *
 * 1. role 重排：system 消息提到最前，保证前缀稳定
 * 2. 去除时间戳：剥离常见动态字段
 *
 * 支持 content 为：
 * - string: 直接处理
 * - ContentPart[]: 只处理 type=text 的部分
 * - null: 原样返回（assistant 的 tool_calls-only 消息）
 */
export class PromptNormalizer {
  private config: NormalizeConfig;

  /**
   * 快速预检查：检测文本是否可能包含任何动态特征
   * 命中 → 走完整清理流程；未命中 → 直接短路返回原文本
   *
   * 设计：一条小而快的正则，覆盖 cleanText 里所有规则的"特征前缀"
   * - 日期/时间戳：4 位数字 + 分隔符
   * - UUID/长 hex：8+ hex（带连字符 UUID）或 32+ 纯 hex（MD5/SHA）
   * - 键值对 id：_id= / trace_id 等
   * - 内存地址/颜色：0x... / #hex
   * - 耗时/大小/百分比/版本号：数字 + 单位字母
   * - PID/port：pid/:\d
   *
   * 注意：i 标志覆盖大写（0X / PID 等），不需要 g 标志（只判断有无）
   */
  private static FAST_CHECK = /\d{4}[-/]|[0-9a-f]{8}-|[0-9a-f]{32}|_id[=:]|0x[0-9a-f]|#[0-9a-f]{3}|:\d{4}|\b\d+(\.\d+)?\s*[a-z%]|pid|\b\d{1,3}\.\d{1,3}\./i;

  constructor(config?: Partial<NormalizeConfig>) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * 规范化 messages
   * @param mode "active" = 显式缓存模式；"implicit" = 隐式缓存模式；"none" = 不清理内容
   * @param normalization "safe" = 生产默认，尽量不改变语义；"aggressive" = 缓存优先
   * 注意：mode 是必传参数，不依赖实例状态，避免 race condition
   */
  normalize(messages: Message[], mode: "active" | "implicit" | "none" = "active", normalization: NormalizationMode = "safe"): Message[] {
    // none 模式：不清理任何动态字段，但做 system 重排以稳定前缀
    // 仅调整 messages 顺序（system 提到最前），消息内容一字不改
    // 收益：让厂商 prefix cache 更易命中（system 通常跨请求稳定）
    if (mode === "none") {
      const result = [...messages];
      return this.config.reorderRoles ? this.reorderRoles(result) : result;
    }

    let result = [...messages];

    if (this.config.reorderRoles) {
      result = this.reorderRoles(result);
    }

    if (this.config.stripTimestamps) {
      result = this.stripDynamicFields(result, mode, normalization);
    }

    return result;
  }

  /**
   * 将 system 消息移到最前面，确保前缀稳定
   */
  private reorderRoles(messages: Message[]): Message[] {
    const system = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    return [...system, ...rest];
  }

  /**
   * 分层清理策略：
   * - active + safe：所有消息保守清理（生产默认，保护 system/assistant/tool 中的事实数据）
   * - active + aggressive：普通 user 保守；system/assistant/tool_result 激进（编码智能体缓存优先）
   * - implicit：普通 user 保守；system/assistant/tool_result 激进（依赖厂商 prefix cache）
   * - none：不清理（在 normalize 入口已短路）
   */
  private stripDynamicFields(messages: Message[], mode: "active" | "implicit", normalization: NormalizationMode): Message[] {
    return messages.map((m) => {
      const isToolResult = this.hasToolResult(m.content);
      const aggressive = mode === "implicit" || normalization === "aggressive";
      const conservative = !aggressive || (m.role === "user" && !isToolResult);
      return {
        ...m,
        content: this.cleanContent(m.content, conservative),
      };
    });
  }

  private hasToolResult(content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    return content.some((part: any) => part?.type === "tool_result");
  }

  /**
   * 清理 content 中的动态字段
   * 支持 string、ContentPart[]、null 三种格式
   * @param conservative true=保守清理（只清理时间戳/UUID/长ID等绝对动态值）；
   *                     false=激进清理（额外清理 IP/PID/端口等可能误伤业务数据的值）
   */
  cleanContent(content: string | ContentPart[] | null, conservative: boolean = true): string | ContentPart[] | null {
    // null: assistant 的 tool_calls-only 消息，无需处理
    if (content === null || content === undefined) {
      return content;
    }

    // string: 直接做文本清理
    if (typeof content === "string") {
      return this.cleanText(this.normalizeStableText(content, !conservative), conservative);
    }

    // ContentPart[]: 清理 text；tool_result 的 content 若为字符串也清理
    if (Array.isArray(content)) {
      return content.map((part) => {
        const anyPart = part as any;
        if (anyPart.type === "text" && anyPart.text) {
          return { ...part, text: this.cleanText(this.normalizeStableText(anyPart.text, !conservative), conservative) };
        }
        if (anyPart.type === "tool_result" && typeof anyPart.content === "string") {
          return { ...part, content: this.cleanText(this.normalizeStableText(anyPart.content, !conservative), conservative) };
        }
        // image_url / input_audio 等非文本部分原样保留
        return part;
      });
    }

    // 其他未知格式，原样返回
    return content;
  }

  /**
   * 清理上游 API 不支持的内容类型
   * 将 ContentPart[] 中的非文本部分移除，只保留纯文本
   * 用于 DeepSeek 等不支持多模态的 API
   */
  sanitizeForUpstream(messages: Message[]): Message[] {
    let stripped = 0;
    const result = messages.map((m) => {
      if (Array.isArray(m.content)) {
        const textOnly = m.content.filter((p) => p.type === "text");
        if (textOnly.length < m.content.length) {
          stripped += m.content.length - textOnly.length;
        }
        // 如果过滤后没有内容，保留一个空文本
        if (textOnly.length === 0) {
          return { ...m, content: "" };
        }
        // 如果只有一个 text 部分，直接用字符串
        if (textOnly.length === 1 && textOnly[0].text !== undefined) {
          return { ...m, content: textOnly[0].text };
        }
        return { ...m, content: textOnly };
      }
      return m;
    });

    if (stripped > 0) {
      logger.info(`[Normalizer] Stripped ${stripped} non-text content parts (image_url/input_audio)`);
    }

    return result;
  }

  /**
   * 稳定化文本表示：Unicode NFC +（仅 aggressive 模式下）空白折叠
   * NFC 是无损且等幂的；空白折叠只在缓存优先场景启用，避免破坏生产语义。
   */
  private normalizeStableText(text: string, foldWhitespace: boolean): string {
    const nfc = text.normalize("NFC");
    if (!foldWhitespace) return nfc;
    if (/\n/.test(nfc) && /[{};]|\b(function|const|let|var|class|import|export)\b|=>/.test(nfc)) {
      return nfc;
    }
    return nfc.replace(/\s+/g, " ").trim();
  }

  /**
   * 清理文本中的动态内容
   * @param conservative true=保守（只清理时间戳/UUID/长ID等绝对动态值）；
   *                     false=激进（额外清理 IP/PID/端口/百分比等，仅 implicit 模式的非 user 消息使用）
   */
  private cleanText(text: string, conservative: boolean = true): string {
    // 性能短路：文本不含任何动态特征时直接返回，跳过 20+ 条正则
    // 对纯中文、纯代码注释、纯 markdown 文本能跳过 60%+ 的处理
    if (!PromptNormalizer.FAST_CHECK.test(text)) return text;

    let result = text;

    // 所有消息都清理：ISO 时间戳（最明确的动态内容）
    result = result.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]?\d{1,2}:\d{2}:\d{2}(\.\d+)?Z?/g, "[TIMESTAMP]");

    // 所有消息都清理：UUID
    result = result.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[UUID]");

    // 所有消息都清理：纯日期（避免每次请求的日期漂移影响前缀）
    result = result.replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, "[DATE]");

    // 所有消息都清理：request_id / session_id / trace_id 等键值对
    // 必须在长 ID 兜底规则之前执行：否则键值对的值会先被长 ID 规则吃掉，
    // 导致这里只能匹配到"键="而后面的值已变成 [ID]，信息丢失且键名也被破坏
    result = result.replace(/\b(request|session|trace|correlation|conversation)[_-]?id[=:]\s*[^\s,;}"'\]]+/gi, "$1_id=[ID]");

    // 所有消息都清理：长 hex ID（MD5=32 / SHA1=40 / SHA256=64，避免 session/request/hash 漂移）
    // 兜底规则：放在所有具体格式（时间戳/UUID/日期/键值对）之后，避免误伤有上下文的值
    // 注意：只匹配纯 hex，不匹配 base64/JWT/API key（这些含 [A-Za-z_-] 且语义需要保留）
    // —— 如果上游真的漂移 base64 类 ID，应通过上面的键值对规则（xxx_id=...）捕获
    result = result.replace(/\b[0-9a-f]{32,}\b/gi, "[ID]");

    // 激进清理（仅 implicit 模式下的 system/assistant/user tool_result）
    // active 模式有主动缓存断点兜底，不需要这些可能误伤业务数据的清理
    // ——以下规则原属系统消息激进清理——
    if (!conservative) {
      // Git SHA
      result = result.replace(/\b[a-f0-9]{40}\b/gi, "[GIT_SHA]");

      // Docker digest
      result = result.replace(/\bsha256:[a-f0-9]{64}\b/gi, "[DIGEST]");

      // 执行时间: "executed in 1.23s"
      result = result.replace(/\bexecuted in\s+\d+\.?\d*s/gi, "[DURATION]");

      // PID / 进程号: "PID 12345", "pid=1234", "process 5678"
      result = result.replace(/\b(pid|process|pgid|ppid|sid|tid)[_\s=:]*\d{1,7}\b/gi, "$1=[PID]");

      // 内存地址: 0x7f8a1234, 0xDEADBEEF
      result = result.replace(/\b0x[0-9a-fA-F]{4,}\b/g, "[ADDR]");

      // IPv4 地址（带可选端口）
      result = result.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, "[IP]");

      // 数据大小: 1024B / 4KB / 16MB / 2GB
      result = result.replace(/\b\d+(?:\.\d+)?\s*(?:B|K|KB|M|MB|G|GB|T|TB)\b/g, "[SIZE]");

      // 耗时: 1.5s / 200ms / 30s / 5min
      result = result.replace(
        /\b\d+(?:\.\d+)?\s*(?:ns|us|μs|ms|s|sec|secs|seconds?|minutes?|mins?|hours?|hrs?)\b/gi,
        "[DURATION]"
      );

      // 端口号: :8080, :30000
      result = result.replace(/:\d{4,5}\b/g, ":[PORT]");

      // 百分比: 95%, 12.5%
      result = result.replace(/\b\d+(?:\.\d+)?\s*%\b/g, "[PERCENT]");

      // 速率: 100MB/s, 1.2Gbps
      result = result.replace(/\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)(?:ps|\/s)?\b/gi, "[RATE]");

      // 颜色: #fff, #aabbcc, #aabbccdd
      result = result.replace(/#[0-9a-fA-F]{3,8}\b/g, "[COLOR]");

      // 版本号: v1.2.3, 1.2.3-rc1
      result = result.replace(/\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/g, "[VERSION]");

      // token 计数：只在用量报告上下文清理（prompt_tokens: 1234 / total: 5678 tokens）
      // 避免误伤用户业务文本里讨论的 "I used 1234 tokens"
      // 支持 key 带/不带 _tokens 后缀，值带/不带 tokens 后缀
      result = result.replace(
        /\b((?:prompt|completion|total|cached|input|output)(?:_tokens?)?)\s*[:=]\s*\d+(?:\s*tokens?)?\b/gi,
        "$1=[TOKENS]"
      );
    }

    return result;
  }

  /**
   * 判断文本是否包含动态内容（用于缓存断点选择）
   * 返回 true 表示"不稳定，不能作为缓存断点"
   *
   * 设计原则：只检测 normalizer.cleanText 无法处理的动态模式
   * 不要重复检测已清理的格式（时间戳、UUID、IP 等）
   *
   * 注意：短文本（< 10 字符）返回 false，因为：
   * 1. 短文本虽然没有多少缓存价值，但也不应该破坏稳定性链
   * 2. normalizer 已经清理了所有可替换的动态值
   */
  isDynamicText(text: string): boolean {
    if (!text || text.length < 10) return false;
    return (
      // Git 命令输出（内容每次不同）
      /git\s+(status|diff|log|show)\b/i.test(text) ||
      // 日志关键词（日志内容动态变化）
      /错误日志|报错日志/i.test(text)
    );
  }
}
