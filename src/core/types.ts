export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;  // DeepSeek 思考模式
  [key: string]: unknown;      // 保留其他未知字段
}

export interface ContentPart {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  image_url?: { url: string; detail?: string };
  input_audio?: { data: string; format: string };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export type ApiFormat = "openai" | "anthropic";
export type CacheMode = "active" | "implicit" | "none";
export type NormalizationMode = "safe" | "aggressive";
export type ThinkingIntensity = "Minimal" | "Low" | "Medium" | "High" | "X-High" | "Max";

export interface ModelConfig {
  id: string;                      // 模型 ID
  name?: string;                   // 显示名称
  toolCalling?: boolean;           // 支持工具调用
  imageInput?: boolean;            // 支持图片输入（多模态）
  thinking?: boolean;              // 支持思考模式
  thinkingIntensity?: ThinkingIntensity[]; // 可用思考强度
  allowCloseThinking?: boolean;    // 允许关闭思考
  maxInputTokens?: number;         // 最大输入 token
  maxOutputTokens?: number;        // 最大输出 token
}

export type ModelList = (string | ModelConfig)[];

export interface UpstreamConfig {
  baseURL: string;
  apiKey: string;
  models: ModelConfig[];           // 统一为对象数组
  apiFormat: ApiFormat;
  cacheMode: CacheMode;
  /**
   * normalizer 清理强度
   * - safe：生产默认，仅清理确定动态值，尽量不改变业务语义
   * - aggressive：缓存优先，system/assistant/tool_result 激进清理
   */
  normalization: NormalizationMode;
  multimodal: boolean;             // 上游级备选（模型级优先）
  /**
   * 上游是否识别 cache_control 字段（仅当 apiFormat=anthropic 时生效）
   * - true（默认）：注入 cache_control 主动断点
   * - false：跳过 cache_control 注入（厂商 anthropic 兼容端点不识别该字段，会 400）
   *         此时 cacheMode=active 退化为 prefix-cache 模式，normalizer 仍按 active 保守清理
   */
  supportsCacheControl: boolean;
  /** 上游是否被禁用（true 时不参与路由，但仍显示在面板中） */
  disabled: boolean;
  /**
   * 同 model 多上游匹配时的优先级。数字越小越优先；缺省 100。
   * 同优先级按 upstreams.json 写入顺序。
   */
  priority: number;
}

export interface UpstreamDefinition {
  baseURL: string;
  apiKey: string;
  models: string[];
  apiFormat?: ApiFormat;
  cacheMode?: CacheMode;
  normalization?: NormalizationMode;
  supportsCacheControl?: boolean;  // 缺省视为 true（向后兼容）
  disabled?: boolean;              // 缺省 false
  priority?: number;               // 缺省 100，数字越小越优先
  [key: string]: unknown; // 允许 platform, _cache 等额外字段
}

export interface ProxyStats {
  total: number;
  cacheHit: number;
  cacheMiss: number;
  upstreamCounters: Record<string, number>;
  savedTokens: number;
}
