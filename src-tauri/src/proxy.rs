//! 统一代理模式：本地 HTTP 服务，转发 OpenAI 兼容请求到上游平台，
//! 自动解析每次 chat/completions 响应的 usage 并记入 daily_usage 表。
//! 采用 catch-all 路由：所有 /v1/* 与 /{provider}/v1/* 路径均透传。
//!
//! 关键改进：
//! - 流式响应：SSE 边收边转发（不再缓冲整个响应），同时增量解析 usage；
//! - 共享 SQLite 池 + WAL：代理落库复用长连接，避免每请求新建连接；
//! - Anthropic 流式 usage 合并（message_start 记 input / message_delta 记 output）；
//! - 移除通配 CORS；可选 x-proxy-secret 鉴权（默认关闭）。

use std::{
    pin::Pin,
    sync::{Arc, RwLock},
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderValue, Method, Request, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use futures_util::Stream;
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use tauri::{Emitter, Manager};

pub const PROXY_PORT: u16 = 8899;
const EVENT_CACHE_TTL: Duration = Duration::from_secs(24 * 3600);

#[derive(Clone)]
struct ProxyState {
    client: reqwest::Client,
    db: SqlitePool,
    secret: Arc<RwLock<String>>,
    app_handle: tauri::AppHandle,
}

/// 由 start() 托管到 app state，供命令运行时热更新代理密钥（无需重启）
pub struct ProxySecretHandle(pub Arc<RwLock<String>>);
/// 由 start() 托管，供命令持久化代理密钥设置
pub struct ProxyDbHandle(pub SqlitePool);

/// OpenAI 兼容平台 -> 上游 base 地址
fn upstream_base(provider: &str) -> Option<&'static str> {
    match provider {
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "moonshot" => Some("https://api.moonshot.cn/v1"),
        "siliconflow" => Some("https://api.siliconflow.cn/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "openai" => Some("https://api.openai.com/v1"),
        "zhipu" => Some("https://open.bigmodel.cn/api/paas/v4"),
        _ => None,
    }
}

/// Anthropic 兼容端点（/v1/messages 格式）
/// 注意：siliconflow 官方 Anthropic 兼容端点与 OpenAI 兼容端点同根（/v1/messages）
fn upstream_anthropic(provider: &str) -> Option<&'static str> {
    match provider {
        "deepseek" => Some("https://api.deepseek.com/anthropic/v1/messages"),
        "moonshot" => Some("https://api.moonshot.cn/anthropic/v1/messages"),
        "siliconflow" => Some("https://api.siliconflow.cn/v1/messages"),
        "openrouter" => Some("https://openrouter.ai/api/v1/messages"),
        _ => None,
    }
}

/// 启动本地代理（在 tauri async runtime 中常驻）
pub fn start(app: tauri::AppHandle) {
    let db_path = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("ai-monitor.db");

    tauri::async_runtime::spawn(async move {
        let opts = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let db = match SqlitePoolOptions::new().max_connections(4).connect_with(opts).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[proxy] SQLite 连接失败: {e}");
                return;
            }
        };
        if let Err(e) = migrate(&db).await {
            eprintln!("[proxy] 数据库迁移失败: {e}");
            return;
        }

        let secret = load_secret(&db).await;
        let secret_arc = Arc::new(RwLock::new(secret));
        app.manage(ProxySecretHandle(secret_arc.clone()));
        app.manage(ProxyDbHandle(db.clone()));
        let state = ProxyState {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .expect("failed to build http client"),
            db,
            secret: secret_arc,
            app_handle: app.clone(),
        };

        // 历史事件清理任务（每天一次）
        let cleanup_db = state.db.clone();
        tauri::async_runtime::spawn(async move {
            let _ = cleanup_event_history(&cleanup_db).await;
            let _ = cleanup_balance_history(&cleanup_db).await;
            loop {
                tokio::time::sleep(EVENT_CACHE_TTL).await;
                let _ = cleanup_event_history(&cleanup_db).await;
                let _ = cleanup_balance_history(&cleanup_db).await;
            }
        });

        let router = Router::new()
            .route("/v1/{*rest}", any(handle_default_catch))
            .route("/{provider}/v1/{*rest}", any(handle_provider_catch))
            .with_state(state.clone());

        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PROXY_PORT)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[proxy] 绑定端口 {PROXY_PORT} 失败（可能已被占用）: {e}");
                return;
            }
        };
        eprintln!("[proxy] 本地代理已启动 http://127.0.0.1:{PROXY_PORT}/v1");
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[proxy] 服务退出: {e}");
        }
    });
}

