//! 统一代理模式：本地 HTTP 服务，转发 OpenAI 兼容请求到上游平台，
//! 自动解析每次 chat/completions 响应的 usage 并记入 daily_usage 表。
//! 采用 catch-all 路由：所有 /v1/* 与 /{provider}/v1/* 路径均透传。

use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, Method, Request, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use tauri::Manager;

pub const PROXY_PORT: u16 = 8899;

#[derive(Clone)]
struct ProxyState {
    client: reqwest::Client,
    db_path: PathBuf,
}

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
fn upstream_anthropic(provider: &str) -> Option<&'static str> {
    match provider {
        "deepseek" => Some("https://api.deepseek.com/anthropic/v1/messages"),
        "moonshot" => Some("https://api.moonshot.cn/anthropic/v1/messages"),
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

    let state = ProxyState {
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .expect("failed to build http client"),
        db_path,
    };

    tauri::async_runtime::spawn(async move {
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
    eprintln!("[proxy] {method} /{provider}/v1/{rest} -> {upstream}");

    // 读取 body（仅带 body 的方法）
    let body_bytes = if method == Method::POST || method == Method::PUT || method == Method::PATCH {
        match axum::body::to_bytes(req.into_body(), 64 * 1024 * 1024).await {
            Ok(b) => b.to_vec(),
            Err(_) => {
                return json_response(StatusCode::BAD_REQUEST, "{\"error\":{\"message\":\"读取请求体失败\"}}")
            }
        }
    } else {
        Vec::new()
    };

    // 透传全部请求头（含 x-api-key / anthropic-version 等）
    let mut rb = st.client.request(method.clone(), &upstream);
    for (name, value) in headers.iter() {
        if name != "host" {
            rb = rb.header(name, value);
        }
    }
    if !body_bytes.is_empty() {
        rb = rb.body(body_bytes.clone());
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
    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => {
            return json_response(StatusCode::BAD_GATEWAY, "{\"error\":{\"message\":\"读取上游响应失败\"}}")
        }
    };

    // 仅 chat/completions 与 messages 的成功响应记账
    if status.is_success() && method == Method::POST && (rest == "chat/completions" || is_messages) {
        record_usage(&st, &provider, &body_bytes, &bytes).await;
    }

    build_response(status, ct, bytes)
}

// ---------------- usage 解析 ----------------

struct UsageInfo {
    input: i64,
    output: i64,
    cache_hit: i64,
}

async fn record_usage(st: &ProxyState, provider: &str, req_body: &[u8], resp_body: &[u8]) {
    let is_stream = String::from_utf8_lossy(req_body).contains("\"stream\":true");
    let usage = if is_stream {
        parse_usage_from_sse(resp_body)
    } else {
        parse_usage_from_json(resp_body)
    };
    if let Some(u) = usage {
        // 从请求体提取 model 名（用于价格匹配）
        let model = serde_json::from_slice::<Value>(req_body)
            .ok()
            .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()));
        record_usage_to_db(st, provider, model.as_deref(), u).await;
    }
}

fn parse_usage_from_json(bytes: &[u8]) -> Option<UsageInfo> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    parse_usage_value(v.get("usage")?)
}

fn parse_usage_from_sse(bytes: &[u8]) -> Option<UsageInfo> {
    let text = String::from_utf8_lossy(bytes);
    let mut last: Option<UsageInfo> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(u) = v.get("usage").and_then(parse_usage_value) {
                    last = Some(u);
                }
            }
        }
    }
    last
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
            .unwrap_or(0);
        return Some(UsageInfo {
            input,
            output,
            cache_hit,
        });
    }
    // Anthropic 格式：input_tokens / output_tokens
    if let Some(input) = u.get("input_tokens").and_then(|v| v.as_i64()) {
        let output = u
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        return Some(UsageInfo {
            input,
            output,
            cache_hit: 0,
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

async fn record_usage_to_db(st: &ProxyState, provider: &str, model: Option<&str>, u: UsageInfo) {
    let opts = SqliteConnectOptions::new()
        .filename(&st.db_path)
        .create_if_missing(false);
    let Ok(pool) = SqlitePool::connect_with(opts).await else {
        return;
    };

    // 读取记账账户（设置页选择）
    let account_id: Option<i64> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='proxy_account_id'")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .and_then(|v: String| v.parse().ok());

    let Some(account_id) = account_id else {
        pool.close().await;
        return;
    };

    // 查模型单价（精确匹配，未配置则用默认）
    let mut input_price = 2.0f64;
    let mut output_price = 3.0f64;
    let mut cache_hit_price = 0.2f64;
    if let Some(model) = model {
        if let Ok(Some((i, o, c))) = sqlx::query_as::<_, (f64, f64, f64)>(
            "SELECT input_price, output_price, cache_hit_price FROM price_table WHERE provider_id = ?1 AND model = ?2",
        )
        .bind(provider)
        .bind(model)
        .fetch_optional(&pool)
        .await
        {
            input_price = i;
            output_price = o;
            cache_hit_price = c;
        } else {
            let (di, do_, dc) = default_prices(provider);
            input_price = di;
            output_price = do_;
            cache_hit_price = dc;
        }
    }

    // 费用 = token * 单价 / 1M
    let cost = (u.input - u.cache_hit) as f64 * input_price / 1_000_000.0
        + u.cache_hit as f64 * cache_hit_price / 1_000_000.0
        + u.output as f64 * output_price / 1_000_000.0;

    let _ = sqlx::query(
        "INSERT INTO daily_usage (account_id, date, input_tokens, output_tokens, cache_hit_tokens, cost, source)
         VALUES (?1, date('now','localtime'), ?2, ?3, ?4, ?5, 'proxy')
         ON CONFLICT(account_id, date) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,
           cost = cost + excluded.cost,
           source = 'proxy'",
    )
    .bind(account_id)
    .bind(u.input)
    .bind(u.output)
    .bind(u.cache_hit)
    .bind(cost)
    .execute(&pool)
    .await;

    pool.close().await;
}

// ---------------- 响应构建 ----------------

fn build_response(status: StatusCode, ct: Option<HeaderValue>, body: Vec<u8>) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(ct) = ct {
        builder = builder.header("content-type", ct);
    }
    builder
        .header("access-control-allow-origin", "*")
        .body(Body::from(body))
        .unwrap()
}

fn json_response(status: StatusCode, body: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Body::from(body.to_string()))
        .unwrap()
}
