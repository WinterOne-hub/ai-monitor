import Database from "@tauri-apps/plugin-sql";

export interface AccountRow {
  id: number;
  provider_id: string;
  name: string;
  enabled: number;
  created_at: string;
}

export interface BalanceRow {
  id: number;
  account_id: number;
  balance: number;
  currency: string;
  available: number | null;
  granted: number | null;
  fetched_at: string;
}

export interface DailyUsageRow {
  id: number;
  account_id: number;
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  cost: number;
  source: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  balance REAL NOT NULL,
  currency TEXT DEFAULT 'CNY',
  available REAL,
  granted REAL,
  fetched_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS daily_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_hit_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  cost_estimated REAL DEFAULT 0,
  source TEXT DEFAULT 'manual',
  UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS price_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_price REAL DEFAULT 0,
  output_price REAL DEFAULT 0,
  cache_hit_price REAL DEFAULT 0,
  currency TEXT DEFAULT 'CNY',
  UNIQUE(provider_id, model)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  type TEXT DEFAULT 'balance_low',
  threshold REAL,
  enabled INTEGER DEFAULT 1,
  channels TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 模型单价种子（元/百万 tokens，可在设置中修改）
INSERT OR IGNORE INTO price_table (provider_id, model, input_price, output_price, cache_hit_price, currency) VALUES
('deepseek', 'deepseek-chat', 2.0, 3.0, 0.2, 'CNY'),
('deepseek', 'deepseek-v4-flash', 2.0, 3.0, 0.2, 'CNY'),
('deepseek', 'deepseek-v4-pro', 2.0, 3.0, 0.2, 'CNY');

-- 回填历史费用（按默认 DeepSeek 单价估算历史 proxy 记录）
UPDATE daily_usage
SET cost = (input_tokens - cache_hit_tokens) * 2.0 / 1000000
        + cache_hit_tokens * 0.2 / 1000000
        + output_tokens * 3.0 / 1000000
WHERE cost = 0 AND source = 'proxy' AND date >= date('now', 'localtime', '-30 days');
`;

let db: Database | null = null;

export async function initDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:ai-monitor.db");
  await db.execute(SCHEMA);
  // 老库迁移：补充 cost_estimated 列
  try {
    await db.execute("ALTER TABLE daily_usage ADD COLUMN cost_estimated REAL DEFAULT 0");
  } catch {
    // 列已存在，忽略
  }
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("数据库尚未初始化，请先调用 initDb()");
  return db;
}

// ---------------- accounts ----------------

export async function listAccounts(): Promise<AccountRow[]> {
  const d = getDb();
  return d.select<AccountRow[]>("SELECT * FROM accounts ORDER BY id ASC");
}

export async function addAccount(providerId: string, name: string): Promise<number> {
  const d = getDb();
  // 注意：不能用 SELECT last_insert_rowid()（连接池下可能拿到其他连接的 0），
  // 必须用 execute 返回的 lastInsertId（插件在同一连接内获取）
  const result = await d.execute(
    "INSERT INTO accounts (provider_id, name) VALUES ($1, $2)",
    [providerId, name]
  );
  return result.lastInsertId ?? 0;
}

export async function deleteAccount(id: number): Promise<void> {
  const d = getDb();
  await d.execute("DELETE FROM accounts WHERE id = $1", [id]);
  await d.execute("DELETE FROM balance_snapshots WHERE account_id = $1", [id]);
  await d.execute("DELETE FROM daily_usage WHERE account_id = $1", [id]);
}

export async function setAccountEnabled(id: number, enabled: boolean): Promise<void> {
  const d = getDb();
  await d.execute("UPDATE accounts SET enabled = $1 WHERE id = $2", [enabled ? 1 : 0, id]);
}

// ---------------- balance snapshots ----------------

export interface BalanceInfo {
  balance: number;
  currency: string;
  available?: number;
  granted?: number;
}

export async function saveBalanceSnapshot(accountId: number, info: BalanceInfo): Promise<void> {
  const d = getDb();
  await d.execute(
    "INSERT INTO balance_snapshots (account_id, balance, currency, available, granted) VALUES ($1, $2, $3, $4, $5)",
    [accountId, info.balance, info.currency, info.available ?? null, info.granted ?? null]
  );
}

/** 每个账户的最新余额 */
export async function latestBalances(): Promise<
  { account_id: number; balance: number; currency: string; fetched_at: string }[]
> {
  const d = getDb();
  return d.select<{ account_id: number; balance: number; currency: string; fetched_at: string }[]>(
    `SELECT s.account_id, s.balance, s.currency, s.fetched_at
     FROM balance_snapshots s
     INNER JOIN (
       SELECT account_id, MAX(fetched_at) AS max_at
       FROM balance_snapshots GROUP BY account_id
     ) m ON s.account_id = m.account_id AND s.fetched_at = m.max_at`
  );
}

/** 某账户最近 N 天的余额趋势 */
export async function balanceSeries(accountId: number, days = 30): Promise<BalanceRow[]> {
  const d = getDb();
  return d.select<BalanceRow[]>(
    `SELECT * FROM balance_snapshots
     WHERE account_id = $1 AND fetched_at >= datetime('now', 'localtime', ?)
     ORDER BY fetched_at ASC`,
    [accountId, `-${days} days`]
  );
}

/** 某账户从指定日期起的余额趋势（自定义范围） */
export async function balanceSeriesFrom(accountId: number, startDate: string): Promise<BalanceRow[]> {
  const d = getDb();
  return d.select<BalanceRow[]>(
    `SELECT * FROM balance_snapshots
     WHERE account_id = $1 AND date(fetched_at) >= $2
     ORDER BY fetched_at ASC`,
    [accountId, startDate]
  );
}

// ---------------- daily usage ----------------

export async function upsertDailyUsage(
  accountId: number,
  date: string,
  usage: { input?: number; output?: number; cacheHit?: number; cost?: number; source?: string }
): Promise<void> {
  const d = getDb();
  const existing = await d.select<DailyUsageRow[]>(
    "SELECT * FROM daily_usage WHERE account_id = $1 AND date = $2",
    [accountId, date]
  );
  if (existing.length > 0) {
    const row = existing[0];
    await d.execute(
      `UPDATE daily_usage SET
         input_tokens = input_tokens + $3,
         output_tokens = output_tokens + $4,
         cache_hit_tokens = cache_hit_tokens + $5,
         cost = cost + $6,
         source = $7
       WHERE id = $1`,
      [
        row.id,
        accountId,
        usage.input ?? 0,
        usage.output ?? 0,
        usage.cacheHit ?? 0,
        usage.cost ?? 0,
        usage.source ?? row.source,
      ]
    );
  } else {
    await d.execute(
      `INSERT INTO daily_usage (account_id, date, input_tokens, output_tokens, cache_hit_tokens, cost, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, date, usage.input ?? 0, usage.output ?? 0, usage.cacheHit ?? 0, usage.cost ?? 0, usage.source ?? "manual"]
    );
  }
}

