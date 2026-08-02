import type { BalanceInfo, Provider } from "./types";

/**
 * Google Gemini — 余额查询走 Google Cloud Billing API（需 GCP 凭据，配置较重）
 * 走手动登记模式。
 */
export const geminiProvider: Provider = {
  id: "gemini",
  name: "Google Gemini",
  balanceSupported: false,
  docs: "https://console.cloud.google.com/billing",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    throw new Error("Gemini 余额需通过 GCP 账单查询，请使用手动登记模式");
  },
};
