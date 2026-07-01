import { describe, it, expect, beforeEach } from "vitest";
import { PromptNormalizer } from "../src/core/normalizer.js";

describe("PromptNormalizer", () => {
  let normalizer: PromptNormalizer;

  beforeEach(() => {
    normalizer = new PromptNormalizer();
  });

  describe("normalize", () => {
    it("system 消息提前，其余保持顺序", () => {
      const msgs = [
        { role: "user", content: "hello" },
        { role: "system", content: "You are helpful" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "what?" },
      ];
      const result = normalizer.normalize(msgs as any);
      expect(result[0].role).toBe("system");
      expect(result[1].content).toBe("hello");
      expect(result[2].role).toBe("assistant");
      expect(result[3].content).toBe("what?");
    });

    it("剥离时间戳和 UUID", () => {
      const msgs = [
        { role: "system", content: "Current time: 2024-06-24T15:30:00.000Z" },
        { role: "user", content: "Session: 550e8400-e29b-41d4-a716-446655440000" },
      ];
      const result = normalizer.normalize(msgs as any);
      expect(result[0].content).toContain("[TIMESTAMP]");
      expect(result[1].content).toContain("[UUID]");
    });

    it("same semantic → same normalized output", () => {
      const msgs1 = [
        { role: "system", content: "Be helpful. Time: 2024-06-24T10:00:00Z" },
        { role: "user", content: "hello" },
      ];
      const msgs2 = [
        { role: "system", content: "Be helpful. Time: 2024-06-24T12:00:00Z" },
        { role: "user", content: "hello" },
      ];
      const n1 = normalizer.normalize(msgs1 as any);
      const n2 = normalizer.normalize(msgs2 as any);
      expect(JSON.stringify(n1)).toBe(JSON.stringify(n2));
    });
  });

  describe("sanitizeForUpstream", () => {
    it("多模态消息：只保留 text 部分", () => {
      const msgs = [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      }] as any;
      const result = normalizer.sanitizeForUpstream(msgs);
      expect(result[0].content).toBe("describe this");
    });

    it("纯文本消息：原样保留", () => {
      const msgs = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any;
      const result = normalizer.sanitizeForUpstream(msgs);
      expect(result).toEqual(msgs);
    });

    it("null content：原样保留", () => {
      const msgs = [
        { role: "assistant", content: null, tool_calls: [] },
      ] as any;
      const result = normalizer.sanitizeForUpstream(msgs);
      expect(result[0].content).toBeNull();
    });

    it("reasoning_content 完整保留", () => {
      const msgs = [
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "Let me think...",
        },
      ] as any;
      const result = normalizer.sanitizeForUpstream(msgs);
      expect((result[0] as any).reasoning_content).toBe("Let me think...");
    });
  });

  describe("content 格式兼容", () => {
    it("数组格式 content（多模态）不报错", () => {
      const msgs = [{
        role: "user",
        content: [
          { type: "text", text: "Time: 2024-06-24T10:00:00Z hello" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      }] as any;
      const result = normalizer.normalize(msgs);
      expect(result).toBeDefined();
      const userContent = result[0].content as any[];
      expect(userContent[0].text).toContain("[TIMESTAMP]");
      expect(userContent[1].type).toBe("image_url");
    });

    it("null content（tool_calls-only）不报错", () => {
      const msgs = [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "test" } }] },
        { role: "user", content: "hello" },
      ] as any;
      const result = normalizer.normalize(msgs);
      expect(result[0].content).toBeNull();
    });

    it("正常文本内容不变", () => {
      const msgs = [
        { role: "user", content: "How do I restart nginx?" },
      ] as any;
      const result = normalizer.normalize(msgs);
      expect(result[0].content).toBe("How do I restart nginx?");
    });
  });
});
