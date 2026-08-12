# 接入新平台检查清单（AI Monitor 本地代理）

> 把 AI Monitor 的本地代理（127.0.0.1:8899）接入一个新 API 平台时，按这份清单做，避免踩坑。
> 背景：2026-08-03 接入硅基流动时踩过两个坑：默认路由写死 DeepSeek、缺少 Anthropic 映射，导致 Proma 调硅基流动报 401/402 或"暂不支持 Anthropic 格式"。

## 前置概念

- Proma Agent 等客户端走 **Anthropic Messages 协议**（`POST /v1/messages`）
- 普通 SDK（OpenAI 等）走 **OpenAI 协议**（`POST /v1/chat/completions`）
- 代理按 URL 前缀路由平台：`http://127.0.0.1:8899/<platform>/v1/...`
- **不带前缀的 `/v1/*` 请求默认路由到 deepseek**（`handle_default_catch` 硬编码）

## 接入步骤

### 1. 确认平台支持 Anthropic 协议

```bash
# 平台官方 /v1/messages 端点是否存在（返回 401 而非 404 = 支持）
curl -s -o /dev/null -w "%{http_code}" -X POST https://<平台域名>/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: test" -d '{"model":"test","max_tokens":10,"messages":[]}'
# 401 = 端点存在（只是 key 无效）✅；404 = 不支持 Anthropic ❌
```

### 2. 修改 `src-tauri/src/proxy.rs`

**a. `upstream_base`（OpenAI 协议转发目标）**：加入新平台 base URL

```rust
fn upstream_base(provider: &str) -> Option<&'static str> {
    match provider {
        // 已有: deepseek / moonshot / siliconflow / openrouter / openai / zhipu
        "新平台" => Some("https://api.xxx.com/v1"),
        _ => None,
    }
}
```

**b. `upstream_anthropic`（Anthropic 协议转发目标）**：只有平台支持 `/v1/messages` 才加，否则留空（会返回 400 "暂不支持 Anthropic 格式"）

```rust
fn upstream_anthropic(provider: &str) -> Option<&'static str> {
    match provider {
        // 已有: deepseek / moonshot / siliconflow / openrouter
        "新平台" => Some("https://api.xxx.com/v1/messages"),
        _ => None,
    }
}
```

### 3. 客户端（Proma 等）配置

- **Base URL**：`http://127.0.0.1:8899/<platform>/v1`（**必须带平台前缀**，否则走默认 deepseek 路由）
- **API Key**：填你在这个平台申请的真实 key（代理只转发，不替换 key）
- **模型 ID**：必须是该平台自己的模型 ID（如硅基流动是 `deepseek-ai/DeepSeek-V3` 这种带命名空间的），不是别的平台的 ID

### 4. 验证

```bash
# OpenAI 协议
curl http://127.0.0.1:8899/<platform>/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <真实key>" \
  -d '{"model":"<平台模型ID>","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 协议（Proma Agent 用这个）
curl http://127.0.0.1:8899/<platform>/v1/messages \
  -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -H "x-api-key: <真实key>" \
  -d '{"model":"<平台模型ID>","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

成功后 `daily_usage` 表会新增记录（input/output tokens + 估算费用）。

## 常见错误速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Authentication Fails, Your api key is invalid` | 请求被默认路由转发到 DeepSeek（URL 没带平台前缀 / 平台不支持 Anthropic 走了默认） | 检查客户端 Base URL 是否带 `/平台名/v1` 前缀 |
| `xxx 暂不支持 Anthropic 格式` | `upstream_anthropic` 没有该平台映射 | 确认平台支持 `/v1/messages` 后补映射；不支持则客户端只能走 OpenAI 协议 |
| `Token is invalid` / `Invalid API key` | key 无效 | 检查 key 是否该平台真实 key |
| 402 (no body) | 平台余额不足 / 需付费 / 需实名 | 充值或换便宜模型；部分平台需实名认证才能调付费模型 |
| `Model Not Found` | 模型 ID 不是该平台 ID | 用平台官方模型 ID（`/v1/models` 可查） |

## 已支持平台映射表

| 平台 | OpenAI base | Anthropic 端点 | 客户端前缀 |
|---|---|---|---|
| DeepSeek | `api.deepseek.com/v1` | ✅ `api.deepseek.com/anthropic/v1/messages` | `/deepseek`（或默认 `/v1`） |
| Moonshot | `api.moonshot.cn/v1` | ✅ `api.moonshot.cn/anthropic/v1/messages` | `/moonshot` |
| SiliconFlow | `api.siliconflow.cn/v1` | ✅ `api.siliconflow.cn/v1/messages` | `/siliconflow` |
| OpenRouter | `openrouter.ai/api/v1` | ✅ `openrouter.ai/api/v1/messages` | `/openrouter` |
| OpenAI | `api.openai.com/v1` | ❌ 无 | `/openai` |
| 智谱 GLM | `open.bigmodel.cn/api/paas/v4` | ❌ 无 | `/zhipu` |
