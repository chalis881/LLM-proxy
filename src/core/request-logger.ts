import { logger } from "../utils/logger.js";

export interface RequestLogEntry {
  timestamp: number;
  upstream: string;
  model: string;
  path: string;
  stream: boolean;
  // 厂商缓存
  vendorCacheHitTokens: number;
  vendorCacheMissTokens: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  // 主动缓存断点：消息索引数组（哪几条消息被打了 cache_control）
  cachePoints: number[];
  // 相邻断点 messages 索引跨度，用于诊断滑动窗口是否过疏
  cachePointGaps: number[];
  // 本轮缓存覆盖率：hit / (hit + miss)
  cacheCoverage: number;
  // 命中 token 较同上游同模型上一条主动缓存记录下降超过 40%
  cacheCliff: boolean;
  // 费用
  estimatedCost: number;
  savedByCache: number;
}

/**
 * 各厂商模型每百万 token 价格（元）
 */
const PRICING: Record<string, { input: number; output: number; cacheHit: number }> = {
  // DeepSeek
  "deepseek-v4-flash":    { input: 1.0,   output: 2.0,  cacheHit: 0.02 },
  "deepseek-v4-pro":      { input: 3.0,   output: 6.0,  cacheHit: 0.025 },
  "deepseek-chat":        { input: 1.0,   output: 2.0,  cacheHit: 0.02 },
  "deepseek-reasoner":    { input: 4.0,   output: 16.0, cacheHit: 1.0 },
  // MiniMax
  "minimax-m3":           { input: 2.1,   output: 8.4,  cacheHit: 0.42 },
  "minimax-m2.7":         { input: 2.1,   output: 8.4,  cacheHit: 0.42 },
  // 智谱
  "glm-4":                { input: 7.14,  output: 7.14, cacheHit: 0 },
  "glm-4-flash":          { input: 0.07,  output: 0.07, cacheHit: 0 },
  "glm-5.2":              { input: 2.0,   output: 8.0,  cacheHit: 0 },
  // OpenAI
  "gpt-4o":               { input: 2.5,   output: 10.0, cacheHit: 1.25 },
  "gpt-4o-mini":          { input: 0.15,  output: 0.6,  cacheHit: 0.075 },
};

const DEFAULT_PRICING = { input: 2.0, output: 8.0, cacheHit: 0 };

function getPricing(model: string) {
  return PRICING[model] || DEFAULT_PRICING;
}

function calcCost(model: string, inputTokens: number, outputTokens: number, cacheHit: number, cacheMiss: number): { cost: number; saved: number } {
  const p = getPricing(model);
  const fullCost = inputTokens * p.input / 1_000_000 + outputTokens * p.output / 1_000_000;
  const actualCost = cacheMiss * p.input / 1_000_000
    + cacheHit * p.cacheHit / 1_000_000
    + outputTokens * p.output / 1_000_000;
  return { cost: actualCost, saved: Math.max(0, fullCost - actualCost) };
}

export class RequestLogger {
  private logs: RequestLogEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
  }

  log(entry: Omit<RequestLogEntry, "estimatedCost" | "savedByCache" | "cachePoints" | "cachePointGaps" | "cacheCoverage" | "cacheCliff"> & { cachePoints?: number[] }) {
    const { cost, saved } = calcCost(
      entry.model, entry.promptTokens, entry.completionTokens,
      entry.vendorCacheHitTokens, entry.vendorCacheMissTokens,
    );

    const cachePoints = entry.cachePoints || [];
    const cachePointGaps = cachePoints.slice(1).map((point, i) => point - cachePoints[i]);
    const cacheTotal = entry.vendorCacheHitTokens + entry.vendorCacheMissTokens;
    const cacheCoverage = cacheTotal > 0 ? entry.vendorCacheHitTokens / cacheTotal : 0;
    const prevActive = [...this.logs].reverse().find((log) =>
      log.upstream === entry.upstream
      && log.model === entry.model
      && log.cachePoints.length > 0
      && log.vendorCacheHitTokens > 0
    );
    const cacheCliff = !!prevActive
      && entry.vendorCacheHitTokens > 0
      && entry.vendorCacheHitTokens < prevActive.vendorCacheHitTokens * 0.6;

    const fullEntry: RequestLogEntry = {
      ...entry,
      cachePoints,
      cachePointGaps,
      cacheCoverage,
      cacheCliff,
      estimatedCost: cost,
      savedByCache: saved,
    };
    this.logs.push(fullEntry);

    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-Math.floor(this.maxEntries * 0.8));
    }

    if (entry.vendorCacheHitTokens > 0) {
      logger.debug(`[Vendor Cache] Saved ¥${saved.toFixed(4)} (${entry.vendorCacheHitTokens} tokens cached)`);
    }
  }

  getStats() {
    let totalRequests = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheHitTokens = 0;
    let totalCacheMissTokens = 0;
    let totalSaved = 0;
    let totalCost = 0;
    let totalLatency = 0;

    const byUpstream: Record<string, { requests: number; hits: number; saved: number }> = {};

    for (const entry of this.logs) {
      totalRequests++;
      totalPromptTokens += entry.promptTokens;
      totalCompletionTokens += entry.completionTokens;
      totalCacheHitTokens += entry.vendorCacheHitTokens;
      totalCacheMissTokens += entry.vendorCacheMissTokens;
      totalSaved += entry.savedByCache;
      totalCost += entry.estimatedCost;
      totalLatency += entry.latencyMs;

      if (!byUpstream[entry.upstream]) {
        byUpstream[entry.upstream] = { requests: 0, hits: 0, saved: 0 };
      }
      byUpstream[entry.upstream].requests++;
      if (entry.vendorCacheHitTokens > 0) byUpstream[entry.upstream].hits++;
      byUpstream[entry.upstream].saved += entry.savedByCache;
    }

    const cacheHitRateBase = totalPromptTokens > 0
      ? totalPromptTokens
      : totalCacheHitTokens + totalCacheMissTokens;
    return {
      totalRequests,
      totalPromptTokens,
      totalCompletionTokens,
      totalCacheHitTokens,
      totalCacheMissTokens,
      cacheHitRate: cacheHitRateBase > 0
        ? `${((totalCacheHitTokens / cacheHitRateBase) * 100).toFixed(1)}%`
        : "0%",
      cacheCoverageRate: cacheHitRateBase > 0
        ? `${((totalCacheHitTokens / cacheHitRateBase) * 100).toFixed(1)}%`
        : "0%",
      avgLatencyMs: totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0,
      estimatedCost: `¥${totalCost.toFixed(4)}`,
      savedByCache: `¥${totalSaved.toFixed(4)}`,
      savedPercentage: totalCost + totalSaved > 0
        ? `${((totalSaved / (totalCost + totalSaved)) * 100).toFixed(1)}%`
        : "0%",
      byUpstream,
    };
  }

  getRecent(n = 50): RequestLogEntry[] {
    return this.logs.slice(-n);
  }

  clear() {
    this.logs = [];
  }
}
