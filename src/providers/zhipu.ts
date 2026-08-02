import type { BalanceInfo, Provider } from "./types";

/**
 * 智谱 AI (BigModel) — 余额接口待确认
 * 官方控制台有余额展示，暂未找到稳定公开 API，先走手动登记。
 */
export const zhipuProvider: Provider = {
  id: "zhipu",
  name: "智谱 AI (GLM)",
  balanceSupported: false,
  docs: "https://open.bigmodel.cn/console",

  async getBalance(_apiKey: string): Promise<BalanceInfo> {
    // TODO: 确认官方余额接口后实现
    throw new Error("智谱余额接口待确认，请使用手动登记模式");
  },
};
