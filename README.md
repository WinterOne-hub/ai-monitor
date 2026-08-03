# AI Monitor

> A lightweight desktop overlay that monitors AI platform account balances, token usage & spend in real time.
> 桌面灵动岛悬浮卡片：实时监控各 AI 平台账户余额、token 用量与消耗金额。

![Platform](https://img.shields.io/badge/macOS-Windows-blue) ![Tech](https://img.shields.io/badge/Tauri%202-Vue%203-brightgreen) ![License](https://img.shields.io/badge/License-MIT-green)

Built with [Tauri 2](https://tauri.app) — **~6MB installer, ~100MB RAM**. Data stays **100% local**.

---

## ✨ Features / 功能特性

| | Feature | 说明 |
|--|---------|------|
| 🎴 | **Dynamic Island overlay** | Floating capsule on screen; hover to expand (drawer animation), move away to collapse; drag to screen edge to dock as a half-circle |
| 💰 | **Multi-platform balance** | Auto query via official APIs: DeepSeek, Kimi (Moonshot), SiliconFlow, OpenRouter |
| 🔢 | **Token usage tracking** | Built-in local proxy records every API call automatically (OpenAI & Anthropic formats) |
| 💵 | **Accurate spend** | Cost is derived from **balance diff** (real billing), token×price as backup estimate |
| 📊 | **Balance trend chart** | 1-day / 7-day / 30-day / custom range |
| 🚨 | **Alerts** | Low-balance system notifications + Webhook (ServerChan / Feishu / DingTalk / Bark) |
| 🔒 | **Privacy** | API keys encrypted in OS keychain; all data stored locally |

---

## 📦 Installation / 安装

Download from [Releases](https://github.com/WinterOne-hub/ai-monitor/releases):

- **macOS** (Apple Silicon): `AI.Monitor_*.dmg` → open (right-click → Open if unsigned)
- **Windows** 10/11: `AI.Monitor_*.exe` → run installer

Or build from source:

```bash
# Requirements: Node.js 18+, Rust (stable)
npm install
npm run tauri dev      # development
npm run tauri build    # production bundle
```

---

## 🚀 Quick Start / 快速开始

1. Launch the app, open the **Dashboard** (click the island → expand → click ⤢)
2. Go to **Accounts** tab → select a platform → paste your **API Key** → Add
3. Platforms with official balance APIs will show balance automatically
4. The island shows **total balance / today's spend / today's tokens**; hover to expand details per account

---

## 🔌 API Integration / API 接入

### Which platforms can auto-query balance?

| Platform | Balance API | Usage via proxy | Notes |
|----------|:---:|:---:|-------|
| DeepSeek | ✅ official | ✅ | Anthropic + OpenAI formats |
| Kimi (Moonshot) | ✅ official | ✅ | |
| SiliconFlow | ✅ official | ✅ | |
| OpenRouter | ✅ official | ✅ | also has usage API |
| Zhipu GLM | ⚠️ manual | ✅ | balance API TBD |
| OpenAI | ⚠️ manual | ✅ | no public balance API |
| Anthropic | ⚠️ manual | ✅ | |
| Google Gemini | ⚠️ manual | ❌ | needs GCP billing |
| Alibaba / Volcano / Baidu | ⚠️ manual | ✅ | cloud billing based |

> ⚠️ = balance is registered manually via the **"登记余额"** button.

### Proxy Mode: automatic token tracking / 代理模式：自动统计 token

DeepSeek (and most platforms) do **not** expose a public usage API. To get automatic token/spend tracking, route your API calls through the **built-in local proxy**:

```
Proxy base URL (本机代理地址):
  http://127.0.0.1:8899/v1               → DeepSeek (default)
  http://127.0.0.1:8899/moonshot/v1      → Kimi
  http://127.0.0.1:8899/siliconflow/v1   → SiliconFlow
  http://127.0.0.1:8899/openrouter/v1    → OpenRouter
  http://127.0.0.1:8899/openai/v1        → OpenAI
```

The proxy forwards every request to the real API, parses the response `usage`, and records it locally. **Your API key stays the same** — only the base URL changes.

#### OpenAI SDK example (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-real-key",                 # same key, unchanged
    base_url="http://127.0.0.1:8899/v1",        # ← point to AI Monitor proxy
)

resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

#### Anthropic SDK example (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="sk-your-real-key",                 # same key, unchanged
    base_url="http://127.0.0.1:8899/v1",        # ← Anthropic format supported too
)

resp = client.messages.create(
    model="deepseek-chat",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.content[0].text)
```

#### curl example

```bash
curl http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-real-key" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

#### In other tools (e.g. Proma / 其他工具)

Find the **Base URL / API address / 自定义接口** setting and change it to `http://127.0.0.1:8899/v1`. That's it — the app keeps working normally, and every call is recorded automatically.

> 💡 The proxy listens only on `127.0.0.1` (localhost). It does not expose your data to the network.

---

## 📊 How Usage is Calculated / 统计原理

### Single-model platforms vs. aggregator platforms / 单模型平台 vs 聚合平台

The tracking strategy differs by platform type. 不同平台类型的统计方式不同：

| | Single-model platform（单模型平台） | Aggregator platform（聚合平台） |
|---|---|---|
| Example | DeepSeek | SiliconFlow / OpenRouter（一余额多模型） |
| Balance source | Official balance API, **real-time** | API balance is not real-time (coupon/recharge mismatch) |
| Spend method | **Balance diff**（余额差值 = 真实扣费） | **token × model price**（按模型单价估算） |
| Balance display | API value directly | Recharge balance − accumulated estimated spend（动态推算） |
| Model prices | Not needed (balance diff) | **Auto-synced from official site**（每日自动同步全部模型价格） |

**Details / 细节**：

- **Single-model platforms (e.g. DeepSeek)**: the official balance API reflects real-time billing, so **spend = first balance snapshot of the day − last snapshot** (most accurate). Balance is shown directly from the API.
- **Aggregator platforms (e.g. SiliconFlow)**: one recharge balance is shared across many models and the API value doesn't reflect real-time usage. So:
  - **Spend** = Σ (token × model price) — parsed from every proxied request, priced per model (87+ SiliconFlow models auto-synced daily from the official pricing page, manual sync available in Settings).
  - **Displayed balance** = recharge balance − accumulated estimated spend, so it decreases as you consume.
  - If a model has no configured price, its spend is not counted; add prices in Settings → 模型单价.

| Metric | Method | Accuracy |
|--------|--------|----------|
| **Spend (single-model)** | Balance diff | ✅ most accurate |
| **Spend (aggregator)** | token × model price | ✅ good (model-level) |
| **Tokens** | Parsed from every proxied response `usage` | ✅ |

> Model prices can be customized in **Settings → 模型单价** (¥ per million tokens). The estimated cost is stored separately; balance diff takes priority when available.

### Data boundary / 数据边界（重要）

**This app only tracks local activity** — requests that go through the proxy running on the same machine (`127.0.0.1:8899`).

- If you call the same API from another computer, another agent, or a direct connection, **those calls are not counted here**.
- Balance is a platform-level metric: you can install the app on another machine, add the same key, and still see the balance — but per-device token/spend stats are independent.
- All data is stored locally (SQLite) in your app data directory; no cloud sync.

---

## ⚙️ Settings / 设置

- **采集间隔**：how often balance is refreshed (default 30 min)
- **低余额阈值**：low-balance alert threshold
- **统一代理**：pick which account proxy usage is recorded to; view integration examples
- **模型单价**：edit model prices for estimated cost
- **余额告警**：Webhook channel (ServerChan / Feishu / DingTalk / Bark) + test send
- **开机自启**：launch at login

---

## 🛠 Development / 开发

```bash
npm install
npm run tauri dev      # run in dev mode
npm run tauri build    # bundle .dmg / .exe
```

Project layout:

```
src/
  core/        # db / collector / alerts / webhook / proxy client
  providers/   # platform adapters (add a platform = add one file)
  views/       # OverlayApp (island) + DashboardApp
  components/  # BalanceChart (ECharts)
src-tauri/
  src/proxy.rs # local HTTP proxy (axum) — forwards & records usage
```

---

## 🤝 Contributing / 贡献

Adding a new platform takes ~10 minutes — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📄 License / 许可

[MIT](LICENSE)

---

*Made with [Proma](https://proma.cool)*