// ---------------- 迁移与清理 ----------------

/// 建表（幂等）+ 索引进度，保证代理先于前端 initDb 也能安全落库
async fn migrate(db: &SqlitePool) -> Result<(), sqlx::Error> {
    for stmt in [
        "CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )",
        "CREATE TABLE IF NOT EXISTS balance_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          balance REAL NOT NULL,
          currency TEXT DEFAULT 'CNY',
          available REAL,
          granted REAL,
          fetched_at TEXT DEFAULT (datetime('now', 'localtime'))
        )",
        "CREATE TABLE IF NOT EXISTS daily_usage (
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
        )",
        "CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          model TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cost_estimated REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )",
        "CREATE TABLE IF NOT EXISTS price_table (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          input_price REAL DEFAULT 0,
          output_price REAL DEFAULT 0,
          cache_hit_price REAL DEFAULT 0,
          currency TEXT DEFAULT 'CNY',
          UNIQUE(provider_id, model)
        )",
        "CREATE TABLE IF NOT EXISTS alert_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER,
          type TEXT DEFAULT 'balance_low',
          threshold REAL,
          enabled INTEGER DEFAULT 1,
          channels TEXT DEFAULT '[]'
        )",
        "CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        )",
        "CREATE INDEX IF NOT EXISTS idx_usage_events_acc_time ON usage_events (account_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_balance_acc_time ON balance_snapshots (account_id, fetched_at)",
        "CREATE INDEX IF NOT EXISTS idx_daily_acc_date ON daily_usage (account_id, date)",
    ] {
        if let Err(e) = sqlx::query(stmt).execute(db).await {
            return Err(e);
        }
    }

    // 模型单价种子（元/百万 tokens）
    for (provider, model, inp, out, cache) in [
        ("deepseek", "deepseek-chat", 2.0, 3.0, 0.2),
        ("deepseek", "deepseek-v4-flash", 2.0, 3.0, 0.2),
        ("deepseek", "deepseek-v4-pro", 2.0, 3.0, 0.2),
    ] {
        sqlx::query(
            "INSERT OR IGNORE INTO price_table (provider_id, model, input_price, output_price, cache_hit_price, currency)
             VALUES (?1, ?2, ?3, ?4, ?5, 'CNY')",
        )
        .bind(provider)
        .bind(model)
        .bind(inp)
        .bind(out)
        .bind(cache)
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn load_secret(db: &SqlitePool) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'proxy_secret'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// 运行时热更新代理密钥：持久化到 settings 表并立即替换内存中的密钥（无需重启代理）
pub async fn set_proxy_secret(app: &tauri::AppHandle, secret: String) -> Result<(), String> {
    {
        let db = app.state::<ProxyDbHandle>();
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ('proxy_secret', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
        )
        .bind(&secret)
        .execute(&db.0)
        .await
        .map_err(|e| format!("保存代理密钥失败: {e}"))?;
    }
    {
        let h = app.state::<ProxySecretHandle>();
        let mut s = h.0.write().unwrap_or_else(|e| e.into_inner());
        *s = secret;
    }
    Ok(())
}

/// 清理超过 90 天的 usage_events（避免无限增长）
async fn cleanup_event_history(db: &SqlitePool) -> Result<u64, sqlx::Error> {
    let r = sqlx::query("DELETE FROM usage_events WHERE created_at < datetime('now','localtime','-90 days')")
        .execute(db)
        .await?;
    Ok(r.rows_affected())
}

/// 旧余额快照按日聚合：超过 90 天的明细折叠为每天一条（保留当日最后一条），
/// 避免 balance_snapshots 随时间无限增长。
async fn cleanup_balance_history(db: &SqlitePool) -> Result<u64, sqlx::Error> {
    let r = sqlx::query(
        "DELETE FROM balance_snapshots
         WHERE fetched_at < datetime('now','localtime','-90 days')
           AND id NOT IN (
             SELECT MAX(id) FROM balance_snapshots
             WHERE fetched_at < datetime('now','localtime','-90 days')
             GROUP BY account_id, date(fetched_at)
           )",
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

// ---------------- HTTP handlers ----------------

async fn handle_default_catch(
    State(st): State<ProxyState>,
    Path(rest): Path<String>,
    req: Request<Body>,
) -> Response {
    handle_catch(st, "deepseek".to_string(), rest, req).await
}

async fn handle_provider_catch(
    State(st): State<ProxyState>,
    Path((provider, rest)): Path<(String, String)>,
    req: Request<Body>,
) -> Response {
    handle_catch(st, provider, rest, req).await
}

async fn handle_catch(st: ProxyState, provider: String, rest: String, req: Request<Body>) -> Response {
    // 可选鉴权：设置 proxy_secret 后，所有请求必须带 x-proxy-secret 头
    let secret = st.secret.read().unwrap_or_else(|e| e.into_inner()).clone();
    if !secret.is_empty() {
        let provided = req
            .headers()
            .get("x-proxy-secret")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if provided != secret {
            return json_response(
                StatusCode::FORBIDDEN,
                r#"{"error":{"message":"invalid or missing x-proxy-secret","type":"authentication_error"}}"#,
            );
        }
    }

    let is_messages = rest == "messages";
    let upstream = if is_messages {
        match upstream_anthropic(&provider) {
            Some(u) => u.to_string(),
            None => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &format!(
                        r#"{{"error":{{"message":"{provider} 暂不支持 Anthropic 格式","type":"invalid_request_error"}}}}"#
                    ),
                )
            }
        }
    } else {
        let Some(base) = upstream_base(&provider) else {
            return json_response(
                StatusCode::BAD_REQUEST,
                &format!(
                    r#"{{"error":{{"message":"不支持的平台: {provider}","type":"invalid_request_error"}}}}"#
                ),
            );
        };
        format!("{base}/{rest}")
    };

    let method = req.method().clone();
    let headers = req.headers().clone();
    // 提取 API Key（用于账户匹配记账）
    let api_key = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_start_matches("Bearer ").trim().to_string())
        .or_else(|| {
            headers
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();
    eprintln!("[proxy] {method} /{provider}/v1/{rest} -> {upstream}");

    // 读取 body（仅带 body 的方法）
    let mut body_bytes = if method == Method::POST || method == Method::PUT || method == Method::PATCH {
        match axum::body::to_bytes(req.into_body(), 64 * 1024 * 1024).await {
            Ok(b) => b.to_vec(),
            Err(_) => {
                return json_response(StatusCode::BAD_REQUEST, "{\"error\":{\"message\":\"读取请求体失败\"}}")
            }
        }
    } else {
        Vec::new()
    };
    let is_stream = String::from_utf8_lossy(&body_bytes).contains("\"stream\":true");

    // OpenAI 流式：注入 stream_options.include_usage 补齐 usage 数据
    body_bytes = inject_stream_options(&provider, &rest, is_stream, body_bytes);
    // 从（注入后的）请求体提取 model（用于价格匹配）
    let model = serde_json::from_slice::<Value>(&body_bytes)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()));

    // 透传全部请求头（含 x-api-key / anthropic-version 等），落掉 host 与代理鉴权头
    let mut rb = st.client.request(method.clone(), &upstream);
    for (name, value) in headers.iter() {
        if name != "host" && name != "x-proxy-secret" {
            rb = rb.header(name, value);
        }
    }
    if !body_bytes.is_empty() {
        rb = rb.body(body_bytes);
    }

    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[proxy] 上游请求失败: {e}");
            return json_response(StatusCode::BAD_GATEWAY, "{\"error\":{\"message\":\"上游请求失败\"}}");
        }
    };

    let status = resp.status();
    let ct = resp.headers().get("content-type").cloned();
    let is_sse = ct
        .as_ref()
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("text/event-stream"))
        .unwrap_or(false);

    // 仅 chat/completions 与 messages 的成功响应记账
    if status.is_success() && method == Method::POST && (rest == "chat/completions" || is_messages) {
        if is_sse {
            // 流式：边转发边增量解析 usage，流结束后统一记账
            let tap = UsageTap::new(
                Box::pin(resp.bytes_stream()),
                st.clone(),
                provider.clone(),
                api_key.clone(),
                model.clone(),
                is_messages,
            );
            return streaming_response(status, ct, tap);
        }
        // 非流式：缓冲后解析 usage
        let bytes = match resp.bytes().await {
            Ok(b) => b.to_vec(),
            Err(_) => {
                return json_response(StatusCode::BAD_GATEWAY, "{\"error\":{\"message\":\"读取上游响应失败\"}}")
            }
        };
        let usage = parse_usage_from_json(&bytes);
        if let Some(u) = usage {
            record_usage_to_db(&st, &provider, &api_key, model.as_deref(), u).await;
        }
        return build_response(status, ct, bytes);
    }

    // 非记账路径：优先流式透传（如 /v1/models 之类，或 SSE 的错误排查）
    if is_sse {
        return streaming_response(status, ct, resp.bytes_stream());
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => {
            return json_response(StatusCode::BAD_GATEWAY, "{\"error\":{\"message\":\"读取上游响应失败\"}}")
        }
    };
    build_response(status, ct, bytes)
}

