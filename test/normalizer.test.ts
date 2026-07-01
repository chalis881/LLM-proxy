import { describe, it, expect } from "vitest";
import { PromptNormalizer } from "../src/core/normalizer.js";

describe("normalizer", () => {
  it("active + safe：system 保守清理，IP 不被清理（生产默认）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "Server at 192.168.1.1 returned 200" },
    ], "active");
    expect(result[0].content).toContain("192.168.1.1");
    expect(result[0].content).not.toContain("[IP]");
  });

  it("稳定文本：safe 只做 NFC，aggressive 才折叠空白", () => {
    const n = new PromptNormalizer();
    const input = "cafe\u0301\n\n  says\thello";
    const safe = n.normalize([
      { role: "system", content: input },
    ], "active");
    expect(safe[0].content).toBe("café\n\n  says\thello");
    const aggressive = n.normalize([
      { role: "system", content: input },
    ], "active", "aggressive");
    const text = aggressive[0].content as string;
    expect(text).toBe("café says hello");
    expect(n.normalize([{ role: "system", content: text }], "active", "aggressive")[0].content).toBe(text);
  });

  it("active + aggressive：system 激进清理 IP（缓存优先）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "Server at 192.168.1.1 returned 200" },
    ], "active", "aggressive");
    expect(result[0].content).toContain("[IP]");
  });

  it("implicit 模式：system 激进清理 IP", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "Server at 192.168.1.1 returned 200" },
    ], "implicit");
    expect(result[0].content).toContain("[IP]");
  });

  it("active 模式：system 仍清理绝对动态值（时间戳/UUID）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "Request at 2024-01-01 10:00:00, ref 550e8400-e29b-41d4-a716-446655440000" },
    ], "active");
    // 时间戳和 UUID 是绝对动态值，即使保守模式也清理
    expect(result[0].content as string).toContain("[TIMESTAMP]");
    expect(result[0].content as string).toContain("[UUID]");
  });

  it("implicit 模式：普通 user 保持原样", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "user", content: "Server at 10.0.0.1 returned 200" },
    ], "implicit");
    expect(result[0].content).toContain("10.0.0.1");
  });

  it("implicit 模式：tool_result 激进清理", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "1",
          content: "Server 192.168.1.1 PID 12345 at 0x7f8a1234abcd, request_id=abc123, v1.2.3",
        }] as any,
      },
    ], "implicit");
    const toolResult = (result[0].content as any[])[0].content as string;
    expect(toolResult).toContain("[IP]");
    expect(toolResult).toContain("[PID]");
    expect(toolResult).toContain("[ADDR]");
    expect(toolResult).toContain("request_id=[ID]");
    expect(toolResult).toContain("[VERSION]");
  });

  it("并发安全：同一实例不同 mode 不串扰", () => {
    const n = new PromptNormalizer();
    const a = n.normalize([
      { role: "user", content: "Server at 192.168.1.1" },
    ], "active");
    const b = n.normalize([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "Server at 10.0.0.1" }] as any },
    ], "implicit");
    // active 模式 user 消息不清理
    expect(a[0].content).toContain("Server at 192.168.1.1");
    // implicit 模式 user tool_result 会清理 IP
    expect((b[0].content as any[])[0].content).toContain("[IP]");
  });

  // ─── P0：正则顺序 bug 回归测试 ───

  it("P0：键值对规则优先于长 ID 兜底（长 hex 值不破坏键名）", () => {
    const n = new PromptNormalizer();
    // 40 字符 hex 值：会被长 ID 规则吃掉，但键值对规则应先捕获
    const longHex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const result = n.normalize([
      { role: "system", content: `trace_id=${longHex} status=ok` },
    ], "active");
    const text = result[0].content as string;
    // 键名和等号必须保留，只替换值
    expect(text).toContain("trace_id=[ID]");
    expect(text).not.toContain(`trace_id=${longHex}`);
    expect(text).toContain("status=ok");
  });

  it("P0：键值对值匹配不贪婪（逗号/空格边界停止）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "trace_id=abc12345def, status=ok next=field" },
    ], "active");
    const text = result[0].content as string;
    // 值在逗号/空格处停止，不吞噬后续字段
    expect(text).toContain("trace_id=[ID]");
    expect(text).toContain("status=ok");
    expect(text).toContain("next=field");
  });

  // ─── P1：长 ID 规则收窄回归测试 ───

  it("P1：长 hex ID 仍被清理（MD5/SHA1/SHA256）", () => {
    const n = new PromptNormalizer();
    const md5 = "d41d8cd98f00b204e9800998ecf8427e"; // 32 hex
    const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; // 40 hex
    const result = n.normalize([
      { role: "system", content: `hashes: ${md5} ${sha1}` },
    ], "active");
    expect(result[0].content as string).not.toContain(md5);
    expect(result[0].content as string).not.toContain(sha1);
    expect(result[0].content as string).toContain("[ID]");
  });

  it("P1：JWT / base64 / API key 不被误伤", () => {
    const n = new PromptNormalizer();
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const apiKey = "sk-proj-abc123XYZdef456GHI789jkl012mno345pqr";
    const base64 = "c2Vzc2lvbi0xMjM0NTY3ODkwYWFhYmJiY2NjZGRkZWVlZmZm";
    const result = n.normalize([
      { role: "user", content: `My tokens: ${jwt} ${apiKey} ${base64}` },
    ], "active");
    // user 消息本就不走激进清理，但更重要的是长 ID 兜底不再误伤
    const text = result[0].content as string;
    expect(text).toContain(jwt);
    expect(text).toContain(apiKey);
    expect(text).toContain(base64);
  });

  // ─── P1：tokens 规则收窄回归测试 ───

  it("P1：implicit 模式用量报告 tokens 被清理", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "prompt_tokens: 1234 tokens, total: 5678 tokens" },
    ], "implicit");
    const text = result[0].content as string;
    expect(text).not.toContain("1234 tokens");
    expect(text).toContain("prompt_tokens=[TOKENS]");
    expect(text).toContain("total=[TOKENS]");
  });

  it("P1：active + safe 不清理 tokens（生产默认）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "prompt_tokens: 1234 tokens, total: 5678 tokens" },
    ], "active");
    expect(result[0].content as string).toContain("1234 tokens");
    expect(result[0].content as string).toContain("5678 tokens");
  });

  it("P1：active + aggressive 清理 tokens（缓存优先）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "prompt_tokens: 1234 tokens, total: 5678 tokens" },
    ], "active", "aggressive");
    expect(result[0].content as string).toContain("[TOKENS]");
  });

  it("P1：业务讨论里 tokens 不被误伤", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "I used 1234 tokens today for testing" },
    ], "active");
    // 没有 prompt/total 等上下文，应保留原文
    expect(result[0].content as string).toContain("I used 1234 tokens today");
  });

  // ─── P2：性能短路行为不变性测试 ───

  it("P2：纯中文文本短路返回，内容不变", () => {
    const n = new PromptNormalizer();
    const text = "你是一个友好的助手，请用中文回答用户的问题。";
    const result = n.normalize([
      { role: "system", content: text },
    ], "active");
    expect(result[0].content).toBe(text);
  });

  it("P2：纯代码文本短路返回，内容不变", () => {
    const n = new PromptNormalizer();
    const code = "function add(a, b) {\n  return a + b;\n}\nconst result = add(1, 2);";
    const result = n.normalize([
      { role: "system", content: code },
    ], "active");
    expect(result[0].content).toBe(code);
  });

  // ─── none 模式：跳过所有缓存优化 ───

  it("none 模式：动态字段全部保留，内容一字不改", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "system", content: "Server 192.168.1.1 PID 12345 trace_id=abc123def456 timestamp 2024-01-01 10:00:00" },
    ], "none");
    const text = result[0].content as string;
    // none 模式下所有"动态字段"都应原样保留
    expect(text).toContain("192.168.1.1");
    expect(text).toContain("PID 12345");
    expect(text).toContain("trace_id=abc123def456");
    expect(text).toContain("2024-01-01 10:00:00");
    expect(text).not.toContain("[IP]");
    expect(text).not.toContain("[ID]");
    expect(text).not.toContain("[TIMESTAMP]");
  });

  it("none 模式：system 仍被重排到最前（稳定 prefix cache）", () => {
    const n = new PromptNormalizer();
    const result = n.normalize([
      { role: "user", content: "hello" },
      { role: "system", content: "you are helpful" },
      { role: "assistant", content: "hi" },
    ], "none");
    // none 模式不做内容清理，但重排 system 到最前以稳定厂商 prefix cache
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[2].role).toBe("assistant");
    // 内容一字不改
    expect(result[0].content).toBe("you are helpful");
  });
});
