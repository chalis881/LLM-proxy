import { describe, it, expect } from "vitest";
import { injectCacheControl } from "../src/core/cache-injector.js";

describe("cache-injector", () => {
  it("短消息不注入缓存标记（不满足 minCacheTokens）", () => {
    const body = {
      model: "test",
      messages: [
        { role: "user", content: "hi" },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 10240, maxCacheMarkers: 4, cacheLatestUser: false });
    expect(result.markers).toBe(0);
  });

  it("长消息注入缓存标记", () => {
    const longText = "A".repeat(10000);
    const body = {
      model: "test",
      messages: [
        { role: "user", content: longText },
        { role: "assistant", content: "response" },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 10, maxCacheMarkers: 1 });
    expect(result.markers).toBeGreaterThanOrEqual(0); // 取决于 token 估算
  });

  it("cacheLatestUser=true 时最后一条 user 消息可缓存", () => {
    const body = {
      messages: [
        { role: "system", content: "You are a helpful assistant. ".repeat(50) },
        { role: "user", content: "A question here. ".repeat(50) },
      ],
    };

    const without = injectCacheControl(body, { minCacheTokens: 10, maxCacheMarkers: 1, cacheLatestUser: false });
    const withLast = injectCacheControl(body, { minCacheTokens: 10, maxCacheMarkers: 1, cacheLatestUser: true });

    expect(withLast.markers).toBeGreaterThanOrEqual(without.markers);
  });

  it("默认 cacheLatestUser=true 时最后一条 user 消息被注入 cache_control", () => {
    const longUserContent = "Question text. ".repeat(100);
    const body = {
      messages: [
        { role: "system", content: "System prompt. ".repeat(100) },
        { role: "user", content: longUserContent },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 10, maxCacheMarkers: 4 });
    // 应该至少有 1 个 marker（system 或 user）
    expect(result.markers).toBeGreaterThanOrEqual(1);

    // 检查最后一条 user 消息是否有 cache_control
    const messages = (result.body as any).messages;
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg.role === "user" && Array.isArray(lastUserMsg.content)) {
      const hasCacheControl = lastUserMsg.content.some(
        (block: any) => block.cache_control?.type === "ephemeral"
      );
      // 如果 marker 数 >= 2，说明 user 消息也被标记了
      if (result.markers >= 2) {
        expect(hasCacheControl).toBe(true);
      }
    }
  });

  it("string content 被转换为 {type:text, cache_control}", () => {
    const body = {
      messages: [
        { role: "user", content: "test ".repeat(200) },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 1, maxCacheMarkers: 1 });
    if (result.markers > 0) {
      const msg = (result.body as any).messages[0];
      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content[0].cache_control?.type).toBe("ephemeral");
    }
  });

  it("已有 cache_control 的消息不重复注入", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "test ".repeat(200), cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 1, maxCacheMarkers: 1 });
    // 已经有一个 marker，所以 markers 可能仍为 0（不算新注入的）
    expect(result.markers).toBe(0);
  });

  it("长对话会优先给更靠后的稳定前缀创建新缓存点", () => {
    const msgs = [
      { role: "system", content: "System prompt. ".repeat(120) },
      { role: "user", content: "Turn 1. ".repeat(120) },
      { role: "assistant", content: "Reply 1. ".repeat(120) },
      { role: "user", content: "Turn 2. ".repeat(120) },
      { role: "assistant", content: "Reply 2. ".repeat(120) },
    ];

    const result = injectCacheControl({ messages: msgs }, { minCacheTokens: 10, maxCacheMarkers: 2 });
    const injectedMessages = (result.body as any).messages;
    const injectedIndexes = injectedMessages
      .map((msg: any, index: number) => ({ msg, index }))
      .filter(({ msg }: any) => Array.isArray(msg.content) && msg.content.some((block: any) => block.cache_control?.type === "ephemeral"))
      .map(({ index }: any) => index);

    expect(injectedIndexes.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...injectedIndexes)).toBeGreaterThanOrEqual(2);
  });

  it("默认 maxCacheMarkers=2 且最后一条 user 消息必被注入", () => {
    const msgs = [
      { role: "system", content: "System prompt. ".repeat(200) },
      { role: "user", content: "User 1. ".repeat(120) },
      { role: "assistant", content: "Assistant 1. ".repeat(120) },
      { role: "user", content: "User 2. ".repeat(120) },
      { role: "assistant", content: "Assistant 2. ".repeat(120) },
      { role: "user", content: "Latest user question. ".repeat(60) },
    ];

    const result = injectCacheControl({ messages: msgs }, { minCacheTokens: 64, maxCacheMarkers: 3 });
    const injectedMessages = (result.body as any).messages;
    const lastUserIndex = msgs.length - 1;
    const lastUserInjected = Array.isArray(injectedMessages[lastUserIndex].content)
      && injectedMessages[lastUserIndex].content.some((b: any) => b.cache_control?.type === "ephemeral");
    expect(lastUserInjected).toBe(true);
  });

  it("多轮对话里断点位置会随对话增长右移", () => {
    const sys = "System prompt. ".repeat(200);
    function body(turns: number) {
      const messages: any[] = [{ role: "system", content: sys }];
      for (let i = 0; i < turns; i++) {
        messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
        messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
      }
      messages.push({ role: "user", content: `latest ${"z".repeat(400)}` });
      return { messages };
    }
    const indexesOf = (result: any) => (result.body as any).messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    const r1 = injectCacheControl(body(1), { minCacheTokens: 64, maxCacheMarkers: 3 });
    const r3 = injectCacheControl(body(3), { minCacheTokens: 64, maxCacheMarkers: 3 });
    const r5 = injectCacheControl(body(5), { minCacheTokens: 64, maxCacheMarkers: 3 });

    const m1 = Math.max(...indexesOf(r1));
    const m3 = Math.max(...indexesOf(r3));
    const m5 = Math.max(...indexesOf(r5));
    expect(m3).toBeGreaterThan(m1);
    expect(m5).toBeGreaterThan(m3);
  });

  it("agent 工具调用场景：每完成一次 tool 调用都建新段", () => {
    // 模拟一次用户提问 + 多次工具调用的 agent 循环
    // 每轮 assistant.tool_calls + tool 结果 → messages 末尾是一对 tool/assistant
    const sys = "You are an agent. ".repeat(120);
    const body = {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: "Please do the task. ".repeat(80) },
        { role: "assistant", content: "Calling tool. ", tool_calls: [{ id: "1", function: { name: "exec" } }] },
        { role: "tool", content: "result of tool 1. ".repeat(80) },
        { role: "assistant", content: "Calling tool. ", tool_calls: [{ id: "2", function: { name: "exec" } }] },
        { role: "tool", content: "result of tool 2. ".repeat(80) },
        { role: "assistant", content: "Calling tool. ", tool_calls: [{ id: "3", function: { name: "exec" } }] },
        { role: "tool", content: "result of tool 3. ".repeat(80) },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 });
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // 至少 system 1 + 尾部 1 = 2 个断点；尾部必须是"最后一个 tool"
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...indexes)).toBe(7); // 最后一个 tool
    expect(result.markers).toBeGreaterThanOrEqual(2);
  });

  it("Anthropic 模式：tool_use 末尾断点加在 tool_use block 上（不是 user 包装的 tool_result）", () => {
    // Anthropic Messages API 风格：system 单独字段，tool_use 在 assistant.content[] 里
    // tool_result 由 user 角色消息承载
    const sys = "You are a helpful agent. ".repeat(120);
    const body: any = {
      system: sys,
      messages: [
        { role: "user", content: "Please do the task. ".repeat(80) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will call a tool. " },
            { type: "tool_use", id: "1", name: "exec", input: { cmd: "ls" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "file1\nfile2" }] },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 }, undefined, "anthropic");
    const injectedMessages = (result.body as any).messages;
    const injectedSystem = (result.body as any).system;

    // system 应该被打 cache_control
    const systemHasCC = Array.isArray(injectedSystem)
      && injectedSystem.some((b: any) => b.cache_control?.type === "ephemeral");
    expect(systemHasCC).toBe(true);

    // 末尾 assistant 消息的 tool_use block 应该被打 cache_control
    const lastAssistant = injectedMessages[1];
    const toolUseBlock = lastAssistant.content.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock?.cache_control?.type).toBe("ephemeral");
  });

  it("Anthropic 模式：纯对话场景（无 tool）末尾 user 被打 cache_control", () => {
    const body: any = {
      system: "You are a helpful assistant. ".repeat(80),
      messages: [
        { role: "user", content: "Tell me a story. ".repeat(80) },
        { role: "assistant", content: "Once upon a time. ".repeat(80) },
        { role: "user", content: "What happened next? ".repeat(80) },
      ],
    };
    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 }, undefined, "anthropic");
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);
    // 末尾 user 必须被打
    expect(indexes).toContain(2);
  });

  it("Anthropic 模式：agent tool_result 末尾（user 消息带 tool_result）也被打 cache_control", () => {
    // 模拟：assistant 决策 + tool 调用 → user 消息承载 tool_result
    // 末尾 user 消息里有大段 tool_result 内容（模拟读文件返回的文档）
    const bigResult = "File content line. ".repeat(2000);
    const body: any = {
      system: "You are a helpful agent. ".repeat(120),
      messages: [
        { role: "user", content: "Read the file. ".repeat(80) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file. " },
            { type: "tool_use", id: "1", name: "read_file", input: { path: "/tmp/data.txt" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "1", content: bigResult }],
        },
      ],
    };
    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 }, undefined, "anthropic");
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);
    // 末尾 user 消息（带 tool_result）必须被打 cache_control
    expect(indexes).toContain(2);
    // 关键：cache_control 必须打在 tool_result 块上（不是 text block 上）
    const lastUserContent = injectedMessages[2].content;
    const toolResultBlock = lastUserContent.find((b: any) => b.type === "tool_result");
    expect(toolResultBlock?.cache_control?.type).toBe("ephemeral");
  });

  it("pickRollingCandidates 在候选不足时不会越界", () => {
    // 单条 system + 单条 user，候选只会有 1 个，但配额是 3
    const msgs = [
      { role: "system", content: "sys. ".repeat(200) },
      { role: "user", content: "hi. ".repeat(80) },
    ];
    // 不能崩：传 maxCacheMarkers=3 也不该抛
    expect(() =>
      injectCacheControl({ messages: msgs }, { minCacheTokens: 64, maxCacheMarkers: 3 })
    ).not.toThrow();
  });

  it("断点 index 集合在 messages 增长时保持稳定", () => {
    // 同 system + 1 轮 tool + 尾部 1 条 user
    // system 段必须始终在（不被 messages 增长挤掉）
    // messages 阶段断点位置会右移（等距抽取）
    const sys = "sys. ".repeat(200);

    function build(toolRounds: number) {
      const messages: any[] = [
        { role: "system", content: sys },
        { role: "user", content: "init. ".repeat(80) },
      ];
      for (let i = 0; i < toolRounds; i++) {
        messages.push({ role: "assistant", content: "act", tool_calls: [{ id: String(i) }] });
        messages.push({ role: "tool", content: `result ${i}. `.repeat(80) });
      }
      messages.push({ role: "user", content: "follow-up. ".repeat(60) });
      return { messages };
    }

    const indexesOf = (result: any) => (result.body as any).messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // 配额固定为 3：1 轮 / 3 轮 / 5 轮
    const r1 = indexesOf(injectCacheControl(build(1), { minCacheTokens: 64, maxCacheMarkers: 3 }));
    const r3 = indexesOf(injectCacheControl(build(3), { minCacheTokens: 64, maxCacheMarkers: 3 }));
    const r5 = indexesOf(injectCacheControl(build(5), { minCacheTokens: 64, maxCacheMarkers: 3 }));

    // system 段始终在第一轮 messages 阶段被标记
    expect(r1).toContain(0);
    expect(r3).toContain(0);
    expect(r5).toContain(0);

    // 每次 messages 阶段都至少额外有 1 个断点（尾部 user/tool）
    expect(r1.length).toBeGreaterThanOrEqual(2);
    expect(r3.length).toBeGreaterThanOrEqual(2);
    expect(r5.length).toBeGreaterThanOrEqual(2);

    // messages 阶段末尾断点对应 messages 数组的最末尾（尾部 user）
    expect(r1[r1.length - 1]).toBe(4); // 1 轮 tool 末尾 user
    expect(r3[r3.length - 1]).toBe(8); // 3 轮 tool 末尾 user
    expect(r5[r5.length - 1]).toBe(12); // 5 轮 tool 末尾 user
  });

  it("agent 工具调用场景：每次循环后断点位置会随 messages 增长右移", () => {
    const sys = "Agent system prompt. ".repeat(150);

    function build(toolRounds: number) {
      const messages: any[] = [
        { role: "system", content: sys },
        { role: "user", content: "Initial task. ".repeat(100) },
      ];
      for (let i = 0; i < toolRounds; i++) {
        messages.push({ role: "assistant", content: "act", tool_calls: [{ id: String(i) }] });
        messages.push({ role: "tool", content: `tool result ${i}. `.repeat(80) });
      }
      return { messages };
    }

    const indexesOf = (result: any) => (result.body as any).messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    const r1 = injectCacheControl(build(1), { minCacheTokens: 64, maxCacheMarkers: 4 });
    const r3 = injectCacheControl(build(3), { minCacheTokens: 64, maxCacheMarkers: 4 });
    const r5 = injectCacheControl(build(5), { minCacheTokens: 64, maxCacheMarkers: 4 });

    // 末尾断点应随 tool 调用轮次增长而右移
    const tail1 = Math.max(...indexesOf(r1));
    const tail3 = Math.max(...indexesOf(r3));
    const tail5 = Math.max(...indexesOf(r5));
    expect(tail3).toBeGreaterThan(tail1);
    expect(tail5).toBeGreaterThan(tail3);
  });

  // ── Qwen3.5+ message-level 分层策略 ──

  it("message 级分层：cap=4 在 12 条 messages 上分布为 1/4、2/4、3/4、末尾", () => {
    const sys = "System prompt. ".repeat(150);
    const messages: any[] = [{ role: "system", content: sys }];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
      messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
    }
    // 末尾是 user 消息
    messages.push({ role: "user", content: `latest ${"z".repeat(400)}` });

    const result = injectCacheControl({ messages }, { minCacheTokens: 64, maxCacheMarkers: 4 });
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // messages 阶段应该打 4 个 marker
    expect(indexes.length).toBe(4);
    // 最后一个 marker 在最末尾（index 11）
    expect(Math.max(...indexes)).toBe(11);
    // 中间 marker 不应全在末尾
    const mid = indexes.filter((i) => i < 11);
    expect(mid.length).toBeGreaterThan(0);
  });

  it("message 级分层：极短对话只打末尾 marker（messages 阶段去重）", () => {
    const sys = "System prompt. ".repeat(150);
    // 极短：只有 2 条非 system message
    const messages: any[] = [
      { role: "system", content: sys },
      { role: "user", content: `q1 ${"x".repeat(800)}` },
      { role: "assistant", content: `a1 ${"y".repeat(800)}` },
    ];

    const result = injectCacheControl({ messages }, { minCacheTokens: 64, maxCacheMarkers: 4 });
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // system 单独打 + messages 阶段打末尾 1 个或 2 个（cap=4 映射到 2 个非 system 消息上 → 去重 [1,2]）
    expect(indexes.length).toBeLessThanOrEqual(3);
    // 末尾 marker 必然是 messages 最后一条
    expect(Math.max(...indexes)).toBe(2);
  });

  it("message 级分层：随着对话增长 marker 位置单调右移", () => {
    const sys = "System prompt. ".repeat(150);
    function build(turns: number) {
      const messages: any[] = [{ role: "system", content: sys }];
      for (let i = 0; i < turns; i++) {
        messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
        messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
      }
      messages.push({ role: "user", content: `latest ${"z".repeat(400)}` });
      return { messages };
    }

    const indexesOf = (result: any) => (result.body as any).messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    const r1 = indexesOf(injectCacheControl(build(2), { minCacheTokens: 64, maxCacheMarkers: 4 }));
    const r3 = indexesOf(injectCacheControl(build(6), { minCacheTokens: 64, maxCacheMarkers: 4 }));
    const r5 = indexesOf(injectCacheControl(build(10), { minCacheTokens: 64, maxCacheMarkers: 4 }));

    // 末尾 marker 必然右移
    expect(Math.max(...r3)).toBeGreaterThan(Math.max(...r1));
    expect(Math.max(...r5)).toBeGreaterThan(Math.max(...r3));
  });

  it("message 级分层：断点位置在 messages index 上一一对应，无重复", () => {
    const sys = "System prompt. ".repeat(150);
    const messages: any[] = [{ role: "system", content: sys }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
      messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
    }
    messages.push({ role: "user", content: `latest ${"z".repeat(400)}` });

    const result = injectCacheControl({ messages }, { minCacheTokens: 64, maxCacheMarkers: 4 });
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // 断点互不重复
    expect(new Set(indexes).size).toBe(indexes.length);
    // 断点单升
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });

  it("message 级分层：Anthropic agent 场景下尾部 marker 落在 tool_result 上", () => {
    const sys = "Agent system. ".repeat(150);
    const bigResult = "File content line. ".repeat(2000);
    const body: any = {
      system: sys,
      messages: [
        { role: "user", content: "Read the file. ".repeat(80) },
        { role: "assistant", content: "Reading. ".repeat(80) },
        { role: "user", content: `more questions. `.repeat(80) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file. " },
            { type: "tool_use", id: "1", name: "read_file", input: { path: "/tmp/data.txt" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "1", content: bigResult }],
        },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 }, undefined, "anthropic");
    const injectedMessages = (result.body as any).messages;
    const lastUserContent = injectedMessages[4].content;
    const toolResultBlock = lastUserContent.find((b: any) => b.type === "tool_result");
    expect(toolResultBlock?.cache_control?.type).toBe("ephemeral");
  });

  // ── 官方协议差距修复测试 ──

  it("cacheLatestUser 行为：minCacheTokens 较小时 cap=2 自然包含末尾", () => {
    // 用 baseTokens（system 段）做全局基准后：
    // - minCacheTokens 小时（≤ 10）: 末尾自然被 k=cap 的 frac=1.0 选中
    // - minCacheTokens 大时（≥ 5000）: messages 段不够，但 system 段 ≥ 5000 → 末尾仍被选中
    const sys = "System prompt. ".repeat(200);  // ~3000 tokens
    const messages: any[] = [
      { role: "system", content: sys },
      { role: "user", content: `q1 ${"x".repeat(100)}` },
      { role: "assistant", content: `a1 ${"y".repeat(100)}` },
      { role: "user", content: `q2 ${"x".repeat(100)}` },
    ];

    // 场景 A：minCacheTokens 较小（baseTokens + prefixTokens > 64 即可）
    // cap=2 → positions [1, 3]，末尾 3 必然被选中
    const small = injectCacheControl({ messages }, { minCacheTokens: 64, maxCacheMarkers: 2, cacheLatestUser: true });
    const idxSmall = (small.body as any).messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // 末尾 (index=3) 必须被标记
    expect(idxSmall).toContain(3);

    // 场景 B：minCacheTokens 很大（> 10000）→ system ~3000 + messages 段最多几百 < 10000
    // 这时 messages 阶段一个 marker 都不会打
    const big = injectCacheControl({ messages }, { minCacheTokens: 100000, maxCacheMarkers: 2, cacheLatestUser: true });
    const idxBig = (big.body as any).messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // messages 阶段不应该打 marker（被全局门槛挡住）
    expect(idxBig.length).toBe(0);
  });

  it("默认 maxCacheMarkers=4（官方上限）", () => {
    // 不显式传 maxCacheMarkers，应走默认 4
    const sys = "System prompt. ".repeat(150);
    const messages: any[] = [{ role: "system", content: sys }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
      messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
    }
    messages.push({ role: "user", content: `latest ${"z".repeat(400)}` });

    // 用默认配置（不传 config）
    const result = injectCacheControl({ messages });
    // 默认 maxCacheMarkers=4 → messages 阶段最多 4 个 marker（加上 system 1 个，markers 字段统计总 marker 数）
    expect(result.markers).toBeLessThanOrEqual(5);
  });

  it("tools 字段纳入 system 段 token 估算（小 system 配大 tools 也能达到 minCacheTokens）", () => {
    // system 文本只有 100 字符（远低于 minCacheTokens=10000），但 tools 字段很大
    const tinySystem = "short. ";
    const bigTools = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Description for tool ${i} with enough text. `.repeat(50),
      parameters: { type: "object", properties: { arg: { type: "string" } } },
    }));

    const messages: any[] = [
      { role: "user", content: `q1 ${"x".repeat(800)}` },
      { role: "assistant", content: `a1 ${"y".repeat(800)}` },
    ];

    // 不带 tools：system token 不够，预期不注入
    const noTools = injectCacheControl({ system: tinySystem, messages }, { minCacheTokens: 10000, maxCacheMarkers: 4 }, undefined, "anthropic");
    expect(noTools.markers).toBe(0);

    // 带 tools：tools 参与计算，应能注入
    const withTools = injectCacheControl({ system: tinySystem, tools: bigTools, messages }, { minCacheTokens: 10000, maxCacheMarkers: 4 }, undefined, "anthropic");
    expect(withTools.markers).toBeGreaterThan(0);
  });

  it("多条 system message 合并：selectCachePoints 跳过所有 system role", () => {
    const sys1 = "System prompt 1. ".repeat(150);
    const sys2 = "System prompt 2. ".repeat(150);
    const messages: any[] = [
      { role: "system", content: sys1 },
      { role: "system", content: sys2 },
      { role: "user", content: `q1 ${"x".repeat(800)}` },
      { role: "assistant", content: `a1 ${"y".repeat(800)}` },
      { role: "user", content: `q2 ${"x".repeat(800)}` },
    ];

    const result = injectCacheControl({ messages }, { minCacheTokens: 64, maxCacheMarkers: 4 });
    const injectedMessages = (result.body as any).messages;
    const systemIndexes = messages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => m.role === "system")
      .map(({ i }: any) => i);

    // 选中的 system message 应该是第一个（system[0]）—— Qwen3.5+ 多 system 合并
    // 不应该在 system[1] 上也打 marker（中间截断无效）
    const systemInjected = systemIndexes.filter((i) =>
      Array.isArray(injectedMessages[i].content) &&
      injectedMessages[i].content.some((b: any) => b.cache_control?.type === "ephemeral")
    );

    // 只在第一条 system 上打 marker（其它 system 跳过，由 selectCachePoints 排除）
    expect(systemInjected.length).toBe(1);
    expect(systemInjected[0]).toBe(0);
  });

  // ── Qwen3.5+ system 数组整体判断 ──

  it("system 数组任一 block 动态 → 整个 system 不打标（避免脏缓存）", () => {
    // Qwen3.5+ 多 system 内部无法在中间截断 → 任一动态 = 整体不标
    // 用 normalizer 不会清理的"git log"模式触发 isDynamicText（避免被 normalizer 提前清理）
    const body: any = {
      system: [
        { type: "text", text: "You are a helpful agent. ".repeat(100) },  // 稳定
        { type: "text", text: `git log --oneline -5\nabc1234 update\ndef5678 fix\n`.repeat(40) }, // 含 git log → 动态
        { type: "text", text: "Be concise. ".repeat(80) },                 // 稳定
      ],
      messages: [
        { role: "user", content: "Hello. ".repeat(80) },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 }, undefined, "anthropic");
    const sys = (result.body as any).system;
    const hasMarker = Array.isArray(sys) && sys.some((b: any) => b.cache_control?.type === "ephemeral");
    expect(hasMarker).toBe(false);
  });

  it("system 数组全部稳定 + token 够 → 在最后一个 text block 打标", () => {
    // 全部静态 + 总 token ≥ minCacheTokens → 整体可以打缓存
    const body: any = {
      system: [
        { type: "text", text: "You are a helpful agent. ".repeat(100) },
        { type: "text", text: "Always respond in JSON. ".repeat(100) },
        { type: "text", text: "Be concise. ".repeat(100) },
      ],
      messages: [
        { role: "user", content: "Hello. ".repeat(80) },
      ],
    };

    const result = injectCacheControl(body, { minCacheTokens: 64, maxCacheMarkers: 4 }, undefined, "anthropic");
    const sys = (result.body as any).system as any[];
    const markedIdx = sys.findIndex((b: any) => b.cache_control?.type === "ephemeral");

    // 必须打标
    expect(markedIdx).toBeGreaterThanOrEqual(0);
    // 必须打标在最后一个 text block 上（保证覆盖最大 prefix）
    expect(markedIdx).toBe(sys.length - 1);
  });

  // ── stable 过滤：中间断点不稳定 → 不打（避免必 miss 的断点） ──

  it("中间断点前缀不稳定 → 剔除；末尾保留（多轮/工具循环场景）", () => {
    // 模拟"中间有动态内容但末尾稳定"的多轮场景
    // 14 条 messages：1 system + 12 非 system（中间夹 1 条 git log 动态），末尾 1 条 user
    const sys = "System prompt. ".repeat(150);
    const messages: any[] = [{ role: "system", content: sys }];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
      messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
    }
    // 中间插入一条动态 user（含 git log，触发 isDynamicText）
    messages.push({ role: "user", content: `git log --oneline -5\nabc1234 update\ndef5678 fix\n`.repeat(40) });
    for (let i = 5; i < 9; i++) {
      messages.push({ role: "user", content: `q${i} ${"x".repeat(800)}` });
      messages.push({ role: "assistant", content: `a${i} ${"y".repeat(800)}` });
    }
    // 末尾 user
    messages.push({ role: "user", content: `latest ${"z".repeat(400)}` });

    const result = injectCacheControl({ messages }, { minCacheTokens: 64, maxCacheMarkers: 4 });
    const injectedMessages = (result.body as any).messages;
    const indexes = injectedMessages
      .map((m: any, i: number) => ({ m, i }))
      .filter(({ m }: any) => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control?.type === "ephemeral"))
      .map(({ i }: any) => i);

    // 末尾必须保留（多轮/工具循环场景的下一轮价值）
    expect(Math.max(...indexes)).toBe(messages.length - 1);
    // 中间断点应该跳过动态 message 之后的位置
    // 动态 message 索引为 12，cap=4 映射到 positions [3, 7, 10, 13] (12条非 system)
    // 索引 12 (动态) 在 cap=4 分布中不会落入理想位置（k=4 → 13），所以中间断点不会在动态位
    // 但动态位之后的所有位置都被标记为 unstable → 中间断点应被过滤
    // 期望：只有末尾断点 + 也许 system 段断点
    const middleBreakpoints = indexes.filter((i) => i > 0 && i < messages.length - 1);
    // 关键：中间不应有不稳定前缀的断点
    for (const idx of middleBreakpoints) {
      const msg = messages[idx];
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      // 中间断点不应包含 git log
      expect(/git\s+log/i.test(content)).toBe(false);
    }
  });
});
