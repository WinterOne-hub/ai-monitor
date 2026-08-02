import type { BalanceInfo, Provider } from "./types";

/**
 * 百度千帆（文心）— 余额走百度智能云计费体系（配置较重）
 * 走手动登记模式。
 */
export const baiduQianfanProvider: Provider = {
  id: "baidu-qianfan",
  name: "百度千帆 (文心)",
  balanceSupported: false,
  docs: "https://console.bce.baidu.com/qianfan",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    throw new Error("百度千帆余额需通过百度智能云账单查询，请使用手动登记模式");
  },
};
