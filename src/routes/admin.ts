import { Hono } from "hono";
import type { UpstreamManager } from "../upstream/manager.js";
import type { CacheWarmer } from "../core/cache-warmer.js";
import type { ModelConfig } from "../core/types.js";

export function createAdminRoute(upstreamMgr: UpstreamManager, getWarmer?: () => CacheWarmer): Hono {
  const app = new Hono();

  app.get("/upstreams", (c) => {
    return c.json({
      default: upstreamMgr.getDefault(),
      upstreams: upstreamMgr.list(),
    });
  });

  // 获取单个上游原始数据（含完整 API Key，供编辑用）
  app.get("/upstreams/:name", (c) => {
    const name = c.req.param("name");
    const u = upstreamMgr.getByName(name);
    if (!u) return c.json({ error: { message: `Upstream "${name}" not found` } }, 404);
    return c.json({
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
    });
  });

  app.post("/upstream/default", async (c) => {
    const body = await c.req.json<{ name: string }>();
    try {
      upstreamMgr.setDefault(body.name);
      // 上游切换后同步更新 warmer
      const warmer = getWarmer?.();
      if (warmer) {
        const u = upstreamMgr.getByName(body.name);
        if (u) warmer.updateUpstream(u.baseURL, u.apiKey, u.apiFormat);
      }
      return c.json({ ok: true, default: body.name });
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }
  });

  app.post("/upstreams", async (c) => {
    const body = await c.req.json<{
      name: string; baseURL: string; apiKey: string; models: (string | ModelConfig)[];
      apiFormat?: string; cacheMode?: string; normalization?: string; multimodal?: boolean; supportsCacheControl?: boolean; disabled?: boolean; priority?: number;
    }>();
    try {
      upstreamMgr.upsert(
        body.name, body.baseURL, body.apiKey, body.models || [],
        body.apiFormat, body.cacheMode, body.multimodal,
        body.supportsCacheControl !== false, // 缺省 true（向后兼容）
        body.normalization,
        body.disabled === true,
        typeof body.priority === "number" ? body.priority : 100,
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }
  });

  app.delete("/upstreams/:name", async (c) => {
    const name = c.req.param("name");
    try {
      upstreamMgr.remove(name);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }
  });

  app.post("/upstreams/reload", (c) => {
    upstreamMgr.reload();
    return c.json({ ok: true });
  });

  // ─── 缓存预热控制 ───

  app.get("/warmer", (c) => {
    const warmer = getWarmer?.();
    return c.json(warmer ? warmer.getStats() : { active: false });
  });

  app.post("/warmer", async (c) => {
    const warmer = getWarmer?.();
    if (!warmer) return c.json({ error: { message: "Warmer not initialized" } }, 400);
    const body = await c.req.json<{ interval?: number; upstream?: string }>();
    if (body.interval !== undefined) {
      warmer.setInterval(body.interval);
    }
    if (body.upstream) {
      const u = upstreamMgr.getByName(body.upstream);
      if (u) warmer.updateUpstream(u.baseURL, u.apiKey, u.apiFormat);
    }
    return c.json({ ok: true, ...warmer.getStats() });
  });

  return app;
}
