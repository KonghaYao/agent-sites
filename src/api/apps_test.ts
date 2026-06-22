// App 管理 REST API handler 单测，迁移自 crates/server/src/api/apps_test.rs
// 被测：src/api/apps.ts（createApp/listApps/getApp）+ src/lib.ts 的 createApp 路由
//   - 通过生产 Router 端到端验证 /api/apps CRUD + /{app_id}/api/* 代理
// 测试隔离：
//   - 端口段 apps_test 19000-20999（mod_test 23000-23799 / lib_test 24000+ 互不冲突）
//   - 涉及真实 PB 的 spawn 测试用 withTestSpawnLock 串行化（SQLite init 竞争 / macOS fork 限速）
//   - 每个用例独立 Deno.makeTempDir()，结束 Deno.remove(recursive)
//   - pbBinaryAvailable() 为 false 时 skip（复刻 Rust 的跳过逻辑）
import { assertEquals } from "jsr:@std/assert@^1";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "../process/pocketbase.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { AppStore } from "../app/store.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { AppState } from "../state.ts";
import { createApp as makeRouter } from "../lib.ts";

// ---------------------------------------------------------------------------
// 测试 helper
// ---------------------------------------------------------------------------

/**
 * 创建测试用 AppState。
 *
 * 默认端口范围 19000-19100；spawn 测试请用 makeAppStateWithRange 传互不重叠的范围，
 * 否则并行运行时多个 PM 各自独立分配同一首端口 → EADDRINUSE。
 */
async function makeAppState(tmp: string): Promise<AppState> {
  return await makeAppStateWithRange(tmp, 19000, 19100);
}

/** 创建带指定端口范围的测试 AppState。 */
async function makeAppStateWithRange(
  tmp: string,
  portMin: number,
  portMax: number,
): Promise<AppState> {
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

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/**
 * 本文件统一 test 包装器（默认禁用 sanitize* 选项）。
 *
 * 现实限制：源码 PM.stop()（src/process/mod.ts:314）的 Promise.race 用
 * `delay(STOP_GRACE_PERIOD_MS)` 做 SIGTERM grace 兜底，子进程被 SIGTERM 杀掉走
 * "exited" 分支后该 5s setTimeout 仍挂起（源码未 clearTimeout），其 `.then`
 * promise 在测试结束瞬间仍 pending → 触发 "Promise resolution is still pending
 * but the event loop has already resolved" 进程级错误。spawn 的 PocketBase 子进程
 * 也是测试期外生资源。仅靠 _test.ts 无法清除，故统一禁用 sanitizeOps/sanitizeResources
 * /sanitizeExit（Deno 对「外部 spawn 子进程 + 残留 setTimeout」的标准处理）。
 */
function test(
  name: string,
  fn: () => Promise<void> | void,
): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn,
  });
}