/// OpenAI 平台流式请求自动补充 stream_options.include_usage
/// （否则 OpenRouter / SiliconFlow / Moonshot 等平台不会在流中返回 usage，导致漏记）
///
/// 注意：Anthropic 协议（/v1/messages）不走此逻辑，其 usage 由 message_start/message_delta 携带。
/// 只对 OpenAI 兼容平台的 chat/completions 生效，避免改坏其它端点。
fn inject_stream_options(provider: &str, rest: &str, is_stream: bool, body: Vec<u8>) -> Vec<u8> {
    // OpenAI 兼容平台：deepseek / openai / openrouter / siliconflow / moonshot / zhipu
    const OPENAI_COMPAT: &[&str] = &[
        "deepseek",
        "openai",
        "openrouter",
        "siliconflow",
        "moonshot",
        "zhipu",
    ];
    if !OPENAI_COMPAT.contains(&provider) || !is_stream || rest != "chat/completions" || body.is_empty()
    {
        return body;
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(mut v) => {
            if v.get("stream_options").is_none() {
                v["stream_options"] = serde_json::json!({ "include_usage": true });
                return serde_json::to_vec(&v).unwrap_or(body);
            }
            body
        }
        Err(_) => body,
    }
}

// ---------------- SSE 增量解析与流式转发 ----------------

