# AI Monitor · AI 用量监控

> 🎯 桌面悬浮卡片，实时监控各 AI 平台账户余额与 token 用量
> 轻量（安装包 ~10MB）· 本地部署 · 开源免费

[English](#english) · [中文](#中文)

---

## 中文

### ✨ 功能特性

- 🎴 **灵动岛悬浮卡片**：屏幕顶部居中胶囊，点击展开/收回，拖到边缘折叠为小半圆
- 💰 **多平台余额监控**：DeepSeek / Kimi / 硅基流动 / OpenRouter 官方接口自动查询；OpenAI / Claude / Gemini 等手动登记
- 📊 **余额趋势图**：30 天余额曲线，直观看到消耗速度
- 🔢 **Token 用量统计**：每日输入/输出 token 登记与汇总，费用估算
- 🚨 **余额告警**：低于阈值触发系统通知 + Webhook（Server酱 / 飞书 / 钉钉 / Bark）
- 🔒 **安全**：API Key 加密存储于系统钥匙串（macOS Keychain / Windows DPAPI）
- ⚡ **轻量**：Tauri 2 构建，安装包 ~10MB，常驻内存 ~100MB

### 📦 安装

| 平台 | 下载 |
|------|------|
| macOS (Intel/Apple Silicon) | [Releases](https://github.com/proma-ai/ai-monitor/releases) 下载 `.dmg` |
| Windows 10/11 | [Releases](https://github.com/proma-ai/ai-monitor/releases) 下载 `.exe` |

> 未签名版本首次打开需右键 → 打开（macOS）或点击"更多信息 → 仍要运行"（Windows）

### 🚀 快速开始

1. 启动应用，主面板添加账户（选择平台，粘贴 API Key）
2. 支持自动查询的平台（DeepSeek/Kimi/SiliconFlow/OpenRouter）立即拉取余额
3. 无官方接口的平台可点击「登记余额」手动记录
4. 悬浮卡片实时显示余额与今日用量；拖到屏幕边缘即收纳

### 🧩 支持平台

| 平台 | 余额自动查询 | 说明 |
|------|:---:|------|
| DeepSeek | ✅ | 官方接口 |
| Kimi (Moonshot) | ✅ | 官方接口 |
| 硅基流动 SiliconFlow | ✅ | 官方接口 |
| OpenRouter | ✅ | 官方接口 |
| 智谱 GLM | ⚠️ | 待接入，手动登记 |
| OpenAI | ⚠️ | 无官方余额接口，手动登记 |
| Anthropic Claude | ⚠️ | 无公开接口，手动登记 |
| Google Gemini | ⚠️ | 需 GCP 账单，手动登记 |
| 阿里百炼 / 火山方舟 / 百度千帆 | ⚠️ | 云计费体系，手动登记 |

### 🛠 开发

```bash
# 环境要求：Node.js 18+、Rust stable
npm install
npm run tauri dev      # 开发运行
npm run tauri build    # 打包（macOS .dmg / Windows .exe）
```

### 🤝 贡献

欢迎贡献新平台适配器！详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 📄 License

[MIT](LICENSE)

---

## English

**AI Monitor** — A lightweight desktop overlay that monitors AI platform account balances & token usage in real time.

### Features

- Dynamic-Island style floating capsule (click to expand, drag to edge to collapse)
- Auto balance query: DeepSeek / Kimi / SiliconFlow / OpenRouter (official APIs)
- Manual balance registration for OpenAI / Claude / Gemini etc.
- 30-day balance trend chart, daily token usage stats, cost estimation
- Low-balance alerts: system notification + Webhook (ServerChan / Feishu / DingTalk / Bark)
- API keys encrypted in OS keychain
- Built with Tauri 2 — ~10MB installer, ~100MB RAM

### Install

Download from [Releases](https://github.com/proma-ai/ai-monitor/releases) (`.dmg` for macOS, `.exe` for Windows).

### Development

```bash
npm install
npm run tauri dev
npm run tauri build
```

### License

[MIT](LICENSE)
