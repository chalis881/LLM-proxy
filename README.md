# LLM Cache Proxy v2.0

**厂商缓存优化代理** — 通过请求稳定化与显式缓存注入最大化上游 API 的缓存命中率，降低费用。

## 核心原理

DeepSeek、MiniMax 等厂商提供自动前缀缓存，千问等厂商支持显式缓存标记：相同前缀的请求，缓存命中 token 价格仅为正常价格的 1/10 ~ 1/50。

代理做的事情：
- **请求标准化**：system 消息提前、剥离时间戳/UUID → 让相同语义的请求产生相同前缀
- **显式缓存注入**：自动在 system / messages 的最佳位置注入 `cache_control` 标记（遵循千问官方最佳实践）
- **清理不支持的内容**：对 DeepSeek 等不支持多模态的 API，自动过滤 image_url
- **透传所有字段**：reasoning_content、tool_calls 等原样保留
- **多上游切换**：DeepSeek 挂了自动切通义/智谱
- **请求去重**：相同请求只发一次

不做的事情：
- ❌ 本地缓存响应（破坏厂商缓存）
- ❌ 语义缓存（额外成本）

## 显式缓存注入策略

针对 Anthropic 协议（千问 `/apps/anthropic` 端点）的 `cache_control` 标记自动注入，严格对齐千问官方最佳实践：

- **两阶段注入**：阶段一处理 system prompt（含 tools 定义），阶段二处理 messages，共享 marker 配额（默认上限 4，符合官方限制）
- **消息级截断**：Qwen3.5+ 仅支持消息级缓存截断，system 数组按整体稳定性判断，不进行内部 block 级截断
- **全局前缀基准**：缓存门槛（1024 Token）按截断点之前的全部内容计算（system + tools + messages 前缀），避免"大 system + 小 messages"误过滤
- **稳定性过滤**：中间断点前缀不稳定则剔除（避免必 miss 的无效写入），末尾断点保留（动态内容下一轮会成为稳定历史）
- **工具循环优化**：Anthropic 模式下 assistant 消息打在 `tool_use` block，user 消息打在 `tool_result` block，最大化 Agent 场景命中率
- **字节稳定**：tools 定义通过 `stableStringify`（字典序 + NFC 规范化）保证相同语义产生相同字节，避免 key 顺序差异导致缓存失效

## 快速开始

### 首次运行

```bash
git clone https://github.com/chalis881/LLM-proxy.git llm-cache-proxy
cd llm-cache-proxy
npm install
copy .env.example .env       # Windows CMD/PowerShell（Mac/Linux 用 cp）
npm run dev
```

### 日常运行

```bash
cd llm-cache-proxy
npm run dev
```

客户端只需改 base_url：
```typescript
const client = new OpenAI({
  apiKey: "anything",
  baseURL: "http://localhost:3456/v1",
});
```

## 厂商缓存定价对比

| 厂商 | 正常输入价 | 缓存命中价 | 折扣 |
|------|----------|----------|------|
| DeepSeek v4-flash | ¥1/百万token | ¥0.02/百万token | **50x** |
| DeepSeek v4-pro | ¥3/百万token | ¥0.025/百万token | **120x** |
| MiniMax M2.7 | ¥2.1/百万token | ¥0.42/百万token | **5x** |

## Dashboard

http://localhost:3456/dashboard

展示厂商缓存命中率、费用节省、Token 用量。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `ALL` | `/v1/*` | 透明代理 |
| `GET` | `/admin/upstreams` | 上游列表 |
| `POST` | `/admin/upstream/default` | 切换默认上游 |
| `GET` | `/stats` | 厂商缓存统计 |
| `GET` | `/dashboard` | Web 面板 |
| `GET` | `/health` | 健康检查 |

## 配置说明

### 缓存模式（cacheMode）

`upstreams.json` 中每个上游可独立配置缓存策略，核心在于「清理什么」与「是否注入标记」的取舍：

| cacheMode | normalization | 清理力度 | 注入 cache_control | 适用场景 |
|---|---|---|---|---|
| `none` | — | 仅 system 重排，内容一字不改 | ❌ | 上游不支持缓存，或需要完全透传原样内容 |
| `implicit` | — | system/assistant/tool_result 激进清理；普通 user 保守清理 | ❌ | DeepSeek 等自动前缀缓存厂商（无显式标记能力） |
| `active` | `safe`（默认） | 所有消息保守清理（只清理时间戳/UUID/长 ID 等绝对动态值） | ✅ | 千问 Anthropic 端点等支持显式缓存的厂商（生产默认） |
| `active` | `aggressive` | 普通 user 保守；system/assistant/tool_result 激进（额外清理 IP/PID/端口/百分比） | ✅ | 编码智能体等缓存优先场景（可能误伤业务数据） |

