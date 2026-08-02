import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

interface SiliconFlowUserInfoResponse {
  code?: number;
  data?: {
    id?: string;
    name?: string;
    balance?: string | number;
  };
}

/**
 * 硅基流动 SiliconFlow 官方用户信息接口
 * GET https://api.siliconflow.cn/v1/user/info
 * 返回 data.balance（余额）
 */
export const siliconflowProvider: Provider = {
  id: "siliconflow",
  name: "硅基流动 SiliconFlow",
  balanceSupported: true,
  docs: "https://docs.siliconflow.cn/cn/api-reference/user/get-user-info",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const data = (await httpGetJson("https://api.siliconflow.cn/v1/user/info", {
      Authorization: `Bearer ${apiKey}`,
    })) as SiliconFlowUserInfoResponse;

    const info = data.data;
    if (!info) throw new Error("硅基流动返回数据异常：无 data");
    if (info.balance === undefined) throw new Error("硅基流动返回数据异常：无 balance");

    return {
      balance: typeof info.balance === "number" ? info.balance : parseFloat(info.balance as string),
      currency: "CNY",
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