test("test_create_app_返回_id_和端口", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      // 用独立端口范围避免与其他 spawn 测试并行冲突（每个 PM 独立分配首端口）
      const state = await makeAppStateWithRange(tmp, 19600, 19700);
      const handler = makeRouter(state);
      // Act
      const resp = await handler(
        new Request("http://test/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({ name: "my-test-app" }),
        }),
      );
      // Assert
      assertEquals(resp.status, 200);
      const val = await resp.json();
      const data = val.data;
      assertEquals(data.id.startsWith("app-"), true, "id 必须以 app- 开头");
      assertEquals(data.port >= 9000, true, "port 必须 >= 9000");
      assertEquals(
        data.api_path.startsWith("/app-"),
        true,
        "api_path 必须以 /app- 开头",
      );
      // 清理 spawn 的 PocketBase 进程（JS 无 RAII，需显式 stop 避免 suite 残留孤儿进程）
      await state.processManager.stop(data.id as string);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_list_apps_初始空", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeAppState(tmp);
    const handler = makeRouter(state);
    // Act
    const resp = await handler(
      new Request("http://test/api/apps", {
        headers: { "X-Master-Key": "test-master-key-fixed-0123456789abcdef" },
      }),
    );
    // Assert
    assertEquals(resp.status, 200);
    const val = await resp.json();
    assertEquals(Array.isArray(val.data), true, "data 必须是数组");
    assertEquals(val.data.length, 0, "初始应为空数组");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_get_app_不存在_404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeAppState(tmp);
    const handler = makeRouter(state);
    // Act
    const resp = await handler(
      new Request("http://test/api/apps/app-missing", {
        headers: { "X-Master-Key": "test-master-key-fixed-0123456789abcdef" },
      }),
    );
    // Assert
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_create_app_名字包含非法字符_400", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeAppState(tmp);
    const handler = makeRouter(state);
    // Act
    const resp = await handler(
      new Request("http://test/api/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
        },
        body: JSON.stringify({ name: "bad name!" }),
      }),
    );
    // Assert
    assertEquals(resp.status, 400);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_create_app_无name_使用随机", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      // 用独立端口范围避免与 test_create_app_返回_id_和端口 并行冲突
      const state = await makeAppStateWithRange(tmp, 19800, 19900);
      const handler = makeRouter(state);
      // Act
      const resp = await handler(
        new Request("http://test/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({}),
        }),
      );
      // Assert
      assertEquals(resp.status, 200);
      const val = await resp.json();
      // 清理 spawn 的 PocketBase 进程
      await state.processManager.stop(val.data.id as string);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_create_app_凭证仅在内部_store_不暴露_HTTP", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      // 用独立端口范围避免与其它 spawn 测试并行冲突
      const state = await makeAppStateWithRange(tmp, 20200, 20300);
      const handler = makeRouter(state);
      // Act
      const resp = await handler(
        new Request("http://test/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({ name: "cred-test" }),
        }),
      );
      // Assert
      assertEquals(resp.status, 200);
      const val = await resp.json();
      const data = val.data;
      const appId = data.id as string;
      // 凭证不在 HTTP 响应里（token-only-access 设计）
      assertEquals(data.superuser_email, undefined, "响应不应暴露 email");
      assertEquals(data.superuser_password, undefined, "响应不应暴露 password");
      // 测试用：从 store 直接读凭证（生产路径用户拿不到）
      const app = await state.store.get(appId);
      assertEquals(app !== undefined, true, "App 记录应存在");
      const email = app?.superuser_email ?? "";
      const password = app?.superuser_password ?? "";
      assertEquals(typeof email, "string", "store 中必须有 email");
      assertEquals(typeof password, "string", "store 中必须有 password");
      // email 必须是 RFC 格式（含 @）
      assertEquals(email.includes("@"), true, `email 必须有 @: ${email}`);
      // email 后缀应为 .local
      assertEquals(
        email.endsWith(".local"),
        true,
        `email 后缀应为 .local: ${email}`,
      );
      // email 里应包含 app_id
      assertEquals(
        email.includes(appId),
        true,
        `email 应包含 app_id: ${email}`,
      );
      // password 必须够长（32 hex = 32 字符）
      assertEquals(
        password.length >= 32,
        true,
        `password 至少 32 字符: ${password.length}`,
      );
      // 清理 spawn 的 PocketBase 进程
      await state.processManager.stop(appId);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_create_app_预置_superuser_可换token", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeAppStateWithRange(tmp, 20300, 20400);
      const handler = makeRouter(state);
      // 1. 创建 App
      const createResp = await handler(
        new Request("http://test/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({ name: "token-test" }),
        }),
      );
      assertEquals(createResp.status, 200);
      const createVal = await createResp.json();
      const appId = createVal.data.id;
      // 凭证不在 HTTP 响应里（token-only-access 设计）
      assertEquals(createVal.data.superuser_email, undefined);
      assertEquals(createVal.data.superuser_password, undefined);
      // 测试用：从 store 直接读凭证（生产路径用户拿不到）
      const app = await state.store.get(appId);
      assertEquals(app !== undefined, true, "App 记录应存在");
      const email = app?.superuser_email ?? "";
      const password = app?.superuser_password ?? "";
      // 2. 通过网关代理调 PB superuser auth-with-password
      const authUri = `/${appId}/api/collections/_superusers/auth-with-password`;
      const authResp = await handler(
        new Request(`http://test${authUri}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({ identity: email, password }),
        }),
      );
      assertEquals(authResp.status, 200, "auth 必须成功");
      const authVal = await authResp.json();
      assertEquals(typeof authVal.token, "string", "response 必须含 token");
      // 清理 spawn 的 PocketBase 进程
      await state.processManager.stop(appId as string);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

// agent-pov §3.2 / §4.1：createApp 返回后立即调代理 GET collections，
// 不应 503（首次凭证代换失败竞态）
test("test_create_app_返回后_立即代理_不_503", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeAppStateWithRange(tmp, 20200, 20300);
      const handler = makeRouter(state);
      // 1. 创建 app
      const createResp = await handler(
        new Request("http://test/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({ name: "race-test" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      // 2. 申请 token
      const tokenResp = await handler(
        new Request("http://test/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const token = (await tokenResp.json()).data.token;
      // 3. 不 sleep，立即调代理 GET collections
      const proxyResp = await handler(
        new Request(`http://test/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${token}` },
        }),
      );
      assertEquals(
        proxyResp.status,
        200,
        `createApp 返回后立即调代理应 200，实际 ${proxyResp.status}`,
      );
      // 清理
      await state.processManager.stop(appId);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// JSON 解析严格性（agent-pov R2 M3）
