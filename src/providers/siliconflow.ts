import type { BalanceInfo, Provider } from "./types";

/**
 * 硅基流动 SiliconFlow — 余额接口骨架
 * 参考：GET https://api.siliconflow.cn/v1/user/info（返回余额）
 * 待接入验证。
 */
export const siliconflowProvider: Provider = {
  id: "siliconflow",
  name: "硅基流动 SiliconFlow",
  balanceSupported: false,
  docs: "https://cloud.siliconflow.cn",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    // TODO: 接入 /v1/user/info 后实现
    throw new Error("硅基流动余额接口待接入，请使用手动登记模式");
  },
};
