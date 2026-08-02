import type { BalanceInfo, Provider } from "./types";

/**
 * OpenAI — 无官方稳定余额查询接口
 * （社区 /v1/dashboard/billing 接口非官方且不稳定，不推荐实现）
 * 走手动登记模式。
 */
export const openaiProvider: Provider = {
  id: "openai",
  name: "OpenAI",
  balanceSupported: false,
  docs: "https://platform.openai.com/settings/organization/billing",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    throw new Error("OpenAI 无官方余额接口，请使用手动登记模式");
  },
};
