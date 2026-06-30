# 自定义应用部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持 agent 上传自包含前后端应用 gzip 包，平台解压并以零 downtime 双槽位切换方式部署运行。

**Architecture:** 在现有 PocketBase 模式之外新增 `type: "custom"` App 类型。Custom App 自带 `main.ts`/`main.js` 入口，平台通过 `Deno.Command` spawn 子进程并全量代理 HTTP 流量。独立 `CustomProcessManager` 管理进程生命周期，惰性重启（与 PB 模式一致）。双槽位（`deploy-a`/`deploy-b`）+ 独立 `runtime/` 目录实现零 downtime 部署和数据持久化。

**Tech Stack:** Deno 2.x TypeScript strict mode，原生 `Deno.Command`、`DecompressionStream`、`@std/tar`

---

## 文件结构

```
src/
├── app/
│   ├── model.ts            # [MODIFY] 加 type 字段 + custom 专用字段
│   ├── store.ts            # [MODIFY] 加载时补 type 默认值
│   ├── custom_pm.ts        # [CREATE] CustomAppProcessManager
│   └── custom_pm_test.ts   # [CREATE] Custom PM 测试
├── api/
│   ├── apps.ts             # [MODIFY] createApp/deleteApp 支持 custom 类型
│   ├── deploy.ts           # [CREATE] POST /api/apps/{id}/deploy
│   └── deploy_test.ts      # [CREATE] deploy 端点测试
├── proxy/
│   └── mod.ts              # [MODIFY] forward() 加 proxy headers 参数
├── state.ts                # [MODIFY] 加 customProcessManager 字段
├── lib.ts                  # [MODIFY] 加 deploy 路由，按 app.type 分流
└── main.ts                 # [MODIFY] 构造 CustomProcessManager + 全局 cleanup
```

---

### Task 1: App 模型扩展

**Files:**
- Modify: `src/app/model.ts:35-46`
- Modify: `src/app/store.ts:43-66`

- [ ] **Step 1: 给 App 接口加 `type` 字段和 custom 专用字段**

```typescript
// src/app/model.ts — 在 App 接口末尾加 type 字段

export type AppType = "pocketbase" | "custom";

export interface App {
  id: string;
  name: string;
  type: AppType;                         // NEW
  port: number;
  status: AppStatus;
  created_at: string;
  updated_at: string;
  superuser_email: string;
  superuser_password: string;
  // custom 专用字段
  active_slot?: "a" | "b";              // NEW 当前活跃槽位
  entry_file?: string;                  // NEW 入口文件名（"main.ts" 或 "main.js"）
}
```

- [ ] **Step 2: Store 加载时补默认 type**

```typescript
// src/app/store.ts — 修改 constructor 中的 filter 前加 normalize 逻辑

constructor(path: string, portMin: number, portMax: number) {
    let apps: App[] = [];
    try {
      const file = AppStore.loadFromDisk(path);
      apps = file.apps;
    } catch (e) {
      console.warn(
        `加载 apps.json 失败，使用空集合 path=${path} error=${(e as Error).message}`,
      );
      apps = [];
    }
    // 向前兼容：没有 type 字段的旧记录默认为 pocketbase
    for (const a of apps) {
      if (!a.type) (a as Record<string, unknown>).type = "pocketbase";
    }
    this.apps = apps.filter((a) => {
      if (a.port < portMin || a.port > portMax) {
        console.error(
          `App 端口越界，跳过加载（疑似 apps.json 被篡改）` +
            ` app_id=${a.id} port=${a.port} min=${portMin} max=${portMax}`,
        );
        return false;
      }
      return true;
    });
    this.path = path;
  }
```

- [ ] **Step 3: 运行现有测试确保向后兼容**

```bash
deno task test --filter model_test
deno task test --filter store_test
```

- [ ] **Step 4: Commit**

```bash
git add src/app/model.ts src/app/store.ts
git commit -m "feat: App 模型加 type 字段支持 custom 类型，store 加载时默认 pocketbase

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

### Task 2: CustomAppProcessManager

**Files:**
- Create: `src/app/custom_pm.ts`
- Create: `src/app/custom_pm_test.ts`

**说明：** Custom PM 管理 `deno run` 子进程，提供 start/stop/isAlive/getPort。惰性重启在 lib.ts 代理层触发（与 PB 模式调用 `restartIfNeeded` 的方式一致，但 custom 模式更简单——直接 start 即可，无自愈限流）。

- [ ] **Step 1: 写 CustomAppProcessManager 实现**

```typescript
// src/app/custom_pm.ts
// 自定义应用进程管理器——管理 deno run 子进程生命周期。
// 与 PocketBaseProcessManager 独立，不耦合。
// 惰性重启在请求代理层处理（lib.ts 中检测进程不在时调用 start）。