/// 包装上游 bytes 流：边转发边增量解析 SSE usage，流结束后统一记账
struct UsageTap {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    st: ProxyState,
    provider: String,
    api_key: String,
    model: Option<String>,
    parser: SseParser,
    record_done: bool,
}

impl UsageTap {
    fn new(
        inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
        st: ProxyState,
        provider: String,
        api_key: String,
        model: Option<String>,
        is_messages: bool,
    ) -> Self {
        let parser = SseParser::new(is_messages);
        Self {
            inner,
            st,
            provider,
            api_key,
            model,
            parser,
            record_done: false,
        }
    }
}

impl Stream for UsageTap {
    type Item = Result<Bytes, reqwest::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut this = self.as_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(bytes))) => {
                this.parser.feed(&bytes);
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e))),
            Poll::Ready(None) => {
                if !this.record_done {
                    this.record_done = true;
                    if let Some(usage) = this.parser.usage_listener.take() {
                        let st = this.st.clone();
                        let provider = this.provider.clone();
                        let api_key = this.api_key.clone();
                        let model = this.model.clone();
                        tauri::async_runtime::spawn(async move {
                            record_usage_to_db(&st, &provider, &api_key, model.as_deref(), usage).await;
                        });
                    }
                }
                Poll::Ready(None)
            }
        }
    }
}

/// 增量解析 SSE（处理跨 chunk 边界），支持 OpenAI 单次 usage 与 Anthropic 分段合并
struct SseParser {
    buf: Vec<u8>,
    is_messages: bool,
    usage_listener: Option<UsageInfo>,
}

impl SseParser {
    fn new(is_messages: bool) -> Self {
        Self {
            buf: Vec::new(),
            is_messages,
            usage_listener: None,
        }
    }

    fn feed(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        loop {
            let nl = self.buf.iter().position(|&b| b == b'\n');
            match nl {
                Some(pos) => {
                    let line = self.buf[..pos].to_vec();
                    self.buf.drain(..pos + 1);
                    self.process_line(&line);
                }
                None => break,
            }
        }
    }

