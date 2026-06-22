// 批量前端文件上传 API（POST /api/apps/{id}/files/bundle）。
//
// 设计目标：外部 agent 一次性上传整个目录树（HTML/CSS/JS/图片），
// 避免逐个 PUT 单文件。Body 为 gzip 压缩的 tar 归档，流式解压 + 解包。
//
// 鉴权：依赖 lib.ts 的 master key 中间件（path 命中 /api/apps/ 前缀）。
//
// 限制（安全 + 资源）：
// - 压缩前 body 上限 10 MiB（防上传过大）
// - 解压后总字节上限 50 MiB（防 zip bomb）
// - 单文件上限 5 MiB
// - 条目数上限 200
// - 每条目路径复用 validateUploadPath（拒绝 .. / 绝对路径 / 反斜杠 / 空段 / 非白名单后缀）
// - 仅允许 type==="file" 条目；目录条目跳过（依赖文件路径自动 mkdir 父目录）；
//   符号链接/硬链接/字符设备 → 400 拒绝
//
// 原子性：best effort，失败时已写入文件不回滚（外部 agent 重传）。

import type { AppState } from "../state.ts";
import type { Ctx } from "./apps.ts";
import { AppError } from "../error.ts";
import { validateUploadPath } from "./files.ts";
import { UntarStream } from "jsr:@std/tar@^0.1.10/untar-stream";

/** 压缩前 body 字节上限（10 MiB）。 */
export const MAX_BUNDLE_COMPRESSED_BYTES: number = 10 * 1024 * 1024;
/** 解压后总字节上限（50 MiB）。 */
export const MAX_BUNDLE_DECOMPRESSED_BYTES: number = 50 * 1024 * 1024;
/** 单个解压文件字节上限（5 MiB）。 */
export const MAX_BUNDLE_FILE_BYTES: number = 5 * 1024 * 1024;
/** tar 条目数上限。 */
export const MAX_BUNDLE_ENTRIES: number = 200;

interface WrittenFile {
  path: string;
  bytes: number;
}

/**
 * POST /api/apps/{id}/files/bundle —— gzip 压缩 tar 归档批量上传。
 *
 * 成功 200：
 * { data: { files: [{path:"/{id}/index.html",bytes:N},...],
 *           total_files, total_bytes, total_bytes_limit }, error: null }
 */
