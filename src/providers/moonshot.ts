import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

interface MoonshotBalanceResponse {
  code?: number;
  status?: boolean;
  data?: {
    available_balance?: number;
    voucher_balance?: number;
    cash_balance?: number;
    currency?: string;
  };
}

/**
 * Moonshot Kimi 官方余额接口
 * GET https://api.moonshot.cn/v1/users/me/balance
 * 返回 data.available_balance（可用余额）
 */
export const moonshotProvider: Provider = {
  id: "moonshot",
  name: "Kimi (Moonshot)",
  balanceSupported: true,
  docs: "https://platform.moonshot.cn/docs",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const data = (await httpGetJson("https://api.moonshot.cn/v1/users/me/balance", {
      Authorization: `Bearer ${apiKey}`,
    })) as MoonshotBalanceResponse;

    const info = data.data;
    if (!info) throw new Error("Moonshot 返回数据异常：无 data");

    const balance =
      info.available_balance ??
      (typeof info.cash_balance === "number" && typeof info.voucher_balance === "number"
        ? info.cash_balance + info.voucher_balance
        : undefined);

    if (balance === undefined) throw new Error("Moonshot 返回数据异常：无余额字段");

    return {
      balance,
      currency: info.currency || "CNY",
      available: info.cash_balance,
      granted: info.voucher_balance,
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
