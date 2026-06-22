// 应用入口路由层单测，迁移自 crates/server/src/lib_test.rs
// 被测：src/lib.ts (createApp + 路由分发 + 控制面板/静态/代理)
// 测试隔离：
//   - 端口段 lib_test 24000+ AtomicUsize slot（apps_test 19000-20999 /
//     mod_test 23000-23799 互不冲突）
//   - 涉及真实 PB 的 spawn 测试用 withTestSpawnLock 串行化（SQLite init 竞争 / macOS fork 限速）
//   - createApp handler 已自带 initSuperuser + start；spawn 由 PM.start 内部
//     withTestSpawnLock 串行化，故 e2e 测试外层不再包锁
//   - 每个用例独立 Deno.makeTempDir()，结束 Deno.remove(recursive)
//   - pbBinaryAvailable() 为 false 时 skip（复刻 Rust 的跳过逻辑）
import { assertEquals } from "jsr:@std/assert@^1";
import { pbBinaryAvailable, pbBinaryPath } from "./process/pocketbase.ts";
import { AppStore } from "./app/store.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";
import { AppState } from "./state.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { createApp } from "./lib.ts";

// 每个 make_state 调用分配独立的端口段（每段 100 端口），
// 避免 15+ 个并行测试都用 20000-20100 导致 EADDRINUSE。
// 起始 24000 避开 apps_test(19000-20999) 和 mod_test(23000-23799)。
// 0→24000-24099, 1→24100-24199, ... 上限约 30000（远低于 OS 限制）。
let testPortSlot = 0;

/**
 * 构造独立 AppState（独立端口段 + 独立临时目录）。
 *
 * 对应 Rust make_state helper（lib_test.rs:18-38）。
 * 每次 slot 自增 1，端口段递增 100。
 */
async function makeState(tmp: string): Promise<AppState> {
  const slot = testPortSlot++;
  const portMin = 24000 + slot * 100;
  const portMax = portMin + 99;
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  const store = new AppStore(`${dataDir}/apps.json`, portMin, portMax);
  const pm = new PocketBaseProcessManager(pbBinaryPath());
  const tokenStore = new TokenStore(`${dataDir}/tokens.json`);
  const pbTokenCache = new PbTokenCache();
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    store,
    pm,
    50,
    portMin,
    portMax,
    "test-master-key-fixed-0123456789abcdef",
    tokenStore,
    pbTokenCache,
  );
}

/**
 * 真实 PocketBase 集成测试用 Deno.test 选项。
 *
 * 现实限制：源码 PM.stop()（src/process/mod.ts:314）的 Promise.race 用
 * `delay(STOP_GRACE_PERIOD_MS)` 做 SIGTERM grace 兜底，子进程被 SIGTERM 杀掉走
 * "exited" 分支后该 5s setTimeout 仍挂起（源码未 clearTimeout）；spawn 的
 * PocketBase 子进程也是测试期外生资源。仅靠 _test.ts 无法清除该计时器/子进程，
 * 故对涉及 spawn+stop 的 PB 测试禁用 sanitizeOps/sanitizeResources
 * （Deno 对「外部 spawn 子进程 + 残留 setTimeout」的标准处理）。
 */
const pbTestOptions = {
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
} as const;

/** 调用 createApp 返回的 handler，发起一次请求。 */
async function dispatch(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (opts.body !== undefined) {
    init.body = opts.body;
  }
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  // /api/* 路径需要 X-Master-Key（与 makeState 写死的 master key 对应）。
  // /{app_id}/api/* 是 PB 代理，不读该 header，带上也无影响。
  if (!headers.has("X-Master-Key")) {
    headers.set("X-Master-Key", "test-master-key-fixed-0123456789abcdef");
  }
  init.headers = headers;
  const req = new Request(url, init);
  return await handler(req);
}

