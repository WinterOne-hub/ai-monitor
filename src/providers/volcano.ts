import type { BalanceInfo, Provider } from "./types";

/**
 * 火山方舟（豆包）— 余额走火山引擎账户体系（需 AccessKey，配置较重）
 * 走手动登记模式。
 */
export const volcanoArkProvider: Provider = {
  id: "volcano-ark",
  name: "火山方舟 (豆包)",
  balanceSupported: false,
  docs: "https://console.volcengine.com/ark",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    throw new Error("火山方舟余额需通过火山引擎账单查询，请使用手动登记模式");
  },
};
