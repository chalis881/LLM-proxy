import { describe, it, expect } from "vitest";
import { extractUsageFields, extractUsageFromSSE, ensureAnthropicMaxTokens } from "../src/routes/proxy.js";

describe("ensureAnthropicMaxTokens", () => {
  it("anthropic 缺省 max_tokens 时注入 8192", () => {
    const body: any = { messages: [] };
    ensureAnthropicMaxTokens(body, "anthropic");
    expect(body.max_tokens).toBe(8192);
  });

  it("anthropic max_tokens=0 注入 8192", () => {
    const body: any = { max_tokens: 0 };
    ensureAnthropicMaxTokens(body, "anthropic");
    expect(body.max_tokens).toBe(8192);
  });

  it("anthropic 负数 / NaN / Infinity 注入 8192", () => {
    [-1, NaN, Infinity, -Infinity].forEach((bad) => {
      const body: any = { max_tokens: bad };
      ensureAnthropicMaxTokens(body, "anthropic");
      expect(body.max_tokens).toBe(8192);
    });
  });

  it("anthropic 已传合法正整数不改动", () => {
    const body: any = { max_tokens: 4096 };
    ensureAnthropicMaxTokens(body, "anthropic");
    expect(body.max_tokens).toBe(4096);
  });

  it("openai 格式不强制注入", () => {
    const body: any = { messages: [] };
    ensureAnthropicMaxTokens(body, "openai");
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("usage extraction", () => {
  it("OpenAI: prompt_tokens 已包含缓存 token，input 不重复累加", () => {
    const usage = extractUsageFields({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    });
    expect(usage).toEqual({ input: 1000, output: 200, cacheHit: 800, cacheMiss: 200 });
  });

  it("Anthropic: input_tokens 不含 cache_read/cache_creation，需要归一为输入总量", () => {
    const usage = extractUsageFields({
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 200,
    });
    expect(usage).toEqual({ input: 3250, output: 20, cacheHit: 3000, cacheMiss: 200 });
    expect((usage.cacheHit / usage.input) * 100).toBeLessThanOrEqual(100);
  });

  it("Anthropic SSE: 合并 message_start 和 message_delta usage 并归一 input", () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":3000,"cache_creation_input_tokens":200}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"output_tokens":20}}',
      "",
    ].join("\n");
    const usage = extractUsageFromSSE(sse);
    expect(usage).toEqual({ input: 3250, output: 20, cacheHit: 3000, cacheMiss: 200 });
  });

  it("百炼 OpenAI 兼容: input_tokens 已含 cached_tokens，不重复累加", () => {
    // 真实日志样例：input_tokens(25750) = cached(21995) + creation(3749) + 未缓存(6)
    // 缓存字段位于 prompt_tokens_details 嵌套，不是顶层 → 判定为 OpenAI 家族，input 不加回
    const usage = extractUsageFields({
      input_tokens: 25750,
      output_tokens: 84,
      total_tokens: 25834,
      prompt_tokens_details: {
        cached_tokens: 21995,
        cache_creation_input_tokens: 3749,
      },
    });
    expect(usage.input).toBe(25750);
    expect(usage.cacheHit).toBe(21995);
    expect(usage.cacheMiss).toBe(3749);
    // 覆盖率应 ≈85.4%，而非被污染的 42.7%
    expect((usage.cacheHit / usage.input) * 100).toBeCloseTo(85.4, 1);
  });

  it("百炼 Anthropic 兼容: 字段名同 input_tokens 但已含缓存，不重复累加", () => {
    // 百炼 /apps/anthropic 端点与原生 Anthropic 字段名相同、语义相反
    // 仅当缓存字段出现在顶层 cache_read_input_tokens / cache_creation_input_tokens 才加回
    const usage = extractUsageFields({
      input_tokens: 25750,
      output_tokens: 84,
      prompt_tokens_details: {
        cached_tokens: 21995,
        cache_creation_input_tokens: 3749,
      },
    });
    expect(usage.input).toBe(25750);
    expect(usage.cacheHit).toBe(21995);
    expect(usage.cacheMiss).toBe(3749);
  });
});
