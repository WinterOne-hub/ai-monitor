import { invoke } from "@tauri-apps/api/core";

export interface HttpHeaders {
  [key: string]: string;
}

/**
 * 通过 Rust 侧（reqwest）发起 HTTP GET，规避 webview 的 CORS 限制。
 * 所有 Provider 的 API 调用都应走这里。
 */
export async function httpGetJson(url: string, headers: HttpHeaders = {}): Promise<unknown> {
  const headerPairs = Object.entries(headers);
  return invoke("http_get_json", { url, headers: headerPairs });
}
