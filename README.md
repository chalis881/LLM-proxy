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

```bash
cd llm-cache-proxy
npm install
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