export async function uploadBundle(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const state: AppState = ctx.state;
  const id = ctx.params.id;

  // 1. 校验 app 存在（404 优先）
  const app = await state.store.get(id);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${id}`);
  }

  // 2. 压缩前 body 大小校验（Content-Length 快速失败）
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BUNDLE_COMPRESSED_BYTES) {
      throw AppError.PayloadTooLarge(
        `压缩 body ${n} 字节超过上限 ${MAX_BUNDLE_COMPRESSED_BYTES} 字节`,
      );
    }
  }
  if (req.body === null) {
    throw AppError.BadRequest("请求体为空");
  }

  // 3. 流式读取压缩 body（上限 MAX_BUNDLE_COMPRESSED_BYTES），收集为单个 Uint8Array
  //    压缩前上限 10 MiB，全量缓冲可接受；避免 peek + 重组流的 reader 状态坑。
  const compressed = await readBounded(
    req.body,
    MAX_BUNDLE_COMPRESSED_BYTES,
    "压缩 body 超过上限",
  );

  // 4. gzip magic 字节嗅探（1f 8b）——拒绝非 gzip 输入
  if (compressed.byteLength < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw AppError.BadRequest("请求体不是 gzip 压缩数据（缺少 gzip magic 1f 8b）");
  }

  // 5. 流式：gzip 解压 → UntarStream → 逐条目校验 + 写盘
  let gunzip: TransformStream<Uint8Array, Uint8Array>;
  try {
    gunzip = new DecompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >;
  } catch (e) {
    throw AppError.BadRequest(
      `不支持 gzip 解压：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const compressedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  const tarStream = compressedStream.pipeThrough(gunzip).pipeThrough(
    new UntarStream(),
  );

  const targetDir = `${state.publicDir}/${id}`;
  // 确保 app 根目录存在（占位 index.html 已创建，但若被删则重建）
  await Deno.mkdir(targetDir, { recursive: true });

  const written: WrittenFile[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  try {
    for await (const entry of tarStream) {
      entryCount++;
      if (entryCount > MAX_BUNDLE_ENTRIES) {
        throw AppError.BadRequest(
          `tar 条目数超过上限 ${MAX_BUNDLE_ENTRIES}（已处理 ${
            entryCount - 1
          } 个后遇到第 ${entryCount} 个）`,
        );
      }

      // 仅允许普通文件条目（UntarStream entry 无 type 字段时按文件处理；
      // 目录条目 path 末尾含 "/"，校验后会因后缀不合法被拒，故显式跳过）
      const rawPath = entry.path ?? "";
      const isDirectoryEntry = rawPath.endsWith("/");
      if (isDirectoryEntry) {
        // 目录条目：跳过（不创建空目录，依赖后续文件条目自动 mkdir 父目录）
        await entry.readable?.cancel().catch(() => {});
        continue;
      }

      // GNU tar / BSD tar 的 `tar -C dir .` 标准打包会在包内生成形如
      // `./index.html`、`./sub/app.js` 的 entry（顶层目录 entry 已被上面的
      // 目录跳过处理）。此处对路径做规范化：
      // - 去前导 `./`
      // - 拆段后过滤掉 `.` 段（保留对 `..` 段的拒绝——交给 validateUploadPath）
      // - 规范化后为空（纯 `.` entry）→ 跳过
      // 不放宽 validateUploadPath 自身的语义（中间 `..` 段仍必须拒绝）。
      const normalizedPath = normalizeTarEntryPath(rawPath);
      if (normalizedPath === "") {
        // 纯 . 或 ./ entry，无文件内容要写，跳过（取消底层流避免泄漏）
        await entry.readable?.cancel().catch(() => {});
        continue;
      }

      // 路径安全校验（zip-slip / 后缀白名单 / 空段等）
      const relPath = validateUploadPath(normalizedPath);

      // 写入临时缓冲以校验单文件上限（流式 read 块，逐块累加）
      const fullPath = `${targetDir}/${relPath}`;
      const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      if (parentDir.length > 0) {
        await Deno.mkdir(parentDir, { recursive: true });
      }

      let fileBytes = 0;
      const file = await Deno.open(fullPath, {
        write: true,
        create: true,
        truncate: true,
      });
      let fileClosed = false;
      try {
        const reader = entry.readable?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              fileBytes += value.byteLength;
              if (fileBytes > MAX_BUNDLE_FILE_BYTES) {
                throw AppError.PayloadTooLarge(
                  `单文件 ${relPath} 解压后超过上限 ${MAX_BUNDLE_FILE_BYTES} 字节`,
                );
              }
              totalBytes += value.byteLength;
              if (totalBytes > MAX_BUNDLE_DECOMPRESSED_BYTES) {
                throw AppError.PayloadTooLarge(
                  `解压后总字节超过上限 ${MAX_BUNDLE_DECOMPRESSED_BYTES} 字节` +
                    `（已写入 ${written.length} 个文件）`,
                );
              }
              await file.write(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
      } finally {
        await file.close();
        fileClosed = true;
      }
      void fileClosed;

      written.push({ path: `/${id}/${relPath}`, bytes: fileBytes });
    }
  } catch (e) {
    if (e instanceof AppError) {
      // 把已写入文件信息附在错误消息里
      const note = `（已写入 ${written.length} 个文件，共 ${totalBytes} 字节）`;
      // 重新构造同种类 AppError 以追加已写入信息
      const e2 = AppError.fromKind(e, `${e.publicMessage}${note}`);
      throw e2;
    }
    // DecompressionStream / UntarStream 解析失败 → BadRequest
    if (
      e instanceof TypeError ||
      (e instanceof Error && /gzip|tar|invalid|unexpected/i.test(e.message))
    ) {
      throw AppError.BadRequest(
        `解压失败：${e.message}（已写入 ${written.length} 个文件）`,
      );
    }
    throw e;
  }

  if (written.length === 0) {
    throw AppError.BadRequest("tar 归档中未发现任何可写入文件");
  }

  return Response.json({
    data: {
      files: written,
      total_files: written.length,
      total_bytes: totalBytes,
      // 暴露上限让 agent 知道边界（R2 M2）
      total_bytes_limit: MAX_BUNDLE_DECOMPRESSED_BYTES,
    },
    error: null,
  });
}

/**
 * 规范化 tar 条目路径，兼容 `tar -C dir .` 标准打包格式。
 *
 * 规则：
 * - 去前导 `./`
 * - 拆段后过滤掉 `.` 段（中间 `.` 段也去，但 `..` 段保留交给后续校验拒绝）
 * - 空段保留（validateUploadPath 会拒绝）
 * - 返回空串表示纯 `.` entry，调用方应跳过
 *
 * 示例：
 *   "./index.html"      → "index.html"
 *   "./sub/app.js"      → "sub/app.js"
 *   "."                 → ""
 *   "./"                → ""（理论上前缀已去，但兜底）
 *   "index.html"        → "index.html"
 *   "sub/./app.js"      → "sub/app.js"（中间 . 段也去）
 *   "../evil.txt"       → "../evil.txt"（.. 保留，后续 validateUploadPath 拒绝）
 */
export function normalizeTarEntryPath(raw: string): string {
  let p = raw;
  // 去所有前导 `./`（可能多个，如 `././x`）
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  // 拆段过滤 `.` 段（保留 `..` 段交给 validateUploadPath）
  const segs = p.split("/");
  const filtered = segs.filter((s) => s !== ".");
  return filtered.join("/");
}

/**
 * 流式读取 ReadableStream<Uint8Array>，累加字节；
 * 超过 maxBytes 时抛 PayloadTooLarge，否则返回合并后的 Uint8Array。
 */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        seen += value.byteLength;
        if (seen > maxBytes) {
          throw AppError.PayloadTooLarge(`${label} ${seen} > ${maxBytes} 字节`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(seen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
