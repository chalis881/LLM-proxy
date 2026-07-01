import { describe, it, expect, afterEach, vi } from "vitest";
import { forward } from "../src/upstream/forwarder.js";
import type { UpstreamConfig } from "../src/core/types.js";

const originalFetch = globalThis.fetch;
const capturedRequests: Array<{ url: string; init: RequestInit }> = [];

function installFetchMock() {
  capturedRequests.length = 0;
  globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
    capturedRequests.push({ url: String(input), init: init || {} });
    return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe("forwarder 头部透传", () => {
  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  it("白名单头（accept/anthropic-version/x-request-id）会到达上游", async () => {
    installFetchMock();
    const upstream: UpstreamConfig = {
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4"],
      apiFormat: "openai",
      cacheMode: "auto",
      multimodal: false,
    };

    await forward(upstream, "/v1/chat/completions", "POST", { messages: [] }, {
      accept: "application/json",
      "x-request-id": "req-123",
    });

    const sentHeaders = capturedRequests[0].init.headers as Record<string, string>;
    expect(sentHeaders["accept"]).toBe("application/json");
    expect(sentHeaders["x-request-id"]).toBe("req-123");
  });

  it("代理内部头 x-prefix-hash 不会透传到上游", async () => {
    installFetchMock();
    const upstream: UpstreamConfig = {
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4"],
      apiFormat: "openai",
      cacheMode: "auto",
      multimodal: false,
    };

    await forward(upstream, "/v1/chat/completions", "POST", { messages: [] }, {
      "x-prefix-hash": "should-be-filtered",
    });

    const sentHeaders = capturedRequests[0].init.headers as Record<string, string>;
    expect(sentHeaders["x-prefix-hash"]).toBeUndefined();
    expect(sentHeaders["X-Prefix-Hash"]).toBeUndefined();
  });

  it("host / content-length 不会透传（让代理统一处理）", async () => {
    installFetchMock();
    const upstream: UpstreamConfig = {
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4"],
      apiFormat: "openai",
      cacheMode: "auto",
      multimodal: false,
    };

    await forward(upstream, "/v1/chat/completions", "POST", { messages: [] }, {
      host: "evil.example.com",
      "content-length": "9999",
    });

    const sentHeaders = capturedRequests[0].init.headers as Record<string, string>;
    expect(sentHeaders["host"]).toBeUndefined();
    expect(sentHeaders["content-length"]).toBeUndefined();
  });
});
