// 静态文件服务。对应 Rust crates/server/src/static_files/mod.rs，行为 1:1 复刻。
//
// 翻译决策：
// - tokio::fs::read → Deno.readFile（Uint8Array）
// - Path::canonicalize 路径穿越防护 → Deno.realPath，再 startsWith 字符串前缀比较
//   （注意：必须 realPath 后再 startsWith，不可对原始路径 string startsWith，
//    否则 ../ 正则化绕过；对应 mod.rs:23-31）
// - mime_guess::from_path → @std/media_types 的 contentType（fallback application/octet-stream）
// - HeaderValue::from_str + unwrap_or octet-stream → 显式 try/catch fallback
// - Result<Response, AppError> → async function 抛 AppError
// - axum Body::from + status_mut = OK → new Response(body, { status: 200, headers })

import { AppError } from "../error.ts";
import { contentType } from "jsr:@std/media-types@^1.0.0";

/** serveFileFromRoot 选项。 */
export interface ServeFileOptions {
  /**
   * 当前 app id（如 "app-abc123"）。
   * 提供时，HTML 响应里会注入一段 fetch shim：
   * 把绝对路径 fetch（`/api/...`）重写为 `/{appId}/api/...`，
   * 让前端无需关心部署子路径。
   * 非必填——未知 appId 时不注入 shim。
   */
  appId?: string;
}

/**
 * 从 root 目录读取相对路径 `relPath` 的文件，返回 Response。
 *
 * - 空 path 或尾部 `/` 默认走 index.html
 * - 路径穿越防护：realPath 后必须仍在 root 下
 * - 自动推断 content-type
 * - Cache-Control: public, max-age=60（mod.rs:49-52 1:1）
 * - HTML 响应注入 fetch shim（当 options.appId 提供时）
 */
export async function serveFileFromRoot(
  root: string,
  relPath: string,
  options?: ServeFileOptions,
): Promise<Response> {
  // 空 path 或尾部 / 默认走 index.html
  const normalizedRel = relPath.length === 0 || relPath.endsWith("/")
    ? `${relPath}index.html`
    : relPath;

  // 注意：用 OS 路径分隔符 join。Deno.join 是跨平台的，但这里 root 已是绝对路径，
  // 用 / 拼接在 POSIX 上等价。为安全起见显式 join。
  const fullPath = joinPath(root, normalizedRel);

  // canonicalize 用于穿越防护；不存在 → NotFound
  let canonical: string;
  try {
    canonical = await Deno.realPath(fullPath);
  } catch {
    throw AppError.NotFound(`文件不存在: ${normalizedRel}`);
  }
  let rootCanonical: string;
  try {
    rootCanonical = await Deno.realPath(root);
  } catch {
    throw AppError.Internal("根目录无效");
  }

  // startsWith 必须在 realPath 之后做（防 ../ 绕过）
  // realPath 返回绝对无符号链接路径，前缀比较是安全的
  if (!isPathUnder(canonical, rootCanonical)) {
    throw AppError.NotFound("路径越界");
  }

  let data: Uint8Array;
  try {
    data = await Deno.readFile(canonical);
  } catch {
    throw AppError.NotFound(`读取失败: ${normalizedRel}`);
  }

  // 推断 content-type，fallback octet-stream（Issue #8）
  const ct = contentTypeForPath(canonical);
  const cacheControl = "public, max-age=60";

  // HTML 响应注入 fetch shim（agent-pov R2 B1）：
  // 仅对 text/html 注入，让浏览器 fetch('/api/x') 自动重写为 /{appId}/api/x。
  // 非 HTML（JS/CSS/图片）不注入，避免污染静态资源。
  let bodyData: Uint8Array = data;
  if (options?.appId && ct.includes("text/html")) {
    bodyData = injectFetchShim(data, options.appId);
  }

  // Deno.readFile 返回 Uint8Array<ArrayBufferLike>，Response 构造器对 BufferSource
  // 的精确子类型挑剔（lib.dom.d.ts 泛型坑），用 as BodyInit 收窄。
  const body = bodyData as unknown as BodyInit;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": cacheControl,
    },
  });
}

/**
 * 在 HTML 字节流里注入 fetch shim 脚本。
 *
 * 注入策略（YAGNI——不处理注释/CDATA/嵌套 head）：
 * - 第一个 `<head>` 标签后注入（正则大小写不敏感）
 * - 没有 `<head>` 标签 → 注入到文件开头
 *
 * shim 行为：把绝对路径 `/api/...` 重写为 `/{appId}/api/...`，
 * 让前端 fetch 调用不依赖部署子路径。
 */
