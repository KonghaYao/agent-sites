// master key 中间件单测
// 被测：src/lib.ts 的 /api/* 路由前置 X-Master-Key 校验
// 验证：
//   - /api/apps 缺 X-Master-Key → 401 UNAUTHORIZED
//   - /api/apps X-Master-Key 错 → 401
//   - /api/apps X-Master-Key 对 → 200
//   - /health 不需要 X-Master-Key（健康检查必须公开）
import { assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";
import { AppState } from "./state.ts";
import { createApp as makeRouter } from "./lib.ts";
import { pbBinaryPath } from "./process/pocketbase.ts";

const TEST_MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(tmp: string): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    new AppStore(`${dataDir}/apps.json`, 9000, 11000),
    new PocketBaseProcessManager(pbBinaryPath()),
    50,
    9000,
    11000,
    TEST_MASTER_KEY,
    new TokenStore(`${dataDir}/tokens.json`),
    new PbTokenCache(),
  );
}

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn,
  });
}

test("test_api_apps_无_master_key_返回_401", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps", { method: "GET" }),
    );
    assertEquals(resp.status, 401);
    const body = await resp.json();
    assertEquals(body.error.code, "UNAUTHORIZED");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_api_apps_错误_master_key_返回_401", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps", {
        method: "GET",
        headers: { "X-Master-Key": "wrong-key" },
      }),
    );
    assertEquals(resp.status, 401);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_错误响应_body_含_request_id", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    // 401 错误响应应含 request_id（8 hex）
    const resp = await handler(
      new Request("http://x/api/apps", { method: "GET" }),
    );
    assertEquals(resp.status, 401);
    const body = await resp.json();
    assertEquals(typeof body.error.request_id, "string");
    assertEquals(body.error.request_id.length, 8, "request_id 应为 8 字符");

    // 404 错误响应（路由不存在）也应含 request_id
    const resp404 = await handler(
      new Request("http://x/some/random/no-such-path"),
    );
    assertEquals(resp404.status, 404);
    const body404 = await resp404.json();
    assertEquals(typeof body404.error.request_id, "string");
    assertEquals(body404.error.request_id.length, 8);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_api_apps_正确_master_key_返回_200", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps", {
        method: "GET",
        headers: { "X-Master-Key": TEST_MASTER_KEY },
      }),
    );
    assertEquals(resp.status, 200);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_health_不需要_master_key", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(new Request("http://x/health"));
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "ok");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