**关键区别**：

- **none vs implicit**：两者都不注入 cache_control。但 `none` 完全不动消息内容（仅 system 重排），`implicit` 会激进清理动态字段以提升厂商自动缓存命中率
- **implicit vs active**：`implicit` 清理更激进（因为只能靠厂商自动匹配前缀，需尽量消除动态干扰）；`active` 可以精准打标记，清理策略更保守以保护业务数据
- **safe vs aggressive**：仅 `active` 模式下生效。`safe` 保护 system/assistant/tool_result 中的事实数据（IP、端口等视为业务数据保留）；`aggressive` 将这些视为噪声清理掉，换取更高命中率

**清理策略分层**（按消息角色）：

| 消息类型 | safe 模式 | aggressive / implicit 模式 |
|---|---|---|
| 普通 user | 保守清理 | 保守清理 |
| system | 保守清理 | 激进清理 |
| assistant | 保守清理 | 激进清理 |
| tool_result | 保守清理 | 激进清理 |

> 设计原则：普通 user 消息始终保守清理（保护用户输入的事实数据）；system/assistant/tool_result 在激进模式下清理更多动态噪声（这些消息通常是模板/工具输出，噪声多、缓存价值高）。

### 端口

默认端口 `3456`，通过环境变量修改（`.env` 文件）：

```bash
PORT=8080
```

### 上游配置

编辑 `upstreams.json` 添加/修改上游。每个上游支持以下字段：

| 字段 | 说明 | 示例 |
|------|------|------|
| `baseURL` | 上游 API 地址 | `https://api.deepseek.com` |
| `apiKey` | API Key，支持 `${ENV_VAR}` 引用环境变量 | `${DEEPSEEK_API_KEY}` |
| `apiFormat` | 协议格式 | `openai` / `anthropic` |
| `cacheMode` | 缓存策略 | `active`（注入 cache_control）/ `implicit`（仅标准化）/ `none` |
| `multimodal` | 是否保留图片/音频 | `true` / `false` |
| `supportsCacheControl` | 上游是否支持显式缓存标记 | `true` / `false` |
| `priority` | 同模型多上游时的优先级（升序） | `100` |

### 切换上游

三种方式指定请求走哪个上游：
1. **按 model 自动路由**：`baseURL=http://localhost:3456`，请求体的 `model` 字段决定上游
2. **URL 锁定**：`baseURL=http://localhost:3456/x-upstream/<name>`
3. **Header 锁定**：添加请求头 `x-upstream: <name>`

## 常见问题

### 端口被占用

启动报错 `EADDRINUSE`，说明 3456 端口已被其他程序占用。修改 `.env`：

```bash
PORT=8080
```

### 缓存没有命中

- **确认内容超过 1024 Token**：厂商要求缓存内容至少 1024 Token，短对话不会命中
- **检查 system prompt 是否稳定**：含时间戳、UUID、git 状态等动态内容会破坏前缀稳定性
- **确认 `cacheMode` 设置**：`active` 才会注入 `cache_control` 标记；`none` 关闭所有缓存优化
- **查看 Dashboard**：访问 `http://localhost:3456/dashboard` 查看实时命中率

### 上游报错 401 / 403

- 检查 `.env` 中对应的 API Key 是否正确填写
- `upstreams.json` 中 `apiKey` 支持 `${ENV_VAR}` 语法引用环境变量，避免硬编码

### Anthropic 协议如何接入

将客户端 `baseURL` 指向 `http://localhost:3456/v1/messages`，并在 `upstreams.json` 中将对应上游的 `apiFormat` 设为 `anthropic`。显式缓存注入仅在 `anthropic` 协议下生效。

## 项目结构

```
src/
├── index.ts              # 入口
├── config.ts             # 配置
├── core/
│   ├── types.ts          # 类型
│   ├── normalizer.ts     # 请求稳定化（核心）
│   ├── cache-injector.ts # 显式缓存注入（cache_control 标记）
│   ├── cache-warmer.ts   # 缓存预热
│   ├── request-logger.ts # 日志 + 费用统计
│   └── query-extractor.ts
├── upstream/
│   ├── manager.ts        # 上游管理
│   └── forwarder.ts      # 转发 + 重试
├── routes/
│   ├── proxy.ts          # 代理路由
│   ├── admin.ts          # 管理 API
│   ├── stats.ts          # 统计 API
│   └── dashboard.ts      # Web 面板
└── utils/
    ├── hash.ts
    ├── logger.ts
    └── stable-stringify.ts  # 稳定 JSON 序列化（key 排序 + NFC）
```
