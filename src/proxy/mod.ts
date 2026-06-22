// 代理转发：把请求转发到上游 PocketBase 实例。
// 对应 Rust crates/server/src/proxy/mod.rs，行为 1:1 复刻。
//
// 翻译决策：
// - reqwest::Client → 原生 fetch + AbortSignal.timeout(60_000)（60s 超时等价）
// - axum::http::{HeaderMap, HeaderValue, Method, StatusCode} → Web 标准 Headers / string / number
// - axum::body::Bytes → Uint8Array
// - AppError::Internal(msg) → AppError.Internal(msg)
// - Result<Response, AppError> → throws AppError（调用方 try/catch）
// - 跳过 hop-by-hop headers：host/content-length/transfer-encoding/connection/content-encoding
// - Set-Cookie Path 改写：字符级 split(';')（CLAUDE.md 字符级操作要求）
// - 已知限制：Deno Headers 对多 Set-Cookie 是覆盖语义（Rust HeaderMap.insert 也是覆盖），
//   保持覆盖行为并注释标记，调用方若需多 cookie 应改 getSetCookie() 遍历（本期未启用）。

import { AppError } from "../error.ts";

/** 代理请求体默认上限（50 MiB） */
export const DEFAULT_MAX_BODY_BYTES: number = 50 * 1024 * 1024;

/**
 * 判断 forward 错误是否值得自愈（connect refused / timeout 类）。
 *
 * 这些错误暗示 PocketBase 后端可能崩了或僵死，应该尝试重启。
 *
 * 翻译决策：Rust 通过模式匹配 AppError::Internal(m) 取 message，
 * TS 端 AppError.Internal 的原始 message 存在 super.message（private constructor 透传 rawMessage），
 * 因此用 instanceof AppError + error.code === "INTERNAL_ERROR" 判定后取 .message。
 */
export function isRecoverableError(e: AppError): boolean {
  if (!(e instanceof AppError) || e.code !== "INTERNAL_ERROR") {
    return false;
  }
  const lower = e.message.toLowerCase();
  return lower.includes("connection refused") ||
    lower.includes("connect error") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("broken pipe");
}

/** hop-by-hop / 已由运行时自动管理的请求头，转发前跳过 */
const SKIP_REQ_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** hop-by-hop / 已由运行时自动管理的响应头，回写前跳过 */
const SKIP_RESP_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "connection",
]);

/**
 * 转发请求到上游 PocketBase 实例。
 *
 * - `port`：PocketBase 监听端口
 * - `path`：上游路径（含 query），如 `/api/collections` 或 `/api/items?id=42`
 * - `method`/`headers`/`body`：透传
 * - `maxBodyBytes`：请求体上限，超过返回 413 PayloadTooLarge
 * - `cookieScope`：若给定 app_id，则把上游响应的 Set-Cookie 中 Path=/
 *   改写为 Path=/{app_id}/，保证 App 间 auth cookie 隔离
 * - 跳过 hop-by-hop headers（transfer-encoding、content-encoding、connection 等）
 *
 * 抛出 AppError 对应 Rust Result::Err。
 */
