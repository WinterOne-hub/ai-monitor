# 贡献指南 · Contributing

感谢你愿意为 **AI Monitor** 贡献力量！这个项目从设计上就希望"添加一个新平台 = 10 分钟"。

## 10 分钟接入一个新平台

平台适配器统一放在 [`src/providers/`](src/providers/) 目录，每个平台一个文件。

### 1. 实现接口

```ts
// src/providers/example.ts
import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

export const exampleProvider: Provider = {
  id: "example",            // 唯一标识
  name: "示例平台",
  balanceSupported: true,   // 是否有官方余额接口
  docs: "https://docs.example.com/balance",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const data = (await httpGetJson("https://api.example.com/balance", {
      Authorization: `Bearer ${apiKey}`,
    })) as { balance: number };

    return {
      balance: data.balance,
      currency: "CNY",      // CNY / USD
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
```

### 2. 注册

在 [`src/providers/index.ts`](src/providers/index.ts) 中 import 并加入 `providers` 数组。

### 3. 验证

```bash
npm run build        # 类型检查 + 构建
npm run tauri dev    # 启动应用，添加账户测试
```

### 接口约定

- **一律走 `httpGetJson`**（Rust 侧通道，规避 webview CORS），不要直接 `fetch`
- 无官方余额接口的平台：`balanceSupported: false`，`getBalance` 抛错提示手动登记
- 返回 `BalanceInfo`：`balance`（总余额）、`currency`、可选 `available`/`granted`

## 其他贡献方式

- 🐛 提交 [Issue](https://github.com/WinterOne-hub/ai-monitor/issues)（bug / 新平台请求 / 功能建议）
- 🧪 帮忙测试不同平台、不同 macOS/Windows 版本
- 📝 完善文档、翻译

## 开发环境

- Node.js 18+ / npm
- Rust stable（[rustup](https://rustup.rs)）
- macOS 需 Xcode Command Line Tools；Windows 需 [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 自带）

## 代码规范

- TypeScript 严格模式（`vue-tsc` 校验，`npm run build` 会检查）
- Rust 侧保持"薄壳"：窗口/托盘/系统集成；业务逻辑尽量在 TypeScript 层
- 提交信息请遵循语义化（`feat:` / `fix:` / `docs:` ...）