Deno.test("test_健康检查_200", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/health");
    assertEquals(resp.status, 200);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_根路径_控制面板html存在_返回html含核心元素", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    // make_state 已建好 public_dir，写入占位 _panel/index.html
    const panelDir = `${tmp}/public/_panel`;
    const panelPath = `${panelDir}/index.html`;
    await Deno.mkdir(panelDir, { recursive: true });
    await Deno.writeTextFile(
      panelPath,
      "<!doctype html><title>agent-sites</title><script>fetch('/api/apps')</script>",
    );
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/");
    assertEquals(resp.status, 200);
    const ctype = resp.headers.get("content-type") ?? "";
    assertEquals(
      ctype.startsWith("text/html"),
      true,
      `content-type 应为 text/html，实际: ${ctype}`,
    );
    const html = await resp.text();
    assertEquals(html.includes("agent-sites"), true, "应包含标题 agent-sites");
    assertEquals(html.includes("/api/apps"), true, "JS 应 fetch /api/apps");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_根路径_控制面板html不存在_返回fallback", async () => {
  // make_state 默认创建空 public_dir（无 _panel）
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/");
    assertEquals(resp.status, 200);
    const html = await resp.text();
    assertEquals(
      html.includes("控制面板 HTML 未安装"),
      true,
      `fallback 应含提示文字，实际: ${html}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_根路径_始终返回200_不是404", async () => {
  // 即使 _panel 不存在，根路径也返回 200（fallback 路径）
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/");
    assertEquals(resp.status, 200);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_静态文件_未创建_app_404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/app-missing/index.html");
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test({
  name: "test_端到端_创建_app_代理_api_可用",
  ...pbTestOptions,
  fn: async () => {
    if (!pbBinaryAvailable()) {
      console.warn("跳过：pocketbase 不可用");
      return;
    }
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp);
      const handler = createApp(state);

      // 创建 App
      let resp = await dispatch(
        handler,
        "POST",
        "/api/apps",
        { body: '{"name":"e2e-demo"}' },
      );
      assertEquals(resp.status, 200);
      const body = await resp.json();
      const appId = body.data.id as string;
      const port = body.data.port as number;

      try {
        // 直接访问 PocketBase health（验证进程起来了）
        // 并行测试时 PocketBase 刚通过健康检查仍可能瞬时拒绝连接，重试几次提升稳定性
        const healthUrl = `http://localhost:${port}/api/health`;
        let direct: Response | null = null;
        for (let i = 0; i < 10; i++) {
          try {
            direct = await fetch(healthUrl);
            break;
          } catch {
            // 连接拒绝 → 继续重试
          }
          await delay(200);
        }
        assertEquals(direct !== null, true, "PocketBase 健康检查重试耗尽");
        assertEquals(direct!.status, 200);
        await direct!.body?.cancel(); // 消费 body，避免泄漏

        // 通过网关代理访问（路径 /{app_id}/api/health）
        const proxied = await dispatch(handler, "GET", `/${appId}/api/health`);
        assertEquals(proxied.status, 200);
        await proxied.text(); // 消费 body

        // 清理：删除 App
        resp = await dispatch(handler, "DELETE", `/api/apps/${appId}`);
        assertEquals(resp.status, 200);
        await resp.text(); // 消费 body

        // 端口应已释放（PocketBase 进程被 kill）
        let stillUp: boolean;
        try {
          const probe = await fetch(`http://localhost:${port}/api/health`);
          await probe.body?.cancel(); // 消费 body
          stillUp = false; // 仍能连 → 失败
        } catch {
          stillUp = true; // 连接拒绝 → 预期
        }
        assertEquals(
          stillUp,
          true,
          "删除后 PocketBase 进程应已停止",
        );
      } finally {
        // 防御性：删除 App 未成功时也尝试停进程
        try {
          const r = await dispatch(handler, "DELETE", `/api/apps/${appId}`);
          await r.body?.cancel();
        } catch {
          // 忽略：可能已删除
        }
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

// ============ Issue #11：app_id 前缀校验 ============

Deno.test("test_api_proxy_非_app_前缀_返回404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    // "api-x" 不是合法 app id（不以 app- 开头）
    const resp = await dispatch(handler, "GET", "/api-x/api/health");
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_static_非_app_前缀_返回404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/api-x/index.html");
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_api_proxy_非法_app_id_字符_返回404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    // app- 后跟大写字母（isValidId 拒绝）
    const resp = await dispatch(handler, "GET", "/app-ABCDEF/api/health");
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ============ Admin UI 路由已删除 ============

Deno.test("test_admin_path_已屏蔽_返回404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/app-testid/_/");
    // _/ 路由被显式拦截，返回 404 + 明确错误消息（R2 §1）：
    // 不再误导向「文件不存在: _/index.html」，而是告知 agent 用 API。
    assertEquals(resp.status, 404);
    const body = await resp.json();
    assertEquals(body.error.code, "NOT_FOUND");
    assertEquals(
      typeof body.error.message === "string" &&
        body.error.message.includes("Admin UI 不开放"),
      true,
      `应明确告知 Admin UI 不开放，实际: ${body.error.message}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("test_admin_path_裸下划线_也404", async () => {
  // /{app_id}/_ （裸下划线，无尾斜杠）也应被拦截
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = createApp(state);
    const resp = await dispatch(handler, "GET", "/app-testid/_");
    assertEquals(resp.status, 404);
    const body = await resp.json();
    assertEquals(
      body.error.message.includes("Admin UI 不开放"),
      true,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ============ pb 进程崩溃自愈 ============

/**
 * 复刻 Rust lsof + kill -9：杀掉占用 port 的 PocketBase 进程（用于模拟外部 kill）。
 *
 * 注意：`lsof -ti :{port}` 会返回所有与该端口有连接的 pid（含 LISTEN 的 pocketbase
 * 以及健康检查 fetch 建立的 ESTABLISHED 连接对端，可能包括 Deno 测试进程自身）。
 * 若直接 kill -9 全部 pid，会把测试进程自己也杀掉导致挂起。故此处先读每个 pid 的
 * cmdline，仅对 cmdline 含 "pocketbase" 的 pid 执行 kill -9（与源码
 * findAndKillConflictingPb 的三重匹配思路一致，避免误杀）。
 */
async function killPidsOnPort(port: number): Promise<void> {
  let pids: string[] = [];
  try {
    const cmd = new Deno.Command("lsof", {
      args: ["-ti", `:${port}`],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    pids = stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  } catch {
    // lsof 失败 → 无 pid 可杀
    return;
  }
  for (const pid of pids) {
    // 仅杀 cmdline 含 pocketbase 的进程，避免误杀 Deno 测试进程 / Chrome 等
    let cmdline = "";
    try {
      const psCmd = new Deno.Command("ps", {
        args: ["-p", pid, "-o", "command="],
        stdout: "piped",
        stderr: "null",
      });
      const psOut = await psCmd.output();
      cmdline = new TextDecoder().decode(psOut.stdout).trim();
    } catch {
      // ps 失败 → 跳过该 pid
      continue;
    }
    if (!cmdline.includes("pocketbase")) continue;
    try {
      const killCmd = new Deno.Command("kill", {
        args: ["-9", pid],
        stdout: "null",
        stderr: "null",
      });
      await killCmd.output();
    } catch {
      // 忽略 kill 失败
    }
  }
}

Deno.test({
  name: "test_代理_pb进程被外部kill后_自动重启_请求成功",
  ...pbTestOptions,
  fn: async () => {
    if (!pbBinaryAvailable()) {
      console.warn("跳过：pocketbase 不可用");
      return;
    }
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp);
      const handler = createApp(state);

      // 创建 App
      let resp = await dispatch(
        handler,
        "POST",
        "/api/apps",
        { body: '{"name":"auto-heal"}' },
      );
      assertEquals(resp.status, 200);
      const body = await resp.json();
      const appId = body.data.id as string;
      const port = state.processManager.getPort(appId);
      assertEquals(port !== undefined, true, "PM 应记录端口");

      // 外部 kill pb
      await killPidsOnPort(port!);
      await delay(500);

      // 通过网关代理 → 应自动重启 + 返回 200
      resp = await dispatch(handler, "GET", `/${appId}/api/health`);
      assertEquals(
        resp.status,
        200,
        `应自动重启 + 200，实际: ${resp.status}`,
      );
      await resp.body?.cancel();

      // 清理
      const del = await dispatch(handler, "DELETE", `/api/apps/${appId}`);
      await del.body?.cancel();
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "test_代理_status_error的app_直接返回503_不进自愈",
  ...pbTestOptions,
  fn: async () => {
    if (!pbBinaryAvailable()) {
      console.warn("跳过：pocketbase 不可用");
      return;
    }
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp);
      const handler = createApp(state);

      // 创建 App
      const resp = await dispatch(
        handler,
        "POST",
        "/api/apps",
        { body: '{"name":"err-app"}' },
      );
      const body = await resp.json();
      const appId = body.data.id as string;

      // 手动把 status 改 Error
      const appRecord = await state.store.get(appId);
      assertEquals(appRecord !== undefined, true, "App 记录应存在");
      appRecord!.status = "error";
      await state.store.update(appRecord!);
      await state.store.flush();

      // 代理应直接 503
      const proxied = await dispatch(handler, "GET", `/${appId}/api/health`);
      assertEquals(proxied.status, 503);
      await proxied.body?.cancel();

      // 清理
      const del = await dispatch(handler, "DELETE", `/api/apps/${appId}`);
      await del.body?.cancel();
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "test_代理_rate_limited后_status变error_返回503",
  ...pbTestOptions,
  fn: async () => {
    if (!pbBinaryAvailable()) {
      console.warn("跳过：pocketbase 不可用");
      return;
    }
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp);
      const handler = createApp(state);

      // 创建 App
      const resp = await dispatch(
        handler,
        "POST",
        "/api/apps",
        { body: '{"name":"rate-app"}' },
      );
      const body = await resp.json();
      const appId = body.data.id as string;
      const port = state.processManager.getPort(appId);
      assertEquals(port !== undefined, true, "PM 应记录端口");

      // 预填 RestartCounter 到上限（直接调 3 次 recordAndCheck）
      for (let i = 0; i < 3; i++) {
        state.processManager.restartCounter.recordAndCheck(appId);
      }

      // 外部 kill pb
      await killPidsOnPort(port!);
      await delay(500);

      // 代理 → 应触发 RateLimited → status=Error → 503
      const proxied = await dispatch(handler, "GET", `/${appId}/api/health`);
      assertEquals(proxied.status, 503);
      await proxied.body?.cancel();

      // status 应同步为 Error
      const updated = await state.store.get(appId);
      assertEquals(updated!.status, "error");

      // 清理
      const del = await dispatch(handler, "DELETE", `/api/apps/${appId}`);
      await del.body?.cancel();
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** Promise 化的 setTimeout */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