    fn process_line(&mut self, line: &[u8]) {
        let line = trim_ascii(line);
        let Some(data) = strip_prefix(line, b"data:") else {
            return;
        };
        let data = trim_ascii(data);
        if data == b"[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_slice::<Value>(data) else {
            return;
        };
        // usage 位置：OpenAI 在顶层；Anthropic message_start 在 message.usage；
        // message_delta 在顶层 usage。
        let usage = v
            .get("usage")
            .or_else(|| v.get("message").and_then(|m| m.get("usage")));
        if let Some(u) = usage.and_then(parse_usage_value) {
            self.merge(u);
        }
    }

    /// OpenAI 流只在末尾带完整 usage：整体覆盖取最后一次；
    /// Anthropic 流 input 在 message_start、output 在 message_delta：按字段合并。
    fn merge(&mut self, u: UsageInfo) {
        match &mut self.usage_listener {
            Some(acc) => {
                if self.is_messages {
                    if u.input > 0 {
                        acc.input = u.input;
                    }
                    if u.output > 0 {
                        acc.output = u.output;
                    }
                    if u.cache_hit > 0 {
                        acc.cache_hit = u.cache_hit;
                    }
                } else {
                    *acc = u;
                }
            }
            slot @ None => *slot = Some(u),
        }
    }
}

fn trim_ascii(mut s: &[u8]) -> &[u8] {
    while s.first().is_some_and(|&b| b == b' ' || b == b'\r' || b == b'\t') {
        s = &s[1..];
    }
    while s.last().is_some_and(|&b| b == b' ' || b == b'\r' || b == b'\t') {
        s = &s[..s.len() - 1];
    }
    s
}

fn strip_prefix<'a>(s: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    s.strip_prefix(prefix)
}

// ---------------- usage 解析 ----------------

struct UsageInfo {
    input: i64,
    output: i64,
    cache_hit: i64,
}

fn parse_usage_from_json(bytes: &[u8]) -> Option<UsageInfo> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    v.get("usage").and_then(parse_usage_value)
}

