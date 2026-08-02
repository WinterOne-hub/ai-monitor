import type { BalanceInfo, Provider } from "./types";

/**
 * 阿里云百炼（通义千问）— 余额走阿里云 BSS OpenAPI（需 AccessKey，配置较重）
 * 走手动登记模式。
 */
export const alibabaBailianProvider: Provider = {
  id: "ali-bailian",
  name: "阿里云百炼 (通义)",
  balanceSupported: false,
  docs: "https://bailian.console.aliyun.com/",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    throw new Error("阿里云百炼余额需通过阿里云账单查询，请使用手动登记模式");
  },
};
