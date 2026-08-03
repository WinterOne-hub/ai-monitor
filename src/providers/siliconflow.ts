import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

interface SiliconFlowUserInfoResponse {
  code?: number;
  data?: {
    id?: string;
    name?: string;
    balance?: string | number; // 代金券余额（不可直接使用）
    chargeBalance?: string | number; // 充值余额（实际可用）
    totalBalance?: string | number; // 名义总余额
  };
}

/**
 * 硅基流动 SiliconFlow 官方用户信息接口
 * GET https://api.siliconflow.cn/v1/user/info
 * 注意：balance 为代金券（不可用），实际可用余额是 chargeBalance（充值余额）
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
    if (info.chargeBalance === undefined && info.balance === undefined) {
      throw new Error("硅基流动返回数据异常：无余额字段");
    }

    const toNum = (v: string | number | undefined): number | undefined =>
      typeof v === "number" ? v : v !== undefined ? parseFloat(v) : undefined;

    // 实际可用 = 充值余额 chargeBalance；代金券 balance 仅作参考
    const usable = toNum(info.chargeBalance);
    const granted = toNum(info.balance);
    const total = toNum(info.totalBalance);

    return {
      balance: usable ?? total ?? granted ?? 0,
      currency: "CNY",
      available: usable,
      granted,
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
