import type { BalanceInfo, Provider } from "./types";

/**
 * DeepSeek 官方余额接口
 * GET https://api.deepseek.com/user/balance
 * Authorization: Bearer <API_KEY>
 */
export const deepseekProvider: Provider = {
  id: "deepseek",
  name: "DeepSeek",
  balanceSupported: true,
  docs: "https://api-docs.deepseek.com/zh-cn/api/get-user-balance",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const resp = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      throw new Error(`DeepSeek 余额查询失败 (${resp.status}): ${await safeText(resp)}`);
    }
    const data = (await resp.json()) as {
      is_available: boolean;
      balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[];
    };
    if (!data.is_available) throw new Error("DeepSeek 账户不可用");
    const info = data.balance_infos?.[0];
    if (!info) throw new Error("DeepSeek 返回数据异常：无 balance_infos");

    return {
      balance: parseFloat(info.total_balance),
      currency: info.currency || "CNY",
      available: parseFloat(info.topped_up_balance),
      granted: parseFloat(info.granted_balance),
      raw: data as unknown as Record<string, unknown>,
    };
  },
};

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "";
  }
}
