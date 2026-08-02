import type { BalanceInfo, Provider } from "./types";

/**
 * Anthropic Claude — 无公开余额查询接口（企业版 Admin API 除外）
 * 走手动登记模式。
 */
export const anthropicProvider: Provider = {
  id: "anthropic",
  name: "Anthropic Claude",
  balanceSupported: false,
  docs: "https://console.anthropic.com/settings/billing",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    throw new Error("Anthropic 无公开余额接口，请使用手动登记模式");
  },
};
