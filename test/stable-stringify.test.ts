import { describe, it, expect } from "vitest";
import { stableStringify } from "../src/utils/stable-stringify.js";

describe("stableStringify", () => {
  it("相同 key 不同顺序产生相同字节", () => {
    const a = { role: "user", content: "hi" };
    const b = { content: "hi", role: "user" };
    // 原生 JSON.stringify 顺序敏感
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    // 稳定序列化后一致
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("嵌套对象深度排序", () => {
    const a = { messages: [{ role: "user", content: "hi" }], model: "gpt-4" };
    const b = { model: "gpt-4", messages: [{ content: "hi", role: "user" }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("数组顺序保持不变（messages 顺序是语义性的）", () => {
    const a = { messages: [{ role: "system", content: "1" }, { role: "user", content: "2" }] };
    const b = { messages: [{ role: "user", content: "2" }, { role: "system", content: "1" }] };
    // 数组元素顺序不能动，序列化结果应不同
    expect(stableStringify(a)).not.toBe(stableStringify(b));
    // 但数组元素内的 key 仍应排序
    const c = { messages: [{ content: "1", role: "system" }, { content: "2", role: "user" }] };
    expect(stableStringify(a)).toBe(stableStringify(c));
  });

  it("不改任何 value，只调整 key 输出顺序", () => {
    const input = { b: 1, a: { d: 2, c: [3, 2, 1] } };
    const clone = JSON.parse(JSON.stringify(input));
    const result = stableStringify(input);
    const parsed = JSON.parse(result);
    // 值完全相同
    expect(parsed).toEqual({ a: { c: [3, 2, 1], d: 2 }, b: 1 });
    expect(input).toEqual(clone);
  });

  it("字符串 NFC 归一化", () => {
    const a = stableStringify("café");
    const b = stableStringify("cafe\u0301");
    expect(a).toBe(b);
  });

  it("浮点数稳定化", () => {
    const a = stableStringify({ score: 0.1 + 0.2 });
    const b = stableStringify({ score: 0.3 });
    expect(a).toBe(b);
    expect(a).toContain("0.3");
  });

  it("原始类型原样返回", () => {
    expect(stableStringify("hello")).toBe(JSON.stringify("hello"));
    expect(stableStringify(42)).toBe(JSON.stringify(42));
    expect(stableStringify(null)).toBe(JSON.stringify(null));
    expect(stableStringify(true)).toBe(JSON.stringify(true));
  });

  it("undefined / NaN 行为与 JSON 一致", () => {
    expect(stableStringify({ a: undefined, b: NaN, c: Infinity })).toBe(JSON.stringify({ a: undefined, b: NaN, c: Infinity }));
  });

  it("空对象和空数组", () => {
    expect(stableStringify({})).toBe("{}");
    expect(stableStringify([])).toBe("[]");
  });

  it("混合嵌套结构稳定", () => {
    const body1 = {
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      model: "gpt-4o",
    };
    const body2 = {
      model: "gpt-4o",
      stream_options: { include_usage: true },
      messages: [{ content: "hi", role: "user" }],
      stream: true,
    };
    expect(stableStringify(body1)).toBe(stableStringify(body2));
  });
});
