import type { BalanceInfo, Provider } from "./types";

/**
 * Moonshot Kimi — 待验证的余额接口骨架
 * 参考：GET https://api.moonshot.cn/v1/users/me/balance
 * 接口未正式验证前保持 balanceSupported = false，走手动登记兜底。
 */
export const moonshotProvider: Provider = {
  id: "moonshot",
  name: "Kimi (Moonshot)",
  balanceSupported: false,
  docs: "https://platform.moonshot.cn/console",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    // TODO: 验证官方余额接口后实现
    throw new Error("Kimi 余额接口待验证，请使用手动登记模式");
  },
};
