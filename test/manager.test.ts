import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UpstreamManager, UpstreamNotFoundError } from "../src/upstream/manager.js";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const testConfigPath = resolve(process.cwd(), "test-upstreams.json");

const testConfig = {
  deepseek: {
    baseURL: "https://api.deepseek.com",
    apiKey: "sk-1234567890abcdef",
    models: ["deepseek-chat"],
  },
  qwen: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-abcdefghijklmnop",
    models: ["qwen-max"],
  },
};

describe("UpstreamManager", () => {
  let mgr: UpstreamManager;

  beforeEach(() => {
    writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));
    // 设置环境变量避免依赖 .env
    process.env.DEFAULT_UPSTREAM = "deepseek";
    mgr = new UpstreamManager(testConfigPath);
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  });

  it("加载上游配置", () => {
    const list = mgr.list();
    expect(list).toHaveLength(2);
    expect(list.map((u) => u.name)).toContain("deepseek");
    expect(list.map((u) => u.name)).toContain("qwen");
  });

  it("默认上游", () => {
    expect(mgr.getDefault()).toBe("deepseek");
  });

  it("resolve 从 header 选择上游", () => {
    const upstream = mgr.resolve({ "x-upstream": "qwen" });
    expect(upstream.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("resolve 无 header 时使用默认", () => {
    const upstream = mgr.resolve({});
    expect(upstream.baseURL).toBe("https://api.deepseek.com");
  });

  it("resolve 不存在的上游抛出错误", () => {
    expect(() => mgr.resolve({ "x-upstream": "nonexistent" })).toThrow(UpstreamNotFoundError);
  });

  it("getByName", () => {
    const u = mgr.getByName("qwen");
    expect(u).toBeDefined();
    expect(u!.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(mgr.getByName("nonexistent")).toBeUndefined();
  });

  it("getFallbackNames", () => {
    const fallbacks = mgr.getFallbackNames("deepseek");
    expect(fallbacks).toContain("qwen");
    expect(fallbacks).not.toContain("deepseek");
  });

  it("API Key 脱敏", () => {
    const list = mgr.list();
    const deepseek = list.find((u) => u.name === "deepseek")!;
    // 应该被脱敏，不显示完整 key
    expect(deepseek.apiKey).not.toBe("sk-1234567890abcdef");
    expect(deepseek.apiKey).toContain("•");
    expect(deepseek.apiKey.startsWith("sk-12")).toBe(true);
  });

  it("setDefault", () => {
    mgr.setDefault("qwen");
    expect(mgr.getDefault()).toBe("qwen");
  });

  it("setDefault 不存在的上游抛出错误", () => {
    expect(() => mgr.setDefault("nonexistent")).toThrow(UpstreamNotFoundError);
  });

  it("upsert 新增", () => {
    mgr.upsert("new-api", "https://new.api.com", "sk-new", ["model-a"]);
    const u = mgr.getByName("new-api");
    expect(u).toBeDefined();
    expect(u!.baseURL).toBe("https://new.api.com");
  });

  it("remove", () => {
    mgr.remove("qwen");
    expect(mgr.getByName("qwen")).toBeUndefined();
  });

  it("remove 最后一个上游时报错", () => {
    mgr.remove("qwen");
    expect(() => mgr.remove("deepseek")).toThrow("Cannot remove the last upstream");
  });

  it("supportsCacheControl 缺省为 true（向后兼容百炼/Anthropic）", () => {
    const u = mgr.getByName("deepseek")!;
    expect(u.supportsCacheControl).toBe(true);
  });

  it("supportsCacheControl 显式 false 时被加载（anthropic 兼容端点不识别 cache_control）", () => {
    const cfg = {
      minimax: {
        baseURL: "https://api.minimaxi.com/anthropic",
        apiKey: "sk-mm",
        models: ["MiniMax-M2.7"],
        apiFormat: "anthropic",
        supportsCacheControl: false,
      },
    };
    writeFileSync(testConfigPath, JSON.stringify(cfg, null, 2));
    process.env.DEFAULT_UPSTREAM = "minimax";
    const m = new UpstreamManager(testConfigPath);
    expect(m.getByName("minimax")!.supportsCacheControl).toBe(false);
  });

  it("resolveByModel 按模型名找到上游", () => {
    const r = mgr.resolveByModel("deepseek-chat");
    expect(r?.name).toBe("deepseek");
    expect(r?.upstream.baseURL).toBe("https://api.deepseek.com");
  });

  it("resolveByModel 找不到时返回 undefined", () => {
    expect(mgr.resolveByModel("unknown-model")).toBeUndefined();
    expect(mgr.resolveByModel(undefined)).toBeUndefined();
  });

  it("disabled 上游不参与按 model 路由", () => {
    const cfg = {
      a: { baseURL: "https://a.com", apiKey: "sk-aaaa", models: ["dup-model"] },
      b: { baseURL: "https://b.com", apiKey: "sk-bbbb", models: ["dup-model"], disabled: true },
    };
    writeFileSync(testConfigPath, JSON.stringify(cfg, null, 2));
    process.env.DEFAULT_UPSTREAM = "a";
    const m = new UpstreamManager(testConfigPath);
    const r = m.resolveByModel("dup-model");
    expect(r?.name).toBe("a");
  });

  it("priority 越小越优先", () => {
    const cfg = {
      first: { baseURL: "https://first.com", apiKey: "sk-1111111111", models: ["dup"] },
      second: { baseURL: "https://second.com", apiKey: "sk-2222222222", models: ["dup"], priority: 1 },
    };
    writeFileSync(testConfigPath, JSON.stringify(cfg, null, 2));
    process.env.DEFAULT_UPSTREAM = "first";
    const m = new UpstreamManager(testConfigPath);
    const r = m.resolveByModel("dup");
    expect(r?.name).toBe("second");
  });

  it("priority 缺省 100，同优先级按文件顺序", () => {
    const r = mgr.resolveByModel("deepseek-chat");
    expect(r?.name).toBe("deepseek");
  });
});