function injectFetchShim(htmlBytes: Uint8Array, appId: string): Uint8Array {
  const decoder = new TextDecoder();
  const html = decoder.decode(htmlBytes);
  const shim = buildFetchShim(appId);
  const headRe = /<head[^>]*>/i;
  const injected = headRe.test(html)
    ? html.replace(headRe, (m) => `${m}${shim}`)
    : `${shim}${html}`;
  const encoder = new TextEncoder();
  return encoder.encode(injected);
}

/**
 * 构造 fetch shim 脚本字符串。
 *
 * PREFIX 从 window.location.pathname 推导（第一段即 app_id 前缀），
 * 避免硬编码 appId 到全局变量（虽然 appId 是公开信息，但保持解耦）。
 *
 * 重写规则：
 * - 字符串 fetch('/api/x') → fetch('/{appId}/api/x')
 * - Request 对象 fetch(new Request('/api/x')) → 同上
 * - 相对路径（'./api/x' / 'api/x'）→ 不重写（浏览器自己解析已对）
 * - 协议相对路径（'//host/...'）→ 不重写
 * - 完整 URL（http://...）→ 不重写
 */
function buildFetchShim(appId: string): string {
  // 把 appId 嵌入变量，避免在客户端再解析 pathname（更稳定、可测）
  // PREFIX 形如 "/app-abc123"
  const prefix = `/${appId}`;
  return `<script>(function(){
  var PREFIX = ${JSON.stringify(prefix)};
  var orig = window.fetch;
  window.fetch = function(input, init){
    if (typeof input === 'string') {
      if (input.charAt(0) === '/' && !input.startsWith('//') && input.indexOf(PREFIX + '/') !== 0 && input !== PREFIX) {
        input = PREFIX + input;
      }
    } else if (input instanceof Request) {
      var u = input.url;
      if (u.charAt(0) === '/' && !u.startsWith('//') && u.indexOf(PREFIX + '/') !== 0 && u !== PREFIX) {
        input = new Request(PREFIX + u, input);
      }
    }
    return orig.call(this, input, init);
  };
})();
</script>`;
}

/**
 * 推断文件的 content-type。
 * 对应 mime_guess::from_path(...).first_or_octet_stream()。
 * Issue #8：from_str 失败时 fallback 到 application/octet-stream。
 */
function contentTypeForPath(filePath: string): string {
  try {
    // 从路径中提取最后一个扩展名（含前导点），再交给 contentType。
    // @std/media_types 的 contentType 只在入参本身形如 ".html" 时才附加 charset，
    // 对完整文件路径直接调用会返回 undefined（已实测）。需先取扩展名再调用。
    const dotIdx = filePath.lastIndexOf(".");
    if (dotIdx < 0) {
      return "application/octet-stream";
    }
    // 防止取到目录名里的点：取 basename 后再 lastIndexOf
    const sepIdx = Math.max(
      filePath.lastIndexOf("/"),
      filePath.lastIndexOf("\\"),
    );
    const baseDot = sepIdx >= 0 ? filePath.slice(sepIdx + 1).lastIndexOf(".") : dotIdx;
    if (baseDot < 0) {
      return "application/octet-stream";
    }
    const ext = sepIdx >= 0 ? filePath.slice(sepIdx + 1 + baseDot) : filePath.slice(dotIdx);
    // contentType(".html") → "text/html; charset=UTF-8"
    // 未知扩展名返回 undefined → 与 Rust first_or_octet_stream 一致 fallback
    return contentType(ext) ?? "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

/**
 * 路径拼接。保持 POSIX 风格的 / 分隔符用于 URL 相对路径，最终 realPath 会规范化。
 * 这里简单按 / join 并去重多余斜杠，root 已绝对。
 */
function joinPath(root: string, rel: string): string {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  const x = rel.startsWith("/") ? rel : `/${rel}`;
  return `${r}${x}`;
}

/**
 * 路径前缀比较（realPath 后做）。canonical 等于 rootCanonical 或以
 * rootCanonical + 路径分隔符开头。对应 Path::starts_with。
 * 必须用分隔符边界比较，避免 /foo 被 /foobar 包含的误判。
 */
function isPathUnder(canonical: string, rootCanonical: string): boolean {
  if (canonical === rootCanonical) return true;
  // POSIX 与 Windows 分隔符都接受（realPath 后已归一化为当前 OS 分隔符）
  return canonical.startsWith(rootCanonical + "/") ||
    canonical.startsWith(rootCanonical + "\\");
}