export async function forward(
  port: number,
  path: string,
  method: string,
  headers: Headers,
  body: Uint8Array,
  maxBodyBytes: number,
  cookieScope?: string,
): Promise<Response> {
  // Issue #3：请求体大小限制
  if (body.byteLength > maxBodyBytes) {
    throw AppError.PayloadTooLarge(
      `请求体 ${body.byteLength} 字节超过上限 ${maxBodyBytes} 字节`,
    );
  }

  const url = `http://localhost:${port}${path}`;

  // 透传 headers（跳过 host 由 fetch 自动设；content-length/transfer-encoding/connection 跳过）
  const upstreamHeaders = new Headers();
  for (const [key, value] of headers.entries()) {
    const name = key.toLowerCase();
    if (SKIP_REQ_HEADERS.has(name)) {
      continue;
    }
    upstreamHeaders.set(key, value);
  }

  // 构造请求 init：60s 超时等价 reqwest timeout
  const init: RequestInit = {
    method: method || "GET",
    headers: upstreamHeaders,
    signal: AbortSignal.timeout(60_000),
  };
  if (body.byteLength > 0) {
    // Uint8Array → BodyInit:Deno 2.x 类型严格,Uint8Array<ArrayBufferLike> 不直接可赋值,
    // 用底层 ArrayBuffer slice 确保 BodyInit 兼容(避免共享 ArrayBuffer)。
    init.body = body.slice().buffer;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    // fetch 失败：连接拒绝、超时、DNS 等
    throw AppError.Internal(`代理请求失败 (${url}): ${formatFetchError(e)}`);
  }

  const status = upstream.status;
  const respHeaders = upstream.headers;

  // 读取响应体（一次性 buffer，等价 Rust bytes().await）
  let respBody: Uint8Array;
  try {
    const buf = await upstream.arrayBuffer();
    respBody = new Uint8Array(buf);
  } catch (e) {
    throw AppError.Internal(`读取代理响应失败: ${formatFetchError(e)}`);
  }

  // 组装回写 Headers（跳过 hop-by-hop）
  const outHeaders = new Headers();
  // Set-Cookie 特殊处理:Deno Headers.entries() 会把多 Set-Cookie 合并为逗号分隔单条目
  // (浏览器拒绝),必须用 getSetCookie() 取数组逐条 append。
  // Issue #1:每条 cookie 路径隔离(改写 Path=/ → Path=/{app_id})
  const setCookies = cookieScope ? respHeaders.getSetCookie() : [];
  for (const sc of setCookies) {
    outHeaders.append("set-cookie", rewriteCookiePath(sc, cookieScope!));
  }
  for (const [key, value] of respHeaders.entries()) {
    const name = key.toLowerCase();
    if (SKIP_RESP_HEADERS.has(name)) {
      continue;
    }
    if (name === "set-cookie") {
      // 已在上方 getSetCookie() 路径处理,跳过 entries() 的合并值
      continue;
    }
    outHeaders.set(key, value);
  }

  // 204 No Content / 304 Not Modified（以及 HEAD 请求）不允许有 body，
  // 否则触发 "Response with null body status cannot have body" → 500。
  // 上游 PB DELETE 成功返 204，此处必须剥掉 body（Issue: agent-pov B1）。
  const nullBodyStatus = status === 204 || status === 304 ||
    method.toUpperCase() === "HEAD";
  const bodyInit: BodyInit | null = nullBodyStatus ? null : (respBody.slice().buffer as BodyInit);
  return new Response(bodyInit, { status, headers: outHeaders });
}

/**
 * 把 Set-Cookie 头中的 Path=/ 改写为 Path=/{app_id}，实现 App 间 cookie 隔离。
 *
 * PocketBase 0.23.x 默认返回 Path=/（且不支持 --cookiePath），
 * 因此在代理层重写。仅替换 Path=（大小写无关），
 * 保留其余 cookie 属性（HttpOnly、Secure、SameSite 等）。
 *
 * 字符级 split(';')（CLAUDE.md：禁止 byte-slice 截断 CJK，split 不涉及截断但保持字符语义）。
 */
export function rewriteCookiePath(raw: string, appId: string): string {
  const target = `/${appId}`;
  const parts: string[] = raw.split(";");
  let found = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // trimStart 等价 Rust trim_start
    const trimmed = part.replace(/^\s+/, "");
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("path=")) {
      // 替换为 " Path={target}"（前导空格保持 Rust 输出格式）
      parts[i] = ` Path=${target}`;
      found = true;
      break;
    }
  }
  if (!found) {
    // 没有 Path 属性：补一个
    parts.push(` Path=${target}`);
  }
  return parts.join(";");
}

/** 格式化 fetch 抛出的 unknown 错误为字符串（防止 [object Object]）。
 *  归一化 Deno fetch 的特定错误类型到 isRecoverableError 能匹配的关键词:
 *  - TimeoutError / AbortError(由 AbortSignal.timeout 触发) → "timed out"
 *  - ConnectionRefused(Deno.errors.ConnectionRefused) → "connection refused"
 *  - BrokenPipe(Deno.errors.BrokenPipe) → "broken pipe"
 *  这样 isRecoverableError 的字符串匹配能稳定触发自愈(lib.rs:131 关键词列表对齐)。 */
function formatFetchError(e: unknown): string {
  // 1. Deno 原生错误类型(优先,命名空间最稳定)
  if (Deno.errors && e instanceof Deno.errors.ConnectionRefused) {
    return "connection refused";
  }
  if (Deno.errors && e instanceof Deno.errors.BrokenPipe) {
    return "broken pipe";
  }
  // 2. DOMException(超时由 AbortSignal.timeout 触发,通常是 TimeoutError)
  if (e instanceof DOMException) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      return `timed out: ${e.message}`;
    }
    return `${e.name}: ${e.message}`;
  }
  // 3. 通用 Error / TypeError(fetch 网络错误常是 TypeError)
  if (e instanceof Error) {
    // TypeError 的 message 在不同 Deno 版本可能含 "connection refused" / "NetworkError" 等
    const msg = e.message.toLowerCase();
    if (msg.includes("refused") || msg.includes("connect")) return e.message;
    if (msg.includes("timed out") || msg.includes("timeout")) {
      return `timed out: ${e.message}`;
    }
    return e.message;
  }
  return String(e);
}
