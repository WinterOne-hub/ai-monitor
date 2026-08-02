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
`;

let db: Database | null = null;

export async function initDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:ai-monitor.db");
  await db.execute(SCHEMA);
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

export async function todayUsageTotal(): Promise<{ input_tokens: number; output_tokens: number; cost: number }> {
  const d = getDb();
  const rows = await d.select<{ input_tokens: number; output_tokens: number; cost: number }[]>(
    `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cost), 0) AS cost
     FROM daily_usage WHERE date = date('now', 'localtime')`
  );
  return rows[0] ?? { input_tokens: 0, output_tokens: 0, cost: 0 };
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
