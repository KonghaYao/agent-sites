// POST /api/apps/{id}/deploy —— 上传 gzip 包并部署自定义应用。
import type { Ctx } from "./apps.ts";
import { AppError } from "../error.ts";
import { UntarStream } from "jsr:@std/tar@^0.1.10/untar-stream";
import { PortAllocator } from "../process/port_allocator.ts";
import { probePortFree } from "../process/pocketbase.ts";

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
  // used 合并：apps.json 持久化端口（含 custom port + pb_port）+
  // 并发 deploy 的端口声明（reservedPorts）。usedPorts 是快照，两个并发
  // deploy 若都读到旧状态会分到同一端口（R5），reserve 声明是同步的，
  // 在 allocate 与 spawn 之间挡住后来的分配。
  const usedPorts = await state.store.usedPorts();
  for (const p of state.customProcessManager.reservedPorts) usedPorts.add(p);
  const allocator = new PortAllocator(state.portMin, state.portMax);
  const newPort = allocator.allocate(usedPorts);
  if (newPort === 0) throw AppError.Internal("端口范围耗尽");
  // 分配后探测端口可绑定性（R3）：used 快照不含「未记录但真实占用」的端口
  // （外部进程/泄漏的孤儿），spawn 后 bind 失败 + tcpHealthCheck 会连到其他
  // 进程的假健康。probe 失败直接拒绝本次部署。
  if (!probePortFree(newPort)) {
    throw AppError.Conflict(`端口 ${newPort} 被占用，请稍后重试部署`);
  }
  // 同步声明端口占用（防并发 deploy 分到同一端口），成功/失败路径均需释放
  state.customProcessManager.reservePort(newPort);

  // 7b. 如果 enable_pb，确保 PB 进程存活
  let pbUrl: string | undefined;
  let pbSuperuserEmail: string | undefined;
  let pbSuperuserPassword: string | undefined;
  /** PB 换端口后的实际端口（未换则保持 app.pb_port） */
  let pbPortAfterRestart: number | undefined;
  if (app.enable_pb && app.pb_port && app.pb_port > 0) {
    try {
      // 端口被外部进程占用时允许换端口重启，返回新端口供 pbUrl 与持久化。
      // 关键（R1）：pbUsed 必须并入 newPort——allocateProbedPort 从端口段
      // 下限向上扫，若不含 newPort，PB 换端口时第一个可绑定端口就是 newPort
      // （最小空闲、未持久化、此刻无人监听）→ PB 抢走 custom 的新端口 →
      // custom bind 失败 + 假健康。reservedPorts 同理（其他并发 deploy 的
      // 新端口此刻也无人监听，probe 挡不住）。
      const pbUsed = new Set(usedPorts);
      for (const p of state.processManager.processes.values()) {
        pbUsed.add(p.port);
      }
      pbUsed.add(newPort);
      for (const p of state.customProcessManager.reservedPorts) pbUsed.add(p);
      const pbAllocator = new PortAllocator(state.portMin, state.portMax);
      const pbResult = await state.processManager.restartIfNeeded(
        id,
        `${state.dataDir}/${id}`,
        app.pb_port!,
        { allocator: pbAllocator, used: pbUsed },
      );
      const actualPbPort = state.processManager.getPort(id);
      if (actualPbPort !== undefined && actualPbPort !== app.pb_port) {
        // app 是函数参数（const），换端口结果通过变量传递到 updated 持久化
        pbPortAfterRestart = actualPbPort;
      }
      if (pbResult.outcome === "GiveUp" || pbResult.outcome === "RateLimited") {
        throw new Error(
          `PB 重启失败: ${state.processManager.lastRestartFailure.get(id) ?? pbResult.outcome}`,
        );
      }
      pbUrl = `http://localhost:${actualPbPort ?? app.pb_port}`;
      pbSuperuserEmail = app.superuser_email;
      pbSuperuserPassword = app.superuser_password;
    } catch (e) {
      console.warn(
        `enable_pb: PB 重启失败 app_id=${id} error=${(e as Error).message}`,
      );
      throw AppError.ServiceUnavailable(`App ${id} PB 后端不可用`);
    }
  }

  // 8. 启动新进程 + 探活
  try {
    await state.customProcessManager.startAndWait({
      appId: id,
      port: newPort,
      codeDir: deployDir,
      runtimeDir,
      entryFile,
      pbUrl,
      pbSuperuserEmail,
      pbSuperuserPassword,
    }, 10);
  } catch (e) {
    // 启动失败：释放端口声明，让后续部署可复用
    state.customProcessManager.releasePort(newPort);
    throw e;
  }

  // 9. 原子切换
  const updated = {
    ...app,
    active_slot: targetSlot,
    entry_file: entryFile,
    port: newPort,
    ...(pbPortAfterRestart !== undefined ? { pb_port: pbPortAfterRestart } : {}),
    status: "running" as const,
    updated_at: new Date().toISOString(),
  };
  await state.store.update(updated);
  await state.store.flush();
  // 新进程已接管（端口真实绑定），释放端口声明
  state.customProcessManager.releasePort(newPort);
  // 注：旧进程的回收由 startAndWait 按引用完成（R2）。这里不能再调
  // customProcessManager.stop(id)——map 已被替换为新进程，stop(id) 会
  // 误杀刚部署好的新进程。

  return Response.json({
    data: {
      files: written.length,
      total_bytes: totalBytes,
      entry_file: entryFile,
      slot: targetSlot,
      port: newPort,
      ...(app.enable_pb && pbUrl ? { pb_url: pbUrl } : {}),
    },
    error: null,
  });
}