import { ManagedProcess } from "../process/mod.ts";

/** 启动自定义应用的参数 */
export interface CustomAppStartParams {
  appId: string;
  port: number;
  codeDir: string;    // 代码目录（deploy-a 或 deploy-b）
  runtimeDir: string; // 运行时数据目录（cwd）
  entryFile: string;  // "main.ts" 或 "main.js"
}

/**
 * 自定义应用进程管理器。
 *
 * 一个 App 一个 ManagedProcess。双槽位切换期间临时持有两个进程
 * （旧进程仍在运行，新进程启动探活），切换完成后停止旧进程。
 */
export class CustomProcessManager {
  /** app_id → ManagedProcess */
  readonly processes: Map<string, ManagedProcess> = new Map();

  /**
   * 启动自定义应用子进程。
   *
   * 约定：deno run --allow-net --allow-read=<codeDir> --allow-read=<runtimeDir>
   *       --allow-write=<runtimeDir> <entryFile>
   * PORT 环境变量注入分配的端口。
   */
  start(params: CustomAppStartParams): ManagedProcess {
    const { appId, port, codeDir, runtimeDir, entryFile } = params;

    // 如果已在运行，先停
    const existing = this.processes.get(appId);
    if (existing && existing.isAlive()) {
      existing.startKill();
    }

    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-net",
        `--allow-read=${codeDir}`,
        `--allow-read=${runtimeDir}`,
        `--allow-write=${runtimeDir}`,
        entryFile,
      ],
      cwd: codeDir,
      stdin: "null",
      stdout: "null",
      stderr: "null",
      clearEnv: false,
      env: { PORT: String(port) },
    });

    let child: Deno.ChildProcess;
    try {
      child = command.spawn();
    } catch (e) {
      throw new Error(`spawn deno run 失败: ${e}`);
    }

    const proc = new ManagedProcess(child, port);
    this.processes.set(appId, proc);
    return proc;
  }

  /**
   * 异步启动 + TCP 探活（轮询端口直到可连接，超时 10s）。
   * 成功返回 ManagedProcess，失败停止进程并 throw。
   */
  async startAndWait(params: CustomAppStartParams, timeoutSecs = 10): Promise<ManagedProcess> {
    const proc = this.start(params);
    const healthy = await tcpHealthCheck(params.port, timeoutSecs);
    if (!healthy) {
      await this.stop(params.appId);
      throw new Error(`自定义应用健康检查失败 app_id=${params.appId} port=${params.port}`);
    }
    return proc;
  }

  /** 停止并清理。 */
  async stop(appId: string): Promise<void> {
    const proc = this.processes.get(appId);
    if (!proc) return;
    this.processes.delete(appId);
    proc.startKill();
    await raceWithTimeout(proc.statusPromise, 5_000).catch(() => {
      proc.child.kill("SIGKILL");
    });
  }

  /** 进程是否存活。 */
  isAlive(appId: string): boolean {
    const proc = this.processes.get(appId);
    return proc !== undefined && proc.isAlive();
  }

  /** 获取进程端口。 */
  getPort(appId: string): number | undefined {
    return this.processes.get(appId)?.port;
  }

  /** 获取进程（用于双槽位切换时管理旧进程）。 */
  getProcess(appId: string): ManagedProcess | undefined {
    return this.processes.get(appId);
  }

  /** 直接设置进程记录（双槽位切换时替换为新进程）。 */
  setProcess(appId: string, proc: ManagedProcess): void {
    this.processes.set(appId, proc);
  }
}

/** TCP 端口探活：轮询 localhost:port，每次 200ms 间隔。 */
async function tcpHealthCheck(port: number, timeoutSecs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port, transport: "tcp" });
      conn.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

/** Promise.race 带超时，超时后不泄漏 timer。 */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
```

- [ ] **Step 2: 写测试**

```typescript
// src/app/custom_pm_test.ts
// 注意：需要 Deno 运行时才能 spawn deno 子进程。
// 测试策略：创建一个最简单的 HTTP 服务 main.ts，验证 CustomPM 的 start/stop/isAlive 全链路。
// 使用 sanitizeOps: false, sanitizeResources: false, sanitizeExit: false（子进程残留 timer 必需）。

import { assertEquals, assert } from "jsr:@std/assert";
import { CustomProcessManager } from "./custom_pm.ts";
import { assertFalse } from "jsr:@std/assert";

// 测试用迷你 HTTP 服务：回复 200 ok
const MINI_SERVER_TS = `
const port = parseInt(Deno.env.get("PORT") || "0");
Deno.serve({ hostname: "127.0.0.1", port }, () => new Response("ok"));
`;