fn parse_usage_value(u: &Value) -> Option<UsageInfo> {
    // OpenAI 格式：prompt_tokens / completion_tokens
    if let Some(input) = u.get("prompt_tokens").and_then(|v| v.as_i64()) {
        let output = u
            .get("completion_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_hit = u
            .get("prompt_cache_hit_tokens")
            .and_then(|v| v.as_i64())
            .or_else(|| {
                u.get("prompt_tokens_details")
                    .and_then(|d| d.get("cached_tokens"))
                    .and_then(|v| v.as_i64())
            })
            .unwrap_or(0)
            .min(input); // 防御：缓存命中不可能超过输入 token
        return Some(UsageInfo {
            input,
            output,
            cache_hit,
        });
    }
    // Anthropic 格式：input_tokens / output_tokens / cache
    if let Some(input) = u.get("input_tokens").and_then(|v| v.as_i64()) {
        let output = u
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        // 只计「本次读取的缓存」cache_read_input_tokens。
        // 注意：cache_creation_input_tokens 在部分平台（如 DeepSeek Anthropic 兼容端点）
        // 会被实现为「会话级累计值」而非本次增量，若计入会导致 cache_hit 异常放大、费用为负。
        let cache_hit = u
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .min(input); // 防御：缓存命中不可能超过输入 token
        return Some(UsageInfo {
            input,
            output,
            cache_hit,
        });
    }
    None
}

// ---------------- 记账 ----------------

/// 默认单价（元/百万 tokens），可被 price_table 覆盖
fn default_prices(provider: &str) -> (f64, f64, f64) {
    match provider {
        "deepseek" => (2.0, 3.0, 0.2), // 输入/输出/缓存命中
        _ => (0.0, 0.0, 0.0),
    }
}

async fn record_usage_to_db(st: &ProxyState, provider: &str, api_key: &str, model: Option<&str>, u: UsageInfo) {
    let pool = &st.db;

    // 1. 按「平台 + API Key」自动匹配账户（多账户分流）
    let mut account_id: Option<i64> = None;
    let acc_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE provider_id = ?1 AND enabled = 1",
    )
    .bind(provider)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if !api_key.is_empty() {
        for acc_id in acc_ids {
            if let Ok(entry) = keyring::Entry::new("ai-monitor", &acc_id.to_string()) {
                if let Ok(stored) = entry.get_password() {
                    if stored == api_key {
                        account_id = Some(acc_id);
                        break;
                    }
                }
            }
        }
    }

    // 2. 未匹配到 -> 使用默认记账账户
    if account_id.is_none() {
        account_id = sqlx::query_scalar("SELECT value FROM settings WHERE key='proxy_account_id'")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .and_then(|v: String| v.parse().ok());
    }

    // 3. 仍未匹配到：记账丢失，打日志提示用户（token 统计静默丢失是最难发现的 bug）
    let Some(account_id) = account_id else {
        eprintln!(
            "[proxy] ⚠️ 记账失败：{provider} 请求的 API Key 未匹配到任何已启用账户，且未设置默认记账账户（proxy_account_id）。请求将被转发但 token/费用不会统计。请到设置页选择默认记账账户。"
        );
        return;
    };

    // 查模型单价（精确匹配，未配置则用默认）
    let (mut input_price, mut output_price, mut cache_hit_price) = default_prices(provider);
    if let Some(model) = model {
        if let Ok(Some((i, o, c))) = sqlx::query_as::<_, (f64, f64, f64)>(
            "SELECT input_price, output_price, cache_hit_price FROM price_table WHERE provider_id = ?1 AND model = ?2",
        )
        .bind(provider)
        .bind(model)
        .fetch_optional(pool)
        .await
        {
            input_price = i;
            output_price = o;
            cache_hit_price = c;
        }
    }

    // 费用 = token * 单价 / 1M（估算值，写入 cost_estimated；
    // cost 列由「余额差值」同步为真实消耗）
    let cost_estimated = (((u.input - u.cache_hit) as f64 * input_price / 1_000_000.0
        + u.cache_hit as f64 * cache_hit_price / 1_000_000.0
        + u.output as f64 * output_price / 1_000_000.0)
        * 1000.0)
        .round()
        / 1000.0;

    let _ = sqlx::query(
        "INSERT INTO daily_usage (account_id, date, input_tokens, output_tokens, cache_hit_tokens, cost, cost_estimated, source)
         VALUES (?1, date('now','localtime'), ?2, ?3, ?4, ?5, ?5, 'proxy')
         ON CONFLICT(account_id, date) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,
           cost_estimated = cost_estimated + excluded.cost_estimated,
           cost = daily_usage.cost + excluded.cost,
           source = 'proxy'",
    )
    .bind(account_id)
    .bind(u.input)
    .bind(u.output)
    .bind(u.cache_hit)
    .bind(cost_estimated)
    .execute(pool)
    .await;

    // 记录调用事件（保留分钟级时间粒度）
    let _ = sqlx::query(
        "INSERT INTO usage_events (account_id, model, input_tokens, output_tokens, cost_estimated)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(account_id)
    .bind(model)
    .bind(u.input)
    .bind(u.output)
    .bind(cost_estimated)
    .execute(pool)
    .await;

    // 通知前端刷新用量显示
    let _ = st.app_handle.emit("usage-updated", ());
}

// ---------------- 响应构建 ----------------

fn build_response(status: StatusCode, ct: Option<HeaderValue>, body: Vec<u8>) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(ct) = ct {
        builder = builder.header("content-type", ct);
    }
    builder.body(Body::from(body)).unwrap()
}

/// 流式响应：透传上游 SSE，不带通配 CORS 头
fn streaming_response<S>(status: StatusCode, ct: Option<HeaderValue>, stream: S) -> Response
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    let mut builder = Response::builder().status(status);
    if let Some(ct) = ct {
        builder = builder.header("content-type", ct);
    }
    builder.body(Body::from_stream(stream)).unwrap()
}

