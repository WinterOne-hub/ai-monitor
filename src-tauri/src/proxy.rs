//! 统一代理模式：本地 HTTP 服务，转发 OpenAI 兼容请求到上游平台，
//! 自动解析每次响应的 usage 并记入 daily_usage 表。

use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, Request, StatusCode},
    response::Response,
    routing::post,
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

/// OpenAI 兼容平台 -> 真实上游地址
fn upstream_url(provider: &str) -> Option<&'static str> {
    match provider {
        "deepseek" => Some("https://api.deepseek.com/v1/chat/completions"),
        "moonshot" => Some("https://api.moonshot.cn/v1/chat/completions"),
        "siliconflow" => Some("https://api.siliconflow.cn/v1/chat/completions"),
        "openrouter" => Some("https://openrouter.ai/api/v1/chat/completions"),
        "openai" => Some("https://api.openai.com/v1/chat/completions"),
        "zhipu" => Some("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
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
            .route("/v1/chat/completions", post(handle_default))
            .route("/{provider}/v1/chat/completions", post(handle_provider))
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

async fn handle_default(State(st): State<ProxyState>, req: Request<Body>) -> Response {
    handle_proxy(st, "deepseek".to_string(), req).await
}

async fn handle_provider(
    State(st): State<ProxyState>,
    Path(provider): Path<String>,
    req: Request<Body>,
) -> Response {
    handle_proxy(st, provider, req).await
}

async fn handle_proxy(st: ProxyState, provider: String, req: Request<Body>) -> Response {
    let Some(upstream) = upstream_url(&provider) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &format!(
                r#"{{"error":{{"message":"不支持的平台: {provider}","type":"invalid_request_error"}}}}"#
            ),
        );
    };

    let headers = req.headers().clone();
    let body_bytes = match axum::body::to_bytes(req.into_body(), 64 * 1024 * 1024).await {
        Ok(b) => b.to_vec(),
        Err(_) => {
            return json_response(StatusCode::BAD_REQUEST, "{\"error\":{\"message\":\"读取请求体失败\"}}")
        }
    };

    let auth = headers.get("authorization").cloned();
    let content_type = headers.get("content-type").cloned();

    let mut rb = st.client.post(upstream);
    if let Some(a) = auth {
        rb = rb.header("authorization", a);
    }
    if let Some(ct) = content_type {
        rb = rb.header("content-type", ct);
    }
    rb = rb.header("accept", "text/event-stream");

    let resp = match rb.body(body_bytes.clone()).send().await {
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

    if status.is_success() {
        record_usage(&st, &body_bytes, &bytes).await;
    }

    build_response(status, ct, bytes)
}

// ---------------- usage 解析 ----------------

struct UsageInfo {
    input: i64,
    output: i64,
    cache_hit: i64,
}

async fn record_usage(st: &ProxyState, req_body: &[u8], resp_body: &[u8]) {
    let is_stream = String::from_utf8_lossy(req_body).contains("\"stream\":true");
    let usage = if is_stream {
        parse_usage_from_sse(resp_body)
    } else {
        parse_usage_from_json(resp_body)
    };
    if let Some(u) = usage {
        record_usage_to_db(st, u).await;
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
    let input = u.get("prompt_tokens")?.as_i64()?;
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
    Some(UsageInfo {
        input,
        output,
        cache_hit,
    })
}

// ---------------- 记账 ----------------

async fn record_usage_to_db(st: &ProxyState, u: UsageInfo) {
    let opts = SqliteConnectOptions::new()
        .filename(&st.db_path)
        .create_if_missing(false);
    let Ok(pool) = SqlitePool::connect_with(opts).await else {
        return;
    };

    // 读取记账账户（设置页选择）
    let account_id: Option<i64> = sqlx::query_scalar("SELECT value FROM settings WHERE key='proxy_account_id'")
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten()
        .and_then(|v: String| v.parse().ok());

    let Some(account_id) = account_id else {
        pool.close().await;
        return;
    };

    let _ = sqlx::query(
        "INSERT INTO daily_usage (account_id, date, input_tokens, output_tokens, cache_hit_tokens, cost, source)
         VALUES (?1, date('now','localtime'), ?2, ?3, ?4, 0, 'proxy')
         ON CONFLICT(account_id, date) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,
           source = 'proxy'",
    )
    .bind(account_id)
    .bind(u.input)
    .bind(u.output)
    .bind(u.cache_hit)
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
