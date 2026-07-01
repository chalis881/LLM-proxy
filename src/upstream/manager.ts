import { readFileSync, writeFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import type { UpstreamConfig, ModelConfig, NormalizationMode } from "../core/types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export class UpstreamManager {
  private upstreams = new Map<string, UpstreamConfig>();
  private defaultName: string;
  private configPath: string;
  private meta: Record<string, unknown> = {}; // 保留 _meta 等元数据字段

  constructor(configPath?: string) {
    this.configPath = configPath || resolve(process.cwd(), "upstreams.json");
    this.defaultName = config.defaultUpstream;
    this.load();
    // 如果 upstreams.json 的 _meta 里有上次选择的默认上游，优先使用
    const saved = (this.meta["_meta"] as any)?.defaultUpstream;
    if (saved && this.upstreams.has(saved)) {
      this.defaultName = saved;
    }
  }

  private load() {
    const raw = readFileSync(this.configPath, "utf-8");
    const defs = JSON.parse(raw) as Record<string, any>;

    this.upstreams.clear();
    this.meta = {};
    for (const [name, def] of Object.entries(defs)) {
      // 保存元数据字段
      if (name.startsWith("_")) {
        this.meta[name] = def;
        continue;
      }
      const apiKey = this.resolveKey(def.apiKey);
      this.upstreams.set(name, {
        baseURL: def.baseURL.replace(/\/$/, ""),
        apiKey,
        models: normalizeModels(def.models || []),
        apiFormat: def.apiFormat || "openai",
        cacheMode: def.cacheMode || "active",
        normalization: normalizeNormalization(def.normalization),
        multimodal: def.multimodal === true,
        supportsCacheControl: def.supportsCacheControl !== false, // 缺省 true（兼容百炼/Anthropic）
        disabled: def.disabled === true,
        priority: typeof def.priority === "number" ? def.priority : 100,
      });
      logger.info(`Upstream loaded: ${name} → ${def.baseURL}`);
    }

    if (!this.upstreams.has(this.defaultName)) {
      logger.warn(`Default upstream "${this.defaultName}" not found, using first available`);
      this.defaultName = this.upstreams.keys().next().value!;
    }
  }

  private resolveKey(keyRef: string): string {
    // ${ENV_VAR} → process.env.ENV_VAR
    const match = keyRef.match(/^\$\{(.+)\}$/);
    if (match) {
      const val = process.env[match[1]];
      if (!val) {
        logger.warn(`Env var ${match[1]} not set, using placeholder`);
        return keyRef;
      }
      return val;
    }
    return keyRef;
  }

  resolve(headers: Record<string, string>): UpstreamConfig {
    const name = headers["x-upstream"] || this.defaultName;
    const upstream = this.upstreams.get(name);
    if (!upstream) {
      throw new UpstreamNotFoundError(name);
    }
    return upstream;
  }

  resolveName(headers: Record<string, string>): string {
    return headers["x-upstream"] || this.defaultName;
  }

  /**
   * 按模型名找到对应上游。
   * 多个上游包含同一模型时，返回第一个匹配。
   * 未找到时返回 undefined。
   */
  resolveByModel(model: string | undefined): { upstream: UpstreamConfig; name: string } | undefined {
    if (!model) return undefined;
    // 收集所有未禁用且包含该 model 的上游，Map 保留插入顺序
    const matches: { name: string; upstream: UpstreamConfig }[] = [];
    for (const [name, u] of this.upstreams) {
      if (u.disabled) continue;
      if (u.models.some((m) => m.id === model)) {
        matches.push({ name, upstream: u });
      }
    }
    if (matches.length === 0) {
      logger.warn(`[resolveByModel] no match for "${model}". Available: ${[...this.upstreams.entries()].map(([n, u]) => `${n}=[${u.models.map((m) => m.id).join(",")}]`).join(" ")}`);
      return undefined;
    }
    // 按 priority 升序；同 priority 保持文件写入顺序（stable sort）
    matches.sort((a, b) => a.upstream.priority - b.upstream.priority);
    return { name: matches[0].name, upstream: matches[0].upstream };
  }

  /** 按名称获取上游配置（供故障转移使用） */
  getByName(name: string): UpstreamConfig | undefined {
    return this.upstreams.get(name);
  }

  /** 获取当前上游之外的其他上游名称列表（供故障转移使用） */
  getFallbackNames(current: string): string[] {
    return Array.from(this.upstreams.keys()).filter((n) => n !== current);
  }

  setDefault(name: string) {
    if (!this.upstreams.has(name)) {
      throw new UpstreamNotFoundError(name);
    }
    this.defaultName = name;
    logger.info(`Default upstream changed to: ${name}`);
    // 持久化到 _meta，重启后保留
    this.meta["_meta"] = { ...(this.meta["_meta"] as any || {}), defaultUpstream: name };
    this.save();
  }

  getDefault(): string {
    return this.defaultName;
  }

  /** 脱敏后的列表（供前端展示） */
  list(): Array<{ name: string; baseURL: string; apiKey: string; models: ModelConfig[]; apiFormat: string; cacheMode: string; normalization: NormalizationMode; multimodal: boolean; supportsCacheControl: boolean; disabled: boolean; priority: number }> {
    return Array.from(this.upstreams.entries()).map(([name, u]) => ({
      name,
      baseURL: u.baseURL,
      apiKey: maskKey(u.apiKey),
      models: u.models,
      apiFormat: u.apiFormat,
      cacheMode: u.cacheMode,
      normalization: u.normalization,
      multimodal: u.multimodal,
      supportsCacheControl: u.supportsCacheControl,
      disabled: u.disabled,
      priority: u.priority,
    }));
  }

  /** 完整列表（内部使用） */
  listRaw(): Array<{ name: string; baseURL: string; apiKey: string; models: ModelConfig[]; apiFormat: string; cacheMode: string; normalization: NormalizationMode; multimodal: boolean; supportsCacheControl: boolean; disabled: boolean; priority: number }> {
    return Array.from(this.upstreams.entries()).map(([name, u]) => ({
      name,
      baseURL: u.baseURL,
      apiKey: u.apiKey,
      models: u.models,
      apiFormat: u.apiFormat,
      cacheMode: u.cacheMode,
      normalization: u.normalization,
      multimodal: u.multimodal,
      supportsCacheControl: u.supportsCacheControl,
      disabled: u.disabled,
      priority: u.priority,
    }));
  }

  reload() {
    this.load();
    logger.info("Upstreams reloaded");
  }

  /** 保存当前配置到 upstreams.json */
  save() {
    const data: Record<string, unknown> = { ...this.meta };
    for (const [name, u] of this.upstreams) {
      data[name] = {
        baseURL: u.baseURL,
        apiKey: u.apiKey,
        models: u.models,
        apiFormat: u.apiFormat,
        cacheMode: u.cacheMode,
        normalization: u.normalization,
        multimodal: u.multimodal,
        supportsCacheControl: u.supportsCacheControl,
        disabled: u.disabled,
        priority: u.priority,
      };
    }
    const json = JSON.stringify(data, null, 2);
    writeFileSync(this.configPath, json, "utf-8");
    logger.info("upstreams.json saved");
  }

  /** 新增/更新上游（同时写回文件） */
  upsert(name: string, baseURL: string, apiKey: string, models: (string | ModelConfig)[], apiFormat?: string, cacheMode?: string, multimodal?: boolean, supportsCacheControl: boolean = true, normalization?: string, disabled: boolean = false, priority: number = 100) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Name cannot be empty");
    if (!baseURL.trim()) throw new Error("baseURL cannot be empty");

    this.upstreams.set(cleanName, {
      baseURL: baseURL.trim().replace(/\/$/, ""),
      apiKey: apiKey.trim(),
      models: normalizeModels(models),
      apiFormat: (apiFormat || "openai") as any,
      cacheMode: (cacheMode || "active") as any,
      normalization: normalizeNormalization(normalization),
      multimodal: multimodal === true,
      supportsCacheControl,
      disabled,
      priority,
    });
    this.save();
    logger.info(`Upstream upserted: ${cleanName}`);
  }

  /** 删除上游 */
  remove(name: string) {
    if (!this.upstreams.has(name)) {
      throw new UpstreamNotFoundError(name);
    }
    if (this.upstreams.size <= 1) {
      throw new Error("Cannot remove the last upstream");
    }
    this.upstreams.delete(name);
    if (this.defaultName === name) {
      this.defaultName = this.upstreams.keys().next().value!;
      logger.info(`Default switched to: ${this.defaultName}`);
    }
    this.save();
    logger.info(`Upstream removed: ${name}`);
  }

  watch() {
    watchFile(this.configPath, { interval: 2000 }, () => {
      logger.info("upstreams.json changed, reloading...");
      try {
        this.load();
      } catch (e) {
        logger.error("Failed to reload upstreams", e);
      }
    });
  }
}

export class UpstreamNotFoundError extends Error {
  constructor(name: string) {
    super(`Upstream "${name}" not found`);
    this.name = "UpstreamNotFoundError";
  }
}

/** 将旧格式（字符串数组）和新格式（对象数组）统一为 ModelConfig[] */
function normalizeModels(models: any[]): ModelConfig[] {
  return models.map((m: any) => {
    if (typeof m === "string") return { id: m };
    return { id: m.id, name: m.name, toolCalling: m.toolCalling, imageInput: m.imageInput, thinking: m.thinking, thinkingIntensity: m.thinkingIntensity, allowCloseThinking: m.allowCloseThinking, maxInputTokens: m.maxInputTokens, maxOutputTokens: m.maxOutputTokens };
  });
}

function normalizeNormalization(value: unknown): NormalizationMode {
  return value === "aggressive" ? "aggressive" : "safe";
}

function maskKey(key: string): string {
  if (!key || key.length < 10) return key || "(未设置)";
  // 保留前 5 位和后 4 位，中间用 • 遮盖
  return key.slice(0, 5) + "••••••••" + key.slice(-4);
}
