import type { Message, ContentPart } from "./types.js";

/**
 * 从 Agent 对话中提取用户原始问题
 *
 * Agent 场景下，messages 结构通常是：
 *   [system, user, assistant(tool_call), tool(result), assistant(tool_call), tool(result), user(追问)]
 *
 * L2 语义缓存应该基于用户的原始问题做匹配，
 * 而不是包含 tool result 的完整 prompt（那样每次都不同）。
 *
 * 策略：
 * 1. 取第一条 user 消息作为原始问题
 * 2. 如果有多条 user 消息，取最后一条（可能是追问/修正）
 * 3. 跳过包含 tool 结果上下文的 assistant 消息
 */

/**
 * 从 content 中提取纯文本
 * - string → 直接返回
 * - ContentPart[] → 拼接所有 text 部分
 * - null → 返回 null
 */
export function extractText(content: string | ContentPart[] | null): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/**
 * 提取用户原始问题（第一条 user 消息）
 * 这是最稳定的语义缓存 key
 */
export function extractOriginalQuery(messages: Message[]): string | null {
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) return text;
    }
  }
  return null;
}

/**
 * 提取最新用户问题（最后一条 user 消息）
 * 适用于多轮追问场景
 */
export function extractLatestQuery(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const text = extractText(messages[i].content);
      if (text) return text;
    }
  }
  return null;
}

/**
 * 判断 messages 是否包含工具调用
 * 用于决定是否启用工具缓存逻辑
 */
export function hasToolCalls(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
}

/**
 * 判断是否是 Agent 多步对话
 * 条件：有 tool 角色的消息 + 有多条 assistant 消息
 */
export function isAgentConversation(messages: Message[]): boolean {
  const toolMessages = messages.filter((m) => m.role === "tool");
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  return toolMessages.length > 0 && assistantMessages.length > 1;
}

/**
 * 提取对话中的 system prompt（用于前缀缓存提示）
 */
export function extractSystemPrompt(messages: Message[]): string | null {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return null;
  return systemMsgs
    .map((m) => extractText(m.content) || "")
    .filter(Boolean)
    .join("\n");
}

/**
 * 计算 system prompt 的哈希（用于前缀缓存追踪）
 */
export function hashSystemPrompt(messages: Message[]): string | null {
  const prompt = extractSystemPrompt(messages);
  if (!prompt) return null;
  // 简单哈希，用于 header 标识
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `sp-${Math.abs(hash).toString(36)}`;
}