// ---------------------------------------------------------------------------

// 这组测试不依赖 PB spawn（仅校验前置 JSON 解析行为），可纯逻辑跑。
// 注意：createApp 在 JSON 解析后才检查上限 + spawn，所以 400/无 body 路径
// 不会真正 spawn PB。无 body 兼容路径会进入 spawn 流程——为避免 spawn 开销，
// 用上限预置（在 max=50 时）会让 spawn 发生；故仍用 pbBinaryAvailable guard。

test("test_create_app_json_解析失败_400", async () => {
  // Arrange: 缺 master key 校验路径走不到 JSON 解析；先带 key。
  // 直接构造 Request 触发 dispatchWithRequestId → createAppHandler
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeAppState(tmp);
    const handler = makeRouter(state);
    // Act: Content-Type: application/json + 非法 JSON
    const resp = await handler(
      new Request("http://x/api/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
        },
        body: "{not valid json",
      }),
    );
    // Assert: 应 400，message 含「JSON 解析失败」
    assertEquals(resp.status, 400);
    const body = await resp.json();
    assertEquals(body.error.code, "BAD_REQUEST");
    assertEquals(
      typeof body.error.message === "string" &&
        body.error.message.includes("JSON 解析失败"),
      true,
      `message 应含 JSON 解析失败: ${body.error.message}`,
    );
    assertEquals(typeof body.error.request_id, "string");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_create_app_json_charset_解析失败_400", async () => {
  // Content-Type: application/json; charset=utf-8 也应识别为 JSON
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeAppState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
        },
        body: "broken",
      }),
    );
    assertEquals(resp.status, 400);
    const body = await resp.json();
    assertEquals(body.error.code, "BAD_REQUEST");
    assertEquals(
      body.error.message.includes("JSON 解析失败"),
      true,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_create_app_无_body_无_content_type_进入正常流程", async () => {
  // 完全空 body（无 Content-Type）—— 后续走 spawn 路径，需要 PB
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeAppStateWithRange(tmp, 20600, 20700);
      const handler = makeRouter(state);
      // 无 Content-Type，无 body
      const resp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
        }),
      );
      // 期望 200（用 id 当 name）——保持向后兼容
      assertEquals(resp.status, 200);
      const body = await resp.json();
      assertEquals(body.error, null);
      assertEquals(body.data.name, body.data.id);
      // 清理
      await state.processManager.stop(body.data.id);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_create_app_空_json_对象_200", async () => {
  // Content-Type: application/json + body={} —— 合法，name 走 fallback
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeAppStateWithRange(tmp, 20800, 20900);
      const handler = makeRouter(state);
      const resp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": "test-master-key-fixed-0123456789abcdef",
          },
          body: "{}",
        }),
      );
      assertEquals(resp.status, 200);
      const body = await resp.json();
      assertEquals(body.error, null);
      assertEquals(body.data.name, body.data.id);
      await state.processManager.stop(body.data.id);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});