export async function listDailyUsage(accountId: number, days = 30): Promise<DailyUsageRow[]> {
  const d = getDb();
  return d.select<DailyUsageRow[]>(
    `SELECT * FROM daily_usage
     WHERE account_id = $1 AND date >= date('now', 'localtime', ?)
     ORDER BY date ASC`,
    [accountId, `-${days} days`]
  );
}

export async function todayUsageTotal(): Promise<{
  input_tokens: number;
  output_tokens: number;
  cost: number;
  cost_estimated: number;
}> {
  const d = getDb();
  const rows = await d.select<
    { input_tokens: number; output_tokens: number; cost: number; cost_estimated: number }[]
  >(
    `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cost), 0) AS cost,
            COALESCE(SUM(cost_estimated), 0) AS cost_estimated
     FROM daily_usage WHERE date = date('now', 'localtime')`
  );
  return (
    rows[0] ?? { input_tokens: 0, output_tokens: 0, cost: 0, cost_estimated: 0 }
  );
}

/** 今日每个账户的用量与消耗 */
export async function todayUsageByAccount(): Promise<
  {
    account_id: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    cost_estimated: number;
  }[]
> {
  const d = getDb();
  return d.select<
    {
      account_id: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
      cost_estimated: number;
    }[]
  >(
    `SELECT account_id,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cost), 0) AS cost,
            COALESCE(SUM(cost_estimated), 0) AS cost_estimated
     FROM daily_usage
     WHERE date = date('now', 'localtime')
     GROUP BY account_id`
  );
}

/** 最近 N 天各账户用量（跨账户联表） */
export interface RecentUsageRow {
  id: number;
  account_id: number;
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  cost: number;
  source: string;
  account_name: string;
  provider_id: string;
}

export async function listRecentUsage(days = 7): Promise<RecentUsageRow[]> {
  const d = getDb();
  return d.select<RecentUsageRow[]>(
    `SELECT u.id, u.account_id, u.date, u.input_tokens, u.output_tokens, u.cache_hit_tokens,
            u.cost, u.source, a.name AS account_name, a.provider_id
     FROM daily_usage u
     INNER JOIN accounts a ON u.account_id = a.id
     WHERE u.date >= date('now', 'localtime', $1)
     ORDER BY u.date DESC, u.account_id ASC`,
    [`-${days} days`]
  );
}

// ---------------- settings ----------------

export async function getSetting(key: string): Promise<string | null> {
  const d = getDb();
  const rows = await d.select<{ value: string }[]>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length > 0 ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const d = getDb();
  await d.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

// ---------------- price_table --------------

export interface PriceRow {
  id: number;
  provider_id: string;
  model: string;
  input_price: number;
  output_price: number;
  cache_hit_price: number;
  currency: string;
}

export async function listPrices(): Promise<PriceRow[]> {
  const d = getDb();
  return d.select<PriceRow[]>("SELECT * FROM price_table ORDER BY provider_id, model");
}

export async function upsertPrice(p: {
  providerId: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheHitPrice: number;
  currency?: string;
}): Promise<void> {
  const d = getDb();
  await d.execute(
    `INSERT INTO price_table (provider_id, model, input_price, output_price, cache_hit_price, currency)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(provider_id, model) DO UPDATE SET
       input_price = excluded.input_price,
       output_price = excluded.output_price,
       cache_hit_price = excluded.cache_hit_price`,
    [p.providerId, p.model, p.inputPrice, p.outputPrice, p.cacheHitPrice, p.currency ?? "CNY"]
  );
}
