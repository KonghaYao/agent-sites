// 前端文件发布 API（PUT /api/apps/{id}/files/{*path}）。
//
// 设计目标（agent-pov review B2）：
// 外部 agent 只能 HTTP，无文件系统访问权限。提供此 endpoint 让 agent 把
// HTML/CSS/JS/图片等静态资源上传到对应 app 的 public/{id}/ 下，从而能
// 通过浏览器 GET /{id}/... 访问。
//
// 鉴权：依赖 lib.ts 的 master key 中间件（path 命中 /api/apps/ 前缀，
// 已被强制 X-Master-Key 校验），handler 内不重复校验。
//
// 限制：
// - 路径防穿越：禁止 ".." 段 / 绝对路径 / 空路径
// - 后缀白名单：仅允许 .html/.htm/.css/.js/.json/.svg/.png/.jpg/.jpeg/.webp/.ico/.txt/.map
// - body 大小上限 1MB（agent 上传的 HTML/CSS 体积有限，超限 413）

import type { AppState } from "../state.ts";
import type { Ctx } from "./apps.ts";
import { AppError } from "../error.ts";

/** 允许上传的文件后缀（白名单）。 */
const ALLOWED_EXTS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".txt",
  ".map",
]);

/** 单次上传 body 字节上限（1 MiB）。 */
export const MAX_UPLOAD_BYTES: number = 1 * 1024 * 1024;

/**
 * PUT /api/apps/{id}/files/{*path} —— 上传文件到对应 app 的 public/{id}/ 目录。
 *
 * - ctx.params.id: app_id
 * - ctx.params.path: 相对路径（含子目录 + 文件名）
 * - 成功：200，返回 { data: { path: "/{id}/{path}", bytes: N }, error: null }
 */
export async function uploadFile(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const state: AppState = ctx.state;
  const id = ctx.params.id;
  const rawPath = ctx.params.path ?? "";

  // 校验 app 存在（404 优先于其他错误）
  const app = await state.store.get(id);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${id}`);
  }

  // 路径校验
  const relPath = validateUploadPath(rawPath);

  // body 大小校验（先 Content-Length 快速失败，再读真实字节兜底）
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_UPLOAD_BYTES) {
      throw AppError.PayloadTooLarge(
        `上传 body ${n} 字节超过上限 ${MAX_UPLOAD_BYTES} 字节`,
      );
    }
  }
  const buf = await req.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw AppError.PayloadTooLarge(
      `上传 body ${bytes.byteLength} 字节超过上限 ${MAX_UPLOAD_BYTES} 字节`,
    );
  }

  // 写入 public/{id}/{relPath}（自动建父目录）
  const targetDir = `${state.publicDir}/${id}`;
  const fullPath = `${targetDir}/${relPath}`;
  const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
  if (parentDir.length > 0) {
    await Deno.mkdir(parentDir, { recursive: true });
  }
  await Deno.writeFile(fullPath, bytes);

  return Response.json({
    data: {
      path: `/${id}/${relPath}`,
      bytes: bytes.byteLength,
    },
    error: null,
  });
}

/**
 * 校验上传相对路径：
 * - 空路径 → BadRequest
 * - 含 ".." 段（路径穿越）→ BadRequest
 * - 绝对路径（以 / 开头）→ BadRequest
 * - 后缀非白名单 → BadRequest
 * - Windows 路径分隔符 "\\" → 拒绝
 * - 返回 trim 后的规范化路径（已确保不以 / 开头）
 */
export function validateUploadPath(raw: string): string {
  // 1. 去前导斜杠 + 多余空格
  let p = raw.trim();
  while (p.startsWith("/")) p = p.slice(1);
  if (p.length === 0) {
    throw AppError.BadRequest("上传路径不能为空");
  }
  // 2. 拒反斜杠
  if (p.includes("\\")) {
    throw AppError.BadRequest("上传路径不允许反斜杠");
  }
  // 3. 拒 .. 段
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw AppError.BadRequest("上传路径不允许 '..' 或 '.' 段");
    }
    if (seg.length === 0) {
      throw AppError.BadRequest("上传路径不允许空段");
    }
  }
  // 4. 后缀白名单
  const lastSeg = segments[segments.length - 1];
  const dotIdx = lastSeg.lastIndexOf(".");
  if (dotIdx < 0) {
    throw AppError.BadRequest("上传路径缺少文件后缀");
  }
  const ext = lastSeg.slice(dotIdx).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw AppError.BadRequest(
      `文件后缀 ${ext} 不在允许列表：${[...ALLOWED_EXTS].join(", ")}`,
    );
  }
  return p;
}
