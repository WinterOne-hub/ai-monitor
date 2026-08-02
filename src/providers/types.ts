/**
 * Provider 统一接口规范
 *
 * 新增平台 = 在 src/providers/ 下新建一个文件，实现 Provider 接口，
 * 并在 index.ts 中注册即可。无需改动任何其他代码。
 */
export interface BalanceInfo {
  balance: number;
  currency: string;
  available?: number;
  granted?: number;
  raw?: Record<string, unknown>;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cost?: number;
}

export interface Provider {
  /** 唯一标识，如 'deepseek' */
  id: string;
  /** 展示名称，如 'DeepSeek' */
  name: string;
  /** 是否官方支持余额查询接口 */
  balanceSupported: boolean;
  /** 查询余额（必须） */
  getBalance(apiKey: string): Promise<BalanceInfo>;
  /** 查询某日用量（可选；不支持的平台可省略，走手动登记） */
  getDailyUsage?(apiKey: string, date: string): Promise<UsageInfo | null>;
  /** 文档/备注 */
  docs?: string;
}
