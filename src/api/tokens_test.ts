// Token CRUD handler 单测
// 被测：src/api/tokens.ts + src/lib.ts 的 /api/tokens 路由
// 验证：
//   - POST /api/tokens 对不存在的 app 返回 404
//   - POST /api/tokens 对存在的 app 颁发 token，返回完整字符串
//   - 同一 app 可申请多个独立 token
//   - GET /api/tokens 列表不含 token 字符串
//   - DELETE /api/tokens/{id} 软删除（status → revoked）
//   - DELETE /api/apps/{id} 联动吊销该 app 的所有 token
import { assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "../app/store.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { AppState } from "../state.ts";
import { createApp as makeRouter } from "../lib.ts";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "../process/pocketbase.ts";

const MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(
  tmp: string,
  portMin = 21000,
  portMax = 21100,
): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    new AppStore(`${dataDir}/apps.json`, portMin, portMax),
    new PocketBaseProcessManager(pbBinaryPath()),
    50,
    portMin,
    portMax,
    MASTER_KEY,
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

test("test_post_tokens_for_unknown_app_returns_404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Master-Key": MASTER_KEY,
        },
        body: JSON.stringify({ app_id: "app-not-exist" }),
      }),
    );
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_post_tokens_returns_warning_field", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 27100, 27200);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "warn-demo" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const body = await tokenResp.json();
      assertEquals(
        typeof body.data.warning,
        "string",
        "POST /api/tokens 响应必须有 warning 字段",
      );
      assertEquals(
        body.data.warning.length > 0,
        true,
        "warning 字段非空",
      );
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_post_tokens_for_existing_app_returns_token", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21200, 21300);
      const handler = makeRouter(state);
      // 先创建一个 app
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "demo" }),
        }),
      );
      const createBody = await createResp.json();
      const appId = createBody.data.id;
      // 申请 token
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      assertEquals(tokenResp.status, 200);
      const tokenBody = await tokenResp.json();
      assertEquals(typeof tokenBody.data.token, "string");
      assertEquals(tokenBody.data.token.includes("."), true);
      assertEquals(tokenBody.data.app_id, appId);
      assertEquals(tokenBody.data.status, "active");
      // cleanup
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_post_tokens_multiple_times_creates_independent_tokens", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21400, 21500);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "demo2" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      const t1 = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const t2 = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const b1 = await t1.json();
      const b2 = await t2.json();
      assertEquals(b1.data.token_id !== b2.data.token_id, true);
      assertEquals(b1.data.token !== b2.data.token, true);
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_get_tokens_returns_list_without_token_string", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21600, 21700);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "demo3" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const listResp = await handler(
        new Request("http://x/api/tokens", {
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      const listBody = await listResp.json();
      assertEquals(Array.isArray(listBody.data), true);
      assertEquals(listBody.data.length >= 1, true);
      // 列表项不含 token 字符串
      assertEquals(listBody.data[0].token, undefined);
      assertEquals(listBody.data[0].token_id !== undefined, true);
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_delete_token_marks_revoked", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21800, 21900);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "demo4" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const tokenId = (await tokenResp.json()).data.token_id;
      const revokeResp = await handler(
        new Request(`http://x/api/tokens/${tokenId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      assertEquals(revokeResp.status, 200);
      // 查列表，状态应为 revoked
      const getResp = await handler(
        new Request(`http://x/api/tokens/${tokenId}`, {
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      const getBody = await getResp.json();
      assertEquals(getBody.data.status, "revoked");
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_delete_app_revokes_all_tokens", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 22000, 22100);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "demo5" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      for (let i = 0; i < 2; i++) {
        await handler(
          new Request("http://x/api/tokens", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Master-Key": MASTER_KEY,
            },
            body: JSON.stringify({ app_id: appId }),
          }),
        );
      }
      // 删 app
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      // 查 app 所有 token，都应为 revoked
      const listResp = await handler(
        new Request(`http://x/api/tokens?app_id=${appId}`, {
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      const listBody = await listResp.json();
      assertEquals(listBody.data.length, 2, "应有 2 个 token");
      for (const t of listBody.data) {
        assertEquals(t.status, "revoked");
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});
