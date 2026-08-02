import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

interface OpenRouterKeyResponse {
  data?: {
    label?: string;
    usage?: number;
    limit?: number;
    is_free_tier?: boolean;
  };
}

/**
 * OpenRouter 官方密钥信息接口
 * GET https://openrouter.ai/api/v1/auth/key
 * 返回 data.usage（已用）/ data.limit（额度上限），余额 = limit - usage
 */
export const openrouterProvider: Provider = {
  id: "openrouter",
  name: "OpenRouter",
  balanceSupported: true,
  docs: "https://openrouter.ai/docs/api-reference/get-api-key",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const data = (await httpGetJson("https://openrouter.ai/api/v1/auth/key", {
      Authorization: `Bearer ${apiKey}`,
    })) as OpenRouterKeyResponse;

    const info = data.data;
    if (!info) throw new Error("OpenRouter 返回数据异常：无 data");
    if (info.limit === undefined || info.usage === undefined) {
      throw new Error("OpenRouter 返回数据异常：无 limit/usage");
    }

    return {
      balance: Math.max(0, info.limit - info.usage),
      currency: "USD",
      available: info.limit - info.usage,
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