fn json_response(status: StatusCode, body: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openai_line(input: i64, output: i64, cache: i64) -> Vec<u8> {
        format!(
            "data: {{\"usage\":{{\"prompt_tokens\":{input},\"completion_tokens\":{output},\"prompt_cache_hit_tokens\":{cache}}}}}\n\n",
            input = input, output = output, cache = cache
        )
        .into_bytes()
    }

    fn anthropic_start(input: i64, cache: i64) -> Vec<u8> {
        format!(
            "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":{input},\"cache_read_input_tokens\":{cache},\"cache_creation_input_tokens\":99999999}}}}}}\n\n",
            input = input, cache = cache
        )
        .into_bytes()
    }

    fn anthropic_delta(output: i64) -> Vec<u8> {
        format!(
            "event: message_delta\ndata: {{\"type\":\"message_delta\",\"usage\":{{\"input_tokens\":0,\"output_tokens\":{output}}}}}\n\n",
            output = output
        )
        .into_bytes()
    }

    #[test]
    fn sse_openai_last_usage_wins() {
        let mut p = SseParser::new(false);
        p.feed(&openai_line(10, 20, 5));
        p.feed(&openai_line(30, 40, 0));
        let u = p.usage_listener.unwrap();
        assert_eq!(u.input, 30);
        assert_eq!(u.output, 40);
        assert_eq!(u.cache_hit, 0);
    }

    #[test]
    fn sse_anthropic_merges_start_and_delta() {
        let mut p = SseParser::new(true);
        p.feed(&anthropic_start(100, 20));
        p.feed(&anthropic_delta(50));
        let u = p.usage_listener.unwrap();
        assert_eq!(u.input, 100);
        assert_eq!(u.output, 50);
        assert_eq!(u.cache_hit, 20);
    }

    #[test]
    fn sse_handles_cross_chunk_boundaries() {
        let mut p = SseParser::new(true);
        let full = anthropic_start(100, 20);
        // 拆成中间断开的片段，覆盖跨 chunk 行拼接
        p.feed(&full[..5]);
        p.feed(&full[5..40]);
        p.feed(&full[40..]);
        p.feed(&anthropic_delta(50));
        let u = p.usage_listener.unwrap();
        assert_eq!(u.input, 100);
        assert_eq!(u.output, 50);
        assert_eq!(u.cache_hit, 20);
    }

    #[test]
    fn sse_ignores_done_and_non_usage() {
        let mut p = SseParser::new(false);
        p.feed(b"data: [DONE]\n\n");
        p.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        assert!(p.usage_listener.is_none());
    }

    #[test]
    fn json_usage_parsing() {
        let json = br#"{"usage":{"prompt_tokens":7,"completion_tokens":9}}"#;
        let u = parse_usage_from_json(json).unwrap();
        assert_eq!(u.input, 7);
        assert_eq!(u.output, 9);
        assert_eq!(u.cache_hit, 0);
    }

    #[test]
    fn anthropic_cache_parsing() {
        let json = br#"{"usage":{"input_tokens":7,"output_tokens":9,"cache_read_input_tokens":3,"cache_creation_input_tokens":99999999}}"#;
        let v: Value = serde_json::from_slice(json).unwrap();
        let u = parse_usage_value(v.get("usage").unwrap()).unwrap();
        assert_eq!(u.input, 7);
        assert_eq!(u.output, 9);
        // 只计 cache_read（3），cache_creation（巨大累计值）不计入
        assert_eq!(u.cache_hit, 3);

        // cache_read 超过 input 时被防御性截断（不可能命中比输入还多）
        let json2 = br#"{"usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":999}}"#;
        let v2: Value = serde_json::from_slice(json2).unwrap();
        let u2 = parse_usage_value(v2.get("usage").unwrap()).unwrap();
        assert_eq!(u2.cache_hit, 5);
    }

    #[test]
    fn inject_only_openai_stream_chat() {
        // OpenAI 平台：注入
        let body = br#"{"model":"gpt-4o","stream":true,"messages":[]}"#.to_vec();
        let out = inject_stream_options("openai", "chat/completions", true, body);
        assert!(out.windows(14).any(|w| w == b"stream_options".as_slice()));

        // OpenAI 兼容平台（deepseek / openrouter / siliconflow 等）：也应注入
        let body2 = br#"{"model":"deepseek-chat","stream":true}"#.to_vec();
        let out2 = inject_stream_options("deepseek", "chat/completions", true, body2);
        assert!(out2.windows(14).any(|w| w == b"stream_options".as_slice()));

        let body3 = br#"{"model":"deepseek-ai/DeepSeek-V3","stream":true}"#.to_vec();
        let out3 = inject_stream_options("siliconflow", "chat/completions", true, body3);
        assert!(out3.windows(14).any(|w| w == b"stream_options".as_slice()));

        // Anthropic 格式（messages）：不注入（不是 chat/completions）
        let body4 = br#"{"model":"deepseek-chat","stream":true}"#.to_vec();
        let out4 = inject_stream_options("deepseek", "messages", true, body4);
        assert!(!out4.windows(14).any(|w| w == b"stream_options".as_slice()));

        // 非流式：不注入
        let body5 = br#"{"model":"gpt-4o","stream":false}"#.to_vec();
        let out5 = inject_stream_options("openai", "chat/completions", false, body5);
        assert!(!out5.windows(14).any(|w| w == b"stream_options".as_slice()));
    }
}