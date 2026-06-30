// POST /api/apps/{id}/deploy —— 上传 gzip 包并部署自定义应用。
import type { Ctx } from "./apps.ts";
import { AppError } from "../error.ts";
import { UntarStream } from "jsr:@std/tar@^0.1.10/untar-stream";
import { PortAllocator } from "../process/port_allocator.ts";

const MAX_DEPLOY_COMPRESSED = 20 * 1024 * 1024;
const MAX_DEPLOY_DECOMPRESSED = 100 * 1024 * 1024;
const MAX_DEPLOY_FILE = 10 * 1024 * 1024;
const MAX_DEPLOY_ENTRIES = 500;

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
  ".ts",
  ".mjs",
  ".mts",
  ".jsx",
  ".tsx",
  ".wasm",
  ".sql",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

function validateExt(path: string): string {
  const lower = path.toLowerCase();
  for (const ext of ALLOWED_EXTS) {
    if (lower.endsWith(ext)) return ext;
  }
  throw AppError.BadRequest(`文件后缀不允许: ${path}`);
}

function validateDeployPath(raw: string): string {
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  if (p === "" || p === ".") return "";
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") {
      throw AppError.BadRequest(`路径不允许 '.' 或 '..' 段: ${raw}`);
    }
    if (s.includes("\\")) {
      throw AppError.BadRequest(`路径不允许反斜杠: ${raw}`);
    }
  }
  const lastDot = p.lastIndexOf(".");
  if (lastDot === -1 || lastDot === p.length - 1 || p.slice(lastDot + 1).includes("/")) {
    // 无后缀或后缀中有 /，跳过校验
  } else {
    validateExt(p);
  }
  return p;
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
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
        if (seen > maxBytes) throw AppError.PayloadTooLarge(`请求体超过 ${maxBytes} 字节`);
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

export async function deployApp(req: Request, ctx: Ctx): Promise<Response> {
  const state = ctx.state;
  const id = ctx.params.id;

  // 1. 校验 app 存在
  const app = await state.store.get(id);
  if (!app) throw AppError.NotFound(`App 不存在: ${id}`);

  // 2. 仅 custom 类型
  if (app.type !== "custom") {
    throw AppError.BadRequest(`App ${id} 不是自定义类型，无法部署`);
  }

  // 3. 读取 body + gzip magic
  if (req.body === null) throw AppError.BadRequest("请求体为空");
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_DEPLOY_COMPRESSED) {
      throw AppError.PayloadTooLarge(`压缩 body ${n} 字节超过上限 ${MAX_DEPLOY_COMPRESSED} 字节`);
    }
  }
  const compressed = await readBounded(req.body, MAX_DEPLOY_COMPRESSED);
  if (compressed.byteLength < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw AppError.BadRequest("请求体不是 gzip 压缩数据");
  }

  // 4. 确定目标槽位
  const targetSlot: "a" | "b" = app.active_slot === "a" ? "b" : "a";
  const deployDir = `${state.dataDir}/${id}/deploy-${targetSlot}`;
  const runtimeDir = `${state.dataDir}/${id}/runtime`;

  await Deno.remove(deployDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(deployDir, { recursive: true });
  await Deno.mkdir(runtimeDir, { recursive: true });

  // 5. 解压 gzip → untar → 写盘
  const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  const compressedStream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(compressed);
      c.close();
    },
  });
  const tarStream = compressedStream.pipeThrough(gunzip).pipeThrough(new UntarStream());

  let entryCount = 0;
  let totalBytes = 0;
  let foundEntry = false;
  const written: string[] = [];

  try {
    for await (const entry of tarStream) {
      entryCount++;
      if (entryCount > MAX_DEPLOY_ENTRIES) {
        throw AppError.BadRequest(`条目数超过上限 ${MAX_DEPLOY_ENTRIES}`);
      }

      const rawPath = entry.path ?? "";
      if (rawPath.endsWith("/")) {
        await entry.readable?.cancel().catch(() => {});
        continue;
      }

      const relPath = validateDeployPath(rawPath);
      if (relPath === "") {
        await entry.readable?.cancel().catch(() => {});
        continue;
      }

      foundEntry = true;
      const fullPath = `${deployDir}/${relPath}`;
      const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      if (parentDir.length > 0) await Deno.mkdir(parentDir, { recursive: true });

      let fileBytes = 0;
      const file = await Deno.open(fullPath, { write: true, create: true, truncate: true });
      try {
        const reader = entry.readable?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              fileBytes += value.byteLength;
              if (fileBytes > MAX_DEPLOY_FILE) {
                throw AppError.PayloadTooLarge(
                  `单文件 ${relPath} 超过上限 ${MAX_DEPLOY_FILE} 字节`,
                );
              }
              totalBytes += value.byteLength;
              if (totalBytes > MAX_DEPLOY_DECOMPRESSED) {
                throw AppError.PayloadTooLarge(
                  `解压后总字节超过上限 ${MAX_DEPLOY_DECOMPRESSED} 字节`,
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
      }
      written.push(relPath);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof TypeError || (e instanceof Error && /gzip|tar|invalid/i.test(e.message))) {
      throw AppError.BadRequest(`解压失败: ${e.message}（已写入 ${written.length} 个文件）`);
    }
    throw e;
  }

  if (!foundEntry) throw AppError.BadRequest("归档中未发现任何文件");

  // 6. 扫描入口文件
  let entryFile: string | undefined;
  try {
    await Deno.stat(`${deployDir}/main.ts`);
    entryFile = "main.ts";
  } catch { /* */ }
  if (!entryFile) {
    try {
      await Deno.stat(`${deployDir}/main.js`);
      entryFile = "main.js";
    } catch { /* */ }
  }
  if (!entryFile) {
    throw AppError.BadRequest("未找到入口文件 main.ts 或 main.js");
  }

  // 7. 分配新端口
  const usedPorts = await state.store.usedPorts();
  const allocator = new PortAllocator(state.portMin, state.portMax);
  const newPort = allocator.allocate(usedPorts);
  if (newPort === 0) throw AppError.Internal("端口范围耗尽");

  // 8. 启动新进程 + 探活
  const oldPort = app.port;
  await state.customProcessManager.startAndWait({
    appId: id,
    port: newPort,
    codeDir: deployDir,
    runtimeDir,
    entryFile,
  }, 10);

  // 9. 原子切换
  const updated = {
    ...app,
    active_slot: targetSlot,
    entry_file: entryFile,
    port: newPort,
    status: "running" as const,
    updated_at: new Date().toISOString(),
  };
  await state.store.update(updated);
  await state.store.flush();

  // 10. 停旧进程
  if (oldPort > 0 && oldPort !== newPort) {
    await state.customProcessManager.stop(id).catch(() => {});
  }

  return Response.json({
    data: {
      files: written.length,
      total_bytes: totalBytes,
      entry_file: entryFile,
      slot: targetSlot,
      port: newPort,
    },
    error: null,
  });
}
