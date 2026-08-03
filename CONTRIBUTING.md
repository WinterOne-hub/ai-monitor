# Contributing / 贡献指南

Thank you for considering contributing to **AI Monitor**! The project is designed so that **adding a new platform takes ~10 minutes**.

## Add a New Platform in 10 Minutes / 10 分钟接入一个新平台

Platform adapters live in [`src/providers/`](src/providers/) — one file per platform.

### 1. Implement the interface

```ts
// src/providers/example.ts
import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

export const exampleProvider: Provider = {
  id: "example",            // unique id
  name: "示例平台",
  balanceSupported: true,   // does the platform have an official balance API?
  docs: "https://docs.example.com/balance",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const data = (await httpGetJson("https://api.example.com/balance", {
      Authorization: `Bearer ${apiKey}`,
    })) as { balance: number };

    return {
      balance: data.balance,
      currency: "CNY",      // CNY or USD
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
```

### 2. Register it

Import and add it to the `providers` array in [`src/providers/index.ts`](src/providers/index.ts).

### 3. Verify

```bash
npm run build        # type check + build
npm run tauri dev    # launch and test with a real account
```

### Conventions / 接口约定

- **Always use `httpGetJson`** (Rust channel) for API calls — do NOT use `fetch` directly (avoids webview CORS).
- Platforms **without** an official balance API: set `balanceSupported: false`, `getBalance` should throw a message telling the user to register manually.
- Return `BalanceInfo`: `balance` (total), `currency`, optional `available` / `granted`.

## Other Ways to Contribute / 其他贡献方式

- 🐛 Open an [Issue](https://github.com/WinterOne-hub/ai-monitor/issues) (bug / platform request / feature idea)
- 🧪 Test on different platforms / macOS & Windows versions
- 📝 Improve docs & translations

## Development Environment / 开发环境

- Node.js 18+ / npm
- Rust stable ([rustup](https://rustup.rs))
- macOS: Xcode Command Line Tools; Windows: WebView2 (built-in on Win10/11)

## Code Style / 代码规范

- TypeScript strict mode (`vue-tsc` via `npm run build`)
- Keep the Rust shell **thin** (windows/tray/system integration); business logic in TypeScript
- Use conventional commits (`feat:` / `fix:` / `docs:` ...)
