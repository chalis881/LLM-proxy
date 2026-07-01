import { logger } from "../utils/logger.js";

/**
 * 缓存预热器
 *
 * 厂商缓存有 TTL（通常 5 分钟），过期后缓存消失。
 * 预热器定期用相同前缀 + 最小的 max_tokens ping 上游，
 * 相当于"续命"缓存，确保高频使用的 system prompt 不会被清掉。
 *
 * 用法：每次收到有效请求后更新 body，预热器拿最新的 body 去 ping
 */

export interface WarmerConfig {
  interval: number;  // ping 间隔（秒），0 表示禁用
  debug: boolean;
  maxRounds: number; // 连续加热最大次数，0 表示不限制
}

export class CacheWarmer {
  private body: Record<string, unknown> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: WarmerConfig;
  private upstreamBase: string;
  private apiKey: string | null;
  private apiFormat: "openai" | "anthropic";
  private warmRounds = 0;
  private pausedByMaxRounds = false;

  constructor(upstreamBase: string, apiKey: string | null, apiFormat: "openai" | "anthropic", config?: Partial<WarmerConfig>) {
    this.upstreamBase = upstreamBase;
    this.apiKey = apiKey;
    this.apiFormat = apiFormat;
    this.config = { interval: 0, debug: false, maxRounds: 6, ...config };
  }

  /** 更新最新的请求体（用于预热 ping）；真实请求到来时恢复加热计数 */
  update(body: Record<string, unknown>) {
    // 始终保存 body，即使当前 interval=0
    // 用户后续可能通过面板开启预热
    this.body = { ...body };
    // 真实用户请求表示用户又开始工作，重置连续加热次数并解除暂停
    this.warmRounds = 0;
    this.pausedByMaxRounds = false;
    if (this.config.interval <= 0) return;
    if (!this.timer) this.start();
  }

  start() {
    if (this.config.interval <= 0 || !this.apiKey) return;
    this.stop();
    this.timer = setInterval(() => this.ping(), this.config.interval * 1000);
    if (this.config.debug) logger.info(`[Warmer] Started, interval: ${this.config.interval}s`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 动态调整间隔（0 = 停止） */
  setInterval(seconds: number) {
    this.config.interval = seconds;
    if (seconds <= 0) {
      this.stop();
      logger.info("[Warmer] Stopped");
    } else {
      this.warmRounds = 0;
      this.pausedByMaxRounds = false;
      this.start();
      logger.info(`[Warmer] Interval set to ${seconds}s`);
      // 立即执行一次 ping，而不是等 interval 后才开始
      if (this.body) {
        logger.info("[Warmer] Executing immediate ping...");
        this.ping().catch(() => {});
      } else {
        logger.info("[Warmer] Waiting for first request to cache body...");
      }
    }
  }

  /** 更新上游信息（上游切换时调用） */
  updateUpstream(baseURL: string, apiKey: string, apiFormat: "openai" | "anthropic") {
    this.upstreamBase = baseURL;
    this.apiKey = apiKey;
    this.apiFormat = apiFormat;
  }

  private async ping() {
    if (!this.body || !this.apiKey) return;
    if (this.pausedByMaxRounds) {
      if (this.config.debug) logger.info(`[Warmer] Paused: max rounds reached (${this.warmRounds}/${this.config.maxRounds})`);
      return;
    }

    let attempted = false;
    try {
      const messages = Array.isArray(this.body.messages)
        ? [...(this.body.messages as any[]).slice(0, -1), { role: "user", content: "." }]
        : [];

      if (messages.length === 0) return;

      // 清理代理注入的字段，避免上游不支持
      const cleanBody: Record<string, unknown> = { ...this.body };
      delete cleanBody.stream_options;
      delete cleanBody["x-prefix-hash"];

      const warmBody: Record<string, unknown> = {
        ...cleanBody,
        messages,
        max_tokens: 1,
        stream: false,
      };

      const base = this.upstreamBase.replace(/\/$/, "");
      let url: string;
      let headers: Record<string, string>;

      if (this.apiFormat === "anthropic") {
        url = `${base}/messages`;
        headers = {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        };
      } else {
        url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
        headers = {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        };
      }

      attempted = true;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(warmBody),
      });

      if (resp.status >= 400) {
        const errText = await resp.text().catch(() => "");
        logger.warn(`[Warmer] Ping failed: ${resp.status} ${url} - ${errText.slice(0, 200)}`);
      } else {
        logger.info(`[Warmer] Ping success: ${this.upstreamBase} → ${resp.status}`);
      }
    } catch (e) {
      logger.warn(`[Warmer] Ping failed: ${(e as Error).message}`);
    } finally {
      if (attempted) this.recordWarmRound();
    }
  }

  private recordWarmRound() {
    if (this.config.maxRounds <= 0) return;
    this.warmRounds++;
    if (this.warmRounds >= this.config.maxRounds) {
      this.pausedByMaxRounds = true;
      logger.info(`[Warmer] Paused after ${this.warmRounds}/${this.config.maxRounds} warm rounds; next real request will resume`);
    } else if (this.config.debug) {
      logger.info(`[Warmer] Warm rounds: ${this.warmRounds}/${this.config.maxRounds}`);
    }
  }

  getStats() {
    return {
      active: this.timer !== null,
      interval: this.config.interval,
      upstream: this.upstreamBase,
      warmRounds: this.warmRounds,
      maxRounds: this.config.maxRounds,
      pausedByMaxRounds: this.pausedByMaxRounds,
    };
  }
}