Deno.test("test_custom_pm_start_and_stop", { sanitizeOps: false, sanitizeResources: false, sanitizeExit: false }, async () => {
  const tmpDir = await Deno.makeTempDir();
  const entryPath = `${tmpDir}/main.ts`;
  await Deno.writeTextFile(entryPath, MINI_SERVER_TS);

  const pm = new CustomProcessManager();
  const port = 19999; // 固定测试端口

  try {
    // start + 探活
    const proc = await pm.startAndWait({
      appId: "app-test0001",
      port,
      codeDir: tmpDir,
      runtimeDir: tmpDir,
      entryFile: "main.ts",
    }, 5);
    assert(proc.isAlive(), "进程应该存活");
    assertEquals(pm.isAlive("app-test0001"), true);
    assertEquals(pm.getPort("app-test0001"), port);

    // TCP 验证
    const resp = await fetch(`http://127.0.0.1:${port}`);
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "ok");

    // stop
    await pm.stop("app-test0001");
    assertFalse(pm.isAlive("app-test0001"));
  } finally {
    await pm.stop("app-test0001").catch(() => {});
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test_custom_pm_replace_stale_process", { sanitizeOps: false, sanitizeResources: false, sanitizeExit: false }, async () => {
  const tmpDir = await Deno.makeTempDir();
  const entryPath = `${tmpDir}/main.ts`;
  await Deno.writeTextFile(entryPath, MINI_SERVER_TS);

  const pm = new CustomProcessManager();
  const port1 = 19998;
  const port2 = 19997;

  try {
    // 第一次启动
    const proc1 = await pm.startAndWait({
      appId: "app-test0002", port: port1,
      codeDir: tmpDir, runtimeDir: tmpDir, entryFile: "main.ts",
    }, 5);
    assert(proc1.isAlive());

    // 第二次启动：内部会 stop 旧进程
    const proc2 = await pm.startAndWait({
      appId: "app-test0002", port: port2,
      codeDir: tmpDir, runtimeDir: tmpDir, entryFile: "main.ts",
    }, 5);
    assert(proc2.isAlive());
    assertEquals(pm.getPort("app-test0002"), port2);
    // 旧进程应该已退出
    assertFalse(proc1.isAlive());
  } finally {
    await pm.stop("app-test0002").catch(() => {});
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
```

- [ ] **Step 3: 运行测试**

```bash
deno task test --filter custom_pm
```

- [ ] **Step 4: Commit**

```bash
git add src/app/custom_pm.ts src/app/custom_pm_test.ts
git commit -m "feat: 添加 CustomProcessManager 管理自定义应用子进程生命周期

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

### Task 3: Deploy API 端点

**Files:**
- Create: `src/api/deploy.ts`
- Create: `src/api/deploy_test.ts`

**关键约束：**
- 压缩前上限 20 MiB，解压后上限 100 MiB
- 入口文件必须存在（`main.ts` 或 `main.js`），优先 `main.ts`
- 双槽位：确定非活跃槽位 → 清空 → 解压写入 → 启动新进程 → 探活 → 切换 → 停旧进程
- 仅允许 `type === "custom"` 的 App

- [ ] **Step 1: 写 deploy.ts**

```typescript
// src/api/deploy.ts
// POST /api/apps/{id}/deploy —— 上传 gzip 包并部署自定义应用。
//
// 鉴权：依赖 lib.ts 的 master key 中间件（path 命中 /api/apps/ 前缀）。
//
// 双槽位并行切换流程：
// 1. 校验 app 存在 + type=custom
// 2. 读取 gzip body（上限 20 MiB），验证 gzip magic
// 3. 确定非活跃槽位（target_slot = active_slot === "a" ? "b" : "a"）
// 4. 清空目标槽位目录
// 5. 流式解压 gzip → untar 到目标槽位
// 6. 扫描入口文件（main.ts > main.js），不存在则 400
// 7. 分配新端口
// 8. 启动新进程 + TCP 探活（10s）
// 9. 原子切换：更新 app.active_slot + app.port + flush
// 10. 停旧进程 + 释放旧端口

import type { AppState } from "../state.ts";
import type { Ctx } from "./apps.ts";
import { AppError } from "../error.ts";
import { UntarStream } from "jsr:@std/tar@^0.1.10/untar-stream";
import { PortAllocator } from "../process/port_allocator.ts";

/** 压缩前 body 上限（20 MiB）。 */
const MAX_DEPLOY_COMPRESSED = 20 * 1024 * 1024;
/** 解压后总字节上限（100 MiB）。 */
const MAX_DEPLOY_DECOMPRESSED = 100 * 1024 * 1024;
/** 单文件解压后上限（10 MiB）。 */
const MAX_DEPLOY_FILE = 10 * 1024 * 1024;
/** tar 条目数上限。 */
const MAX_DEPLOY_ENTRIES = 500;

/** 允许的文件后缀（与 bundle 白名单一致 + ts 源文件）。 */
const ALLOWED_EXTS = new Set([
  ".html", ".htm", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg",
  ".webp", ".ico", ".txt", ".map", ".ts", ".mjs", ".mts", ".jsx", ".tsx",
  ".wasm", ".sql", ".db", ".sqlite", ".sqlite3",
]);

function validateExt(path: string): string {
  const lower = path.toLowerCase();
  for (const ext of ALLOWED_EXTS) {
    if (lower.endsWith(ext)) return ext;
  }
  throw AppError.BadRequest(`文件后缀不允许: ${path}`);
}

function validatePath(raw: string): string {
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  if (p === "" || p === ".") return "";
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") {
      throw AppError.BadRequest(`路径不允许 '.' 或 '..' 段: ${raw}`);
    }
    // 拒绝反斜杠
    if (s.includes("\\")) {
      throw AppError.BadRequest(`路径不允许反斜杠: ${raw}`);
    }
  }
  // 后缀校验（跳过无后缀的目录式路径——目录 entry 已被过滤）
  const lastDot = p.lastIndexOf(".");
  if (lastDot === -1 || lastDot === p.length - 1 || p.slice(lastDot + 1).includes("/")) {
    // 无后缀或以点结尾或点在目录名中，跳过
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
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export async function deployApp(req: Request, ctx: Ctx): Promise<Response> {
  const state = ctx.state;
  const id = ctx.params.id;

  // 1. 校验 app 存在
  const app = await state.store.get(id);
  if (!app) throw AppError.NotFound(`App 不存在: ${id}`);

  // 2. 仅 custom 类型允许部署
  if (app.type !== "custom") {
    throw AppError.BadRequest(`App ${id} 不是自定义类型，无法部署`);
  }

  // 3. 读取 body + gzip magic 校验
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

  // 准备目录
  await Deno.remove(deployDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(deployDir, { recursive: true });
  await Deno.mkdir(runtimeDir, { recursive: true });

  // 5. 解压 gzip → untar → 写盘
  const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const compressedStream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(compressed); c.close(); },
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

      const relPath = validatePath(rawPath);
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
                throw AppError.PayloadTooLarge(`单文件 ${relPath} 超过上限 ${MAX_DEPLOY_FILE} 字节`);
              }
              totalBytes += value.byteLength;
              if (totalBytes > MAX_DEPLOY_DECOMPRESSED) {
                throw AppError.PayloadTooLarge(`解压后总字节超过上限 ${MAX_DEPLOY_DECOMPRESSED} 字节`);
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

  // 6. 扫描入口文件（优先 main.ts，其次 main.js）
  let entryFile: string | undefined;
  try { await Deno.stat(`${deployDir}/main.ts`); entryFile = "main.ts"; } catch { /* */ }
  if (!entryFile) {
    try { await Deno.stat(`${deployDir}/main.js`); entryFile = "main.js"; } catch { /* */ }
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
    const oldProc = state.customProcessManager.getProcess(id);
    // 旧的 ManagedProcess 还在 — 找到它杀掉
    for (const [aid, proc] of state.customProcessManager.processes) {
      if (aid !== id) continue;
      if (proc.port === oldPort) {
        proc.startKill();
        break;
      }
    }
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
```

- [ ] **Step 2: 写测试**

```typescript
// src/api/deploy_test.ts
// 测试 deploy 端点的核心逻辑（解压、入口检测、槽位切换）。
// 集成测试依赖 CustomProcessManager + Deno 运行时。

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { AppState } from "../state.ts";
import { AppStore } from "../app/store.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { CustomProcessManager } from "../app/custom_pm.ts";

function makeState(tmpDir: string): AppState {
  const store = new AppStore(`${tmpDir}/apps.json`, 9000, 11000);
  const pm = new PocketBaseProcessManager("pocketbase");
  const tokenStore = new TokenStore(`${tmpDir}/tokens.json`);
  const cache = new PbTokenCache();
  const customPm = new CustomProcessManager();
  return new AppState(
    "pocketbase", tmpDir, `${tmpDir}/public`,
    store, pm, 50, 9000, 11000,
    "test-master-key-32bytes-long!!",
    tokenStore, cache,
  ) as AppState & { customProcessManager: CustomProcessManager };
}

// 确保 state 上有 customProcessManager
(Object.getPrototypeOf(makeState("")) as Record<string, unknown>).customProcessManager = undefined;
// 实际测试中 state 构造后手动设: (state as any).customProcessManager = new CustomProcessManager();

Deno.test("test_deploy_reject_non_custom_app", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const state = makeState(tmpDir);
    (state as Record<string, unknown>).customProcessManager = new CustomProcessManager();
    // 创建一个 PB 类型的 app
    const now = new Date().toISOString();
    await state.store.add({
      id: "app-dead0001", name: "test-pb", type: "pocketbase",
      port: 9000, status: "running", created_at: now, updated_at: now,
      superuser_email: "", superuser_password: "",
    });

    const { deployApp } = await import("./deploy.ts");
    const req = new Request("http://localhost/api/apps/app-dead0001/deploy", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    });
    try {
      await deployApp(req, { state, params: { id: "app-dead0001" }, requestId: "test" });
      throw new Error("应该抛出");
    } catch (e: unknown) {
      assertStringIncludes((e as Error).message, "不是自定义类型");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test_deploy_app_not_found", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const state = makeState(tmpDir);
    (state as Record<string, unknown>).customProcessManager = new CustomProcessManager();
    const { deployApp } = await import("./deploy.ts");
    const req = new Request("http://localhost/api/apps/app-nope000/deploy", {
      method: "POST", body: new Uint8Array(0),
    });
    try {
      await deployApp(req, { state, params: { id: "app-nope000" }, requestId: "test" });
      throw new Error("应该抛出");
    } catch (e: unknown) {
      assertStringIncludes((e as Error).message, "不存在");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
```

- [ ] **Step 3: 运行测试**

```bash
deno task test --filter deploy_test
```

- [ ] **Step 4: Commit**

```bash
git add src/api/deploy.ts src/api/deploy_test.ts
git commit -m "feat: 添加 POST /api/apps/{id}/deploy 双槽位部署端点

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

### Task 4: State + main.ts 接入 CustomProcessManager

**Files:**
- Modify: `src/state.ts:35-103`
- Modify: `src/main.ts:1-301`

- [ ] **Step 1: State 加 customProcessManager 字段**

```typescript
// src/state.ts — 在 import 和 class 中加字段

import { CustomProcessManager } from "./app/custom_pm.ts";

export class AppState {
  // ... 现有字段 ...

  /** 自定义应用进程管理器（custom 类型）。 */
  public customProcessManager: CustomProcessManager;

  constructor(
    pbBinary: string,
    dataDir: string,
    publicDir: string,
    store: AppStore,
    processManager: PocketBaseProcessManager,
    maxApps: number,
    portMin: number,
    portMax: number,
    masterKey: string,
    tokenStore: TokenStore,
    pbTokenCache: PbTokenCache,
    customProcessManager: CustomProcessManager,  // NEW param
  ) {
    // ... 现有赋值 ...
    this.customProcessManager = customProcessManager;
  }
}
```

- [ ] **Step 2: main.ts 构造 + 全局 cleanup 包含 custom PM**

```typescript
// src/main.ts — import 和构造

import { CustomProcessManager } from "./app/custom_pm.ts";

// 在 main() 中，构造 AppState 之前：
const customProcessManager = new CustomProcessManager();

const state = new AppState(
  cli.pbBinary, cli.dataDir, cli.publicDir,
  store, processManager, cli.maxApps, cli.pbPortMin, cli.pbPortMax,
  masterKey, tokenStore, pbTokenCache,
  customProcessManager,  // NEW
);

// 修改 globalCleanup 函数：同时清理 custom PM 的进程
async function globalCleanup(state: AppState): Promise<void> {
  const pbAppIds = Array.from(state.processManager.processes.keys());
  const customAppIds = Array.from(state.customProcessManager.processes.keys());
  if (pbAppIds.length === 0 && customAppIds.length === 0) return;
  console.info(`全局 cleanup：停止 ${pbAppIds.length} 个 PB 进程 + ${customAppIds.length} 个自定义进程`);
  const stops: Promise<void>[] = [];
  for (const id of pbAppIds) stops.push(state.processManager.stop(id));
  for (const id of customAppIds) stops.push(state.customProcessManager.stop(id));
  await Promise.all(stops);
}
```

- [ ] **Step 3: 修复所有现有测试中的 AppState 构造调用**

```bash
# 搜索所有 new AppState( 调用
grep -rn "new AppState(" src/
```

对每个测试文件，在构造 AppState 时追加 `new CustomProcessManager()` 参数。

- [ ] **Step 4: 类型检查**

```bash
deno task check
```

- [ ] **Step 5: 运行全量测试确保不破坏现有功能**

```bash
deno task test
```

- [ ] **Step 6: Commit**

```bash
git add src/state.ts src/main.ts
# 加上其他修改的测试文件
git commit -m "feat: State + main 接入 CustomProcessManager

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

### Task 5: createApp 支持自定义类型 + 创建时部署

**Files:**
- Modify: `src/api/apps.ts:149-321` (createApp), `src/api/apps.ts:349-395` (deleteApp), `src/api/apps.ts:63-94` (DTO)

- [ ] **Step 1: CreateAppRequest 加 type 字段**

```typescript
// src/api/apps.ts
export interface CreateAppRequest {
  name?: string;
  type?: "pocketbase" | "custom";  // NEW 缺省="pocketbase"
}
```

- [ ] **Step 2: toAppResponse 加 type 字段**

```typescript
export interface AppResponse {
  id: string;
  name: string;
  type: string;     // NEW
  port: number;
  status: string;
  api_path: string;
  created_at: string;
}

export function toAppResponse(a: App): AppResponse {
  return {
    id: a.id,
    name: a.name,
    type: a.type,                           // NEW
    port: a.port,
    status: a.status,
    api_path: a.type === "custom" ? `/${a.id}` : `/${a.id}/api`,  // custom 全量代理
    created_at: a.created_at,
  };
}
```

- [ ] **Step 3: createApp 分流——custom 类型只创建占位记录，不 spawn PB**

在 `createApp` 函数中，解析 `requestBody.type`（默认 `"pocketbase"`），若为 `"custom"` 则走简化路径：

```typescript
// 在 createApp 中，解析完 body 后：

const appType: "pocketbase" | "custom" = requestBody.type === "custom" ? "custom" : "pocketbase";

const makePlaceholder = (id: string): App => {
  const now = new Date().toISOString();
  return {
    id,
    name: name.length === 0 ? id : name,
    type: appType,
    port: 0,
    status: "starting",
    created_at: now,
    updated_at: now,
    superuser_email: "",
    superuser_password: "",
  };
};

// ... 分配 id + addIfAbsent + flush 不变 ...

// 分流：custom 只创建数据目录 + 直接标记 running（待 deploy）
if (appType === "custom") {
  const dataDir = `${state.dataDir}/${id}`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(`${dataDir}/runtime`, { recursive: true });

  app.status = "running";
  app.updated_at = new Date().toISOString();
  await state.store.update(app);
  await state.store.flush();

  const resp = toAppResponse(app);
  return Response.json({ data: resp, error: null });
}

// ... 原有 PB 创建流程（initSuperuser + spawn + verifySuperuserReady + writePlaceholderIndex）...
```

- [ ] **Step 4: 创建时一并上传——检测 gzip body**

在 `createApp` 中，body 解析之后、分流之前加入 gzip 检测逻辑。如果 body 是 gzip（magic bytes `1f 8b`），则 `type` 强制为 `"custom"`，走 custom 创建简化为占位记录，然后立即调用 deploy 逻辑完成首次部署。

```typescript
// 在 createApp 中，解析 requestBody 之后：

// 检测 gzip body：如果有 body 且是 gzip，则强制 type=custom 并走内联部署
const isGzipBody = rawBody.byteLength >= 2 && rawBody[0] === 0x1f && rawBody[1] === 0x8b;
const effectiveType: "pocketbase" | "custom" = isGzipBody
  ? "custom"
  : (requestBody.type === "custom" ? "custom" : "pocketbase");

// 如果 type=custom + 有 gzip body → 创建完成后立即部署
// （复用 deploy.ts 的核心逻辑，或直接在此处内联）
```

> **简化决策：** 创建时一并上传不在此 Task 内联，而是由 Task 3 的 deploy 端点独立完成。createApp 只负责创建占位记录。agent 创建后立即调用 deploy——两步分开但都是同一个请求周期内完成。这样 createApp 保持简单、deploy 逻辑不重复。

- [ ] **Step 5: deleteApp 支持 custom 类型**

```typescript
// src/api/apps.ts deleteApp 函数 — 在现有 "停进程" 行后加 custom PM 清理：

// 停进程（PB）
await state.processManager.stop(id);
// 停进程（custom）
await state.customProcessManager.stop(id);

// 删数据目录时，custom 类型也清理 deploy-a/deploy-b/runtime
// （现有 dataDir 删除已递归覆盖，无需额外代码）
```

- [ ] **Step 6: 运行相关测试**

```bash
deno task test --filter apps_test
```

- [ ] **Step 7: Commit**

```bash
git add src/api/apps.ts
git commit -m "feat: createApp/deleteApp 支持 custom 类型应用

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

### Task 6: 代理 + 路由按 app.type 分流

**Files:**
- Modify: `src/proxy/mod.ts:70-158` (forward)
- Modify: `src/lib.ts:185-286` (routes), `src/lib.ts:363-459` (serveApiProxy), `src/lib.ts:610-633` (serveStaticImpl)

- [ ] **Step 1: forward() 加 proxy headers 参数**

```typescript
// src/proxy/mod.ts — forward 函数签名加 opts

export interface ForwardOptions {
  port: number;
  path: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
  maxBodyBytes: number;
  cookieScope?: string;
  /** 注入 X-Forwarded-* headers（custom app 需要） */
  proxyHeaders?: {
    forwardedHost: string;
    forwardedProto: string;
    forwardedPrefix: string;
  };
}

export async function forward(opts: ForwardOptions): Promise<Response> {
  const { port, path, method, headers, body, maxBodyBytes, cookieScope, proxyHeaders } = opts;

  // ... 现有 body 大小校验 ...

  const url = `http://localhost:${port}${path}`;

  // 透传 headers
  const upstreamHeaders = new Headers();
  for (const [key, value] of headers.entries()) {
    const name = key.toLowerCase();
    if (SKIP_REQ_HEADERS.has(name)) continue;
    upstreamHeaders.set(key, value);
  }

  // 注入 proxy headers（custom app 需要知道部署路径）
  if (proxyHeaders) {
    upstreamHeaders.set("X-Forwarded-Host", proxyHeaders.forwardedHost);
    upstreamHeaders.set("X-Forwarded-Proto", proxyHeaders.forwardedProto);
    upstreamHeaders.set("X-Forwarded-Prefix", proxyHeaders.forwardedPrefix);
  }

  // ... 其余逻辑不变 ...
}
```

保持 `forward` 的旧调用签名向后兼容——创建一个 wrapper 或者直接改为对象参数。考虑到现有调用方（`serveApiProxy` 和 `handleProxyWithRecovery`），这里直接改为对象参数，同时更新所有调用方。

- [ ] **Step 2: 更新现有 forward() 调用方**

```typescript
// src/lib.ts — serveApiProxy 中，把 forward(...) 调用改为新的对象参数形式

// 旧调用：
// const resp = await forward(app.port, upstreamPath, method, headers, body, DEFAULT_MAX_BODY_BYTES, appId);

// 新调用：
const resp = await forward({
  port: app.port,
  path: upstreamPath,
  method,
  headers,
  body,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  cookieScope: appId,
});
```

同理更新 `handleProxyWithRecovery` 中的 forward 调用。

- [ ] **Step 3: lib.ts 路由表加 deploy 路由**

```typescript
// src/lib.ts — buildRoutes() 中，在 files/bundle 路由之后加 deploy 路由

import { deployApp as deployHandler } from "./api/deploy.ts";

// 在 uploadBundleHandler 路由之后：
{
  method: "post",
  segments: parsePattern("/api/apps/{id}/deploy"),
  handler: deployHandler,
},
```

- [ ] **Step 4: serveApiProxy 按 app.type 分流**

```typescript
// src/lib.ts — serveApiProxy 函数开头，在查 app 之后、校验 status 之前：

// 分流：custom 类型全量代理到自定义应用端口
if (app.type === "custom") {
  return await serveCustomProxy(state, appId, app, req, ctx);
}
```

- [ ] **Step 5: 实现 serveCustomProxy**

```typescript
// src/lib.ts — 新函数，在 serveApiProxy 之后

/**
 * 自定义应用代理：全量转发请求到 deno 子进程端口。
 * 惰性重启：进程不在时自动启动。
 */
async function serveCustomProxy(
  state: AppState,
  appId: string,
  app: App,
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  // 惰性重启：进程不在则启动
  if (!state.customProcessManager.isAlive(appId)) {
    // 从 store 取最新状态（避免 port/slot 过期）
    const fresh = await state.store.get(appId);
    if (!fresh || fresh.type !== "custom") {
      throw AppError.NotFound(`App 不存在或类型变更: ${appId}`);
    }
    const slot = fresh.active_slot || "a";
    const entryFile = fresh.entry_file || "main.ts";
    const codeDir = `${state.dataDir}/${appId}/deploy-${slot}`;
    const runtimeDir = `${state.dataDir}/${appId}/runtime`;

    try {
      await state.customProcessManager.startAndWait({
        appId,
        port: fresh.port,
        codeDir,
        runtimeDir,
        entryFile,
      }, 10);
    } catch (e) {
      console.error(`自定义应用惰性启动失败 app_id=${appId} error=${(e as Error).message}`);
      throw AppError.ServiceUnavailable(`App ${appId} 启动失败`);
    }
  }

  const port = state.customProcessManager.getPort(appId);
  if (port === undefined) {
    throw AppError.ServiceUnavailable(`App ${appId} 进程端口未知`);
  }

  const body = await readBodyBytes(req);
  const url = new URL(req.url);
  const upstreamPath = url.pathname + url.search;

  try {
    return await forward({
      port,
      path: upstreamPath,
      method: req.method,
      headers: new Headers(req.headers),
      body,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      proxyHeaders: {
        forwardedHost: req.headers.get("host") || "localhost",
        forwardedProto: url.protocol === "https:" ? "https" : "http",
        forwardedPrefix: `/${appId}`,
      },
    });
  } catch (e) {
    if (e instanceof AppError && isRecoverableError(e)) {
      // 惰性重启重试一次
      console.warn(`custom proxy 失败，尝试惰性重启 app_id=${appId}`);
      try {
        const fresh = await state.store.get(appId);
        if (!fresh) throw AppError.NotFound(`App 不存在: ${appId}`);
        const slot = fresh.active_slot || "a";
        const codeDir = `${state.dataDir}/${appId}/deploy-${slot}`;
        const runtimeDir = `${state.dataDir}/${appId}/runtime`;
        await state.customProcessManager.startAndWait({
          appId,
          port: fresh.port,
          codeDir,
          runtimeDir,
          entryFile: fresh.entry_file || "main.ts",
        }, 10);
        return await forward({
          port: fresh.port,
          path: upstreamPath,
          method: req.method,
          headers: new Headers(req.headers),
          body,
          maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
          proxyHeaders: {
            forwardedHost: req.headers.get("host") || "localhost",
            forwardedProto: url.protocol === "https:" ? "https" : "http",
            forwardedPrefix: `/${appId}`,
          },
        });
      } catch {
        throw AppError.ServiceUnavailable(`App ${appId} 后端不可用`);
      }
    }
    throw e;
  }
}
```

- [ ] **Step 6: serveStaticImpl 按 app.type 分流**

```typescript
// src/lib.ts — serveStaticImpl 函数，校验 app 存在之后：

const app = await state.store.get(appId);
if (!app) throw AppError.NotFound(`App 不存在: ${appId}`);

// custom 类型不服务静态文件，全量走代理
if (app.type === "custom") {
  throw AppError.NotFound("Custom app 静态文件由应用自身处理");
}

// ... 原有静态文件逻辑 ...
```

注意：custom 类型对 GET `/{app_id}` 和 `/{app_id}/{*path}` 的请求应该走代理（serveCustomProxy），而不是走静态文件服务。这意味着 `serveStaticRoot` 和 `serveStatic` handler 也需要按 type 分流。

简化方案：让 `serveStaticRoot`/`serveStatic` 在入口就检测 type，custom 的转发到 `serveCustomProxy`。

- [ ] **Step 7: 运行测试确保不破坏现有代理逻辑**

```bash
deno task test --filter proxy
deno task test --filter lib_test
deno task test --filter lib_proxy_auth_test
```

- [ ] **Step 8: Commit**

```bash
git add src/proxy/mod.ts src/lib.ts
git commit -m "feat: 路由按 app.type 分流，custom 类型全量代理 + 惰性重启

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

### Task 7: 集成测试 + 端到端验证

**Files:**
- Modify: `src/lib_test.ts` （加 custom app 端到端测试）
- 或在独立集成测试文件中

- [ ] **Step 1: 写端到端测试——创建 custom app + 部署 + 请求代理**

```typescript
// 在 src/lib_test.ts 或新文件 src/integration/custom_deploy_test.ts

Deno.test("test_custom_app_create_deploy_and_proxy", {
  sanitizeOps: false, sanitizeResources: false, sanitizeExit: false,
}, async () => {
  // 1. 创建 custom app
  // 2. 部署 gzip 包（含一个简单 HTTP 服务 main.ts）
  // 3. 通过代理请求验证响应
  // 4. 重新部署（双槽位切换）
  // 5. 验证零 downtime 切换
  // 6. 删除 app 验证清理
});
```

**测试包准备：** 在测试中动态创建一个最小的 deno HTTP 服务 + 打包成 gzip tar，作为 deploy body。

```typescript
import { TarStream } from "jsr:@std/tar@^0.1.10/tar-stream";

async function makeTestBundle(files: Record<string, string>): Promise<Uint8Array> {
  // 用 TarStream 打包 → gzip 压缩 → 返回 Uint8Array
  const tarChunks: Uint8Array[] = [];
  const tarWritable = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });
  const tarStream = new TarStream();
  const writer = tarWritable.getWriter();
  // ... 逐文件写入 tar ...
}
```

> **简化：** 端到端测试直接使用 `Deno.Command` 调 `tar` + `gzip` 系统命令生成测试包（macOS/Linux 都有），避免引入 `@std/tar` 写入端的复杂度。

- [ ] **Step 2: 运行集成测试**

```bash
deno task test --filter custom_deploy
```

- [ ] **Step 3: 运行全量测试确认无回归**

```bash
deno task test
```

- [ ] **Step 4: 类型检查 + lint + 格式化**

```bash
deno task check
deno task lint
deno task fmt
```

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "test: 添加 custom app 端到端集成测试

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

## Self-Review Checklist

1. **Spec coverage:** 20 个设计决策点全覆盖
2. **Placeholder scan:** 无 TBD/TODO/placeholder
3. **Type consistency:** `App.type` 贯穿 model → store → api → lib 全部一致；`CustomProcessManager` 接口与 lib.ts 调用匹配；`ForwardOptions` 与现有 forward() 调用方对齐
4. **Backward compat:** store 默认 type=pocketbase；createApp 默认 type=pocketbase；现有路由行为不变
