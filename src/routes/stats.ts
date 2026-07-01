import { Hono } from "hono";
import type { RequestLogger } from "../core/request-logger.js";
import type { CacheWarmer } from "../core/cache-warmer.js";

export function createStatsRoute(requestLogger: RequestLogger, cacheWarmer?: CacheWarmer): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const recent = requestLogger.getRecent(20);
    const stats: Record<string, unknown> = {
      requests: requestLogger.getStats(),
    };
    if (cacheWarmer) stats.warmer = cacheWarmer.getStats();
    stats.recentCachePoints = recent
      .filter((e) => e.cachePoints.length > 0)
      .map((e) => ({
        timestamp: e.timestamp,
        upstream: e.upstream,
        model: e.model,
        cachePoints: e.cachePoints,
        cachePointGaps: e.cachePointGaps,
        cacheCoverage: e.cacheCoverage,
        cacheCliff: e.cacheCliff,
        vendorCacheHitTokens: e.vendorCacheHitTokens,
        vendorCacheMissTokens: e.vendorCacheMissTokens,
      }));
    return c.json(stats);
  });

  app.get("/recent", (c) => {
    const n = parseInt(c.req.query("n") || "20", 10);
    return c.json({ logs: requestLogger.getRecent(n) });
  });

  app.delete("/", (c) => {
    requestLogger.clear();
    return c.json({ ok: true });
  });

  return app;
}

