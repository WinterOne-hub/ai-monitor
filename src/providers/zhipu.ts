import type { BalanceInfo, Provider } from "./types";

/**
 * 智谱 AI (BigModel) — 余额接口骨架
 * 参考：官方控制台 https://open.bigmodel.cn/console
 * 接口待确认，先走手动登记模式。
 */
export const zhipuProvider: Provider = {
  id: "zhipu",
  name: "智谱 AI (GLM)",
  balanceSupported: false,
  docs: "https://open.bigmodel.cn",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    // TODO: 确认官方余额接口后实现
    throw new Error("智谱余额接口待确认，请使用手动登记模式");
  },
};
