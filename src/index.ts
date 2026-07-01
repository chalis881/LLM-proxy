import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { UpstreamManager } from "./upstream/manager.js";
import { PromptNormalizer } from "./core/normalizer.js";
import { RequestLogger } from "./core/request-logger.js";
import { CacheWarmer } from "./core/cache-warmer.js";
import { createProxyRoute } from "./routes/proxy.js";
import { createAdminRoute } from "./routes/admin.js";
import { createStatsRoute } from "./routes/stats.js";
import { createDashboardRoute } from "./routes/dashboard.js";
import { logger } from "./utils/logger.js";

const app = new Hono();

// 初始化
const upstreamMgr = new UpstreamManager();
upstreamMgr.watch();
const normalizer = new PromptNormalizer();
const requestLogger = new RequestLogger();

// 缓存预热器（始终创建，默认 interval=0 关闭，面板可控制）
const defaultUpstream = upstreamMgr.getByName(upstreamMgr.getDefault())!;
const cacheWarmInterval = parseInt(process.env.CACHE_WARM_INTERVAL || "0", 10);
const cacheWarmMaxRounds = parseInt(process.env.CACHE_WARM_MAX_ROUNDS || "6", 10);
const cacheWarmer = new CacheWarmer(defaultUpstream.baseURL, defaultUpstream.apiKey, defaultUpstream.apiFormat, {
  interval: cacheWarmInterval,
  maxRounds: cacheWarmMaxRounds,
  debug: process.env.DEBUG_CACHE_PROXY === "1",
});

// 路由
app.route("/", createProxyRoute(upstreamMgr, normalizer, requestLogger, cacheWarmer));
app.route("/admin", createAdminRoute(upstreamMgr, () => cacheWarmer));
app.route("/stats", createStatsRoute(requestLogger, cacheWarmer));
app.route("/dashboard", createDashboardRoute());

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.json({
  name: "llm-cache-proxy",
  version: "2.1.0",
  description: "厂商缓存优化代理（支持主动缓存 + 缓存预热）",
  defaultUpstream: upstreamMgr.getDefault(),
  upstreams: upstreamMgr.list().length,
  features: {
    autoNormalize: true,
    activeCacheInjection: true,
    cacheWarmer: cacheWarmer !== null,
  },
  endpoints: {
    openai: "/v1/*",
    anthropic: "/v1/messages",
    admin: "/admin/upstreams",
    stats: "/stats",
    dashboard: "/dashboard",
    health: "/health",
  },
}));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const activeCacheMode = (process.env.ACTIVE_CACHE_MODE || "active").toLowerCase();
  const upstreamNames = upstreamMgr.list().map((u) => u.name);
  logger.info(`══════════════════════════════════════`);
  logger.info(`LLM Cache Proxy v2.2`);
  logger.info(`厂商缓存优化 + 主动/隐式缓存 + 缓存预热`);
  logger.info(`监听:        http://localhost:${info.port}`);
  logger.info(`OpenAI:      http://localhost:${info.port}/v1`);
  logger.info(`Anthropic:   http://localhost:${info.port}/v1/messages`);
  logger.info(`按上游路由:   http://localhost:${info.port}/x-upstream/<name>/v1`);
  logger.info(`Dashboard:   http://localhost:${info.port}/dashboard`);
  logger.info(`Warmer:      ${cacheWarmInterval > 0 ? `ON (${cacheWarmInterval}s, max ${cacheWarmMaxRounds || "∞"} rounds)` : "OFF (面板可开启)"}`);
  logger.info(`ActiveCache: ${activeCacheMode} (upstream.cacheMode 决定 active/implicit/none)`);
  logger.info(`已加载上游:   [${upstreamNames.join(", ")}]`);
  logger.info(`──────────────────────────────────────`);
  logger.info(`客户端用法:`);
  logger.info(`  1) 自动按 model: baseURL=http://localhost:${info.port}, body.model=LongCat-2.0`);
  logger.info(`  2) baseURL 锁上游: baseURL=http://localhost:${info.port}/x-upstream/<name>`);
  logger.info(`  3) header 锁上游:  -H "x-upstream: <name>"`);
  logger.info(`  同 model 多上游时按 priority 升序，禁用/缺省走默认`);
  logger.info(`══════════════════════════════════════`);
});
