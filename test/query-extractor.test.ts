import { describe, it, expect } from "vitest";
import {
  extractOriginalQuery,
  extractLatestQuery,
  hasToolCalls,
  isAgentConversation,
  extractSystemPrompt,
  hashSystemPrompt,
} from "../src/core/query-extractor.js";
import type { Message } from "../src/core/types.js";

describe("query-extractor", () => {
  describe("extractOriginalQuery", () => {
    it("简单对话：返回第一条 user 消息", () => {
      const messages: Message[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "北京天气怎么样？" },
      ];
      expect(extractOriginalQuery(messages)).toBe("北京天气怎么样？");
    });

    it("Agent 对话：返回第一条 user 消息（跳过 tool result）", () => {
      const messages: Message[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "北京天气怎么样？" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{}' } }] },
        { role: "tool", tool_call_id: "c1", content: '{"temp":25}' },
        { role: "assistant", content: "北京今天25度" },
      ];
      expect(extractOriginalQuery(messages)).toBe("北京天气怎么样？");
    });

    it("无 user 消息：返回 null", () => {
      const messages: Message[] = [
        { role: "system", content: "You are helpful" },
        { role: "assistant", content: "Hi" },
      ];
      expect(extractOriginalQuery(messages)).toBeNull();
    });
  });

  describe("extractLatestQuery", () => {
    it("多轮对话：返回最后一条 user 消息", () => {
      const messages: Message[] = [
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: "第一轮回答" },
        { role: "user", content: "追问" },
      ];
      expect(extractLatestQuery(messages)).toBe("追问");
    });
  });

  describe("hasToolCalls", () => {
    it("有工具调用：返回 true", () => {
      const messages: Message[] = [
        { role: "user", content: "查天气" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{}' } }] },
      ];
      expect(hasToolCalls(messages)).toBe(true);
    });

    it("无工具调用：返回 false", () => {
      const messages: Message[] = [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好！" },
      ];
      expect(hasToolCalls(messages)).toBe(false);
    });
  });

  describe("isAgentConversation", () => {
    it("Agent 多步对话：返回 true", () => {
      const messages: Message[] = [
        { role: "user", content: "查天气" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{}' } }] },
        { role: "tool", tool_call_id: "c1", content: '{"temp":25}' },
        { role: "assistant", content: "25度" },
      ];
      expect(isAgentConversation(messages)).toBe(true);
    });

    it("普通对话：返回 false", () => {
      const messages: Message[] = [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好！" },
      ];
      expect(isAgentConversation(messages)).toBe(false);
    });

    it("只有 tool_calls 没有 tool result：返回 false", () => {
      const messages: Message[] = [
        { role: "user", content: "查天气" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{}' } }] },
      ];
      expect(isAgentConversation(messages)).toBe(false);
    });
  });

  describe("extractSystemPrompt", () => {
    it("提取 system prompt", () => {
      const messages: Message[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hello" },
      ];
      expect(extractSystemPrompt(messages)).toBe("You are a helpful assistant.");
    });

    it("多个 system 消息：合并", () => {
      const messages: Message[] = [
        { role: "system", content: "Rule 1" },
        { role: "system", content: "Rule 2" },
        { role: "user", content: "hello" },
      ];
      expect(extractSystemPrompt(messages)).toBe("Rule 1\nRule 2");
    });

    it("无 system 消息：返回 null", () => {
      const messages: Message[] = [
        { role: "user", content: "hello" },
      ];
      expect(extractSystemPrompt(messages)).toBeNull();
    });
  });

  describe("hashSystemPrompt", () => {
    it("相同 prompt → 相同 hash", () => {
      const messages: Message[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
      ];
      const hash1 = hashSystemPrompt(messages);
      const hash2 = hashSystemPrompt([...messages]);
      expect(hash1).toBe(hash2);
    });

    it("不同 prompt → 不同 hash", () => {
      const messages1: Message[] = [{ role: "system", content: "Rule A" }];
      const messages2: Message[] = [{ role: "system", content: "Rule B" }];
      expect(hashSystemPrompt(messages1)).not.toBe(hashSystemPrompt(messages2));
    });

    it("无 system → null", () => {
      const messages: Message[] = [{ role: "user", content: "hello" }];
      expect(hashSystemPrompt(messages)).toBeNull();
    });
  });
});
