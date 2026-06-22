// 代理层鉴权 + 凭证代换端到端单测
// 被测：src/lib.ts serveApiProxy 的 platform token 验证 + 凭证代换 + PB token 缓存
// 验证：
//   - 用 platform token 可调 PB superuser 级 API（建 collection）
//   - 用已吊销 token 返 401
//   - 用 app-a 的 token 访问 app-b 返 403
//   - 非 platform token（PB user token / 伪造 JWT）原样透传，PB 用 Rules 处理
import { assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";
import { AppState } from "./state.ts";
import { createApp as makeRouter } from "./lib.ts";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "./process/pocketbase.ts";

const MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(
  tmp: string,
  portMin: number,
  portMax: number,
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

/** 端到端：创建 app → 申请 token → 用 token 调 PB 建 collection */
test("test_proxy_with_platform_token_creates_collection", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25000, 25100);
      const handler = makeRouter(state);
      // 1. 创建 app
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "proxydemo" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      // 2. 申请 token
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
      const platformToken = (await tokenResp.json()).data.token;
      // 3. 用 platform token 调 PB 建 collection
      const createColl = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Authorization": `Bearer ${platformToken}`,
          },
          body: JSON.stringify({
            name: "tasks",
            type: "base",
            listRule: "",
            viewRule: "",
            createRule: "",
            updateRule: null,
            deleteRule: null,
            fields: [{ name: "title", type: "text", required: true }],
          }),
        }),
      );
      assertEquals(createColl.status, 200);
      // 4. 用 token 列 collection（验证 superuser 级）
      const listColl = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${platformToken}` },
        }),
      );
      const listBody = await listColl.json();
      const names = listBody.items?.map((c: { name: string }) => c.name) ??
        listBody.data?.map((c: { name: string }) => c.name);
      assertEquals(names?.includes("tasks"), true);
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

test("test_proxy_with_revoked_token_returns_401", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25200, 25300);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "revoke" }),
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
      const tokenBody = await tokenResp.json();
      const platformToken = tokenBody.data.token;
      const tokenId = tokenBody.data.token_id;
      // 吊销
      await handler(
        new Request(`http://x/api/tokens/${tokenId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      // 用已吊销的 token → 401
      const resp = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${platformToken}` },
        }),
      );
      assertEquals(resp.status, 401);
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

test("test_proxy_with_wrong_app_token_returns_403", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25400, 25500);
      const handler = makeRouter(state);
      // app-a
      const respA = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "appa" }),
        }),
      );
      const appIdA = (await respA.json()).data.id;
      // app-b
      const respB = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "appb" }),
        }),
      );
      const appIdB = (await respB.json()).data.id;
      // 给 app-a 申请 token
      const tResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appIdA }),
        }),
      );
      const tokenA = (await tResp.json()).data.token;
      // 用 app-a 的 token 访问 app-b → 403
      const resp = await handler(
        new Request(`http://x/${appIdB}/api/collections`, {
          headers: { "Authorization": `Bearer ${tokenA}` },
        }),
      );
      assertEquals(resp.status, 403);
      await handler(
        new Request(`http://x/api/apps/${appIdA}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      await handler(
        new Request(`http://x/api/apps/${appIdB}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_proxy_with_pb_user_token_passes_through", async () => {
  // 不是 platform token 的请求直接透传，PB 用 Rules 处理
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25600, 25700);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "passthrough" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      // 用一个明显非 platform token 的 JWT（伪造）→ 透传到 PB → PB 返 401（无效 token）
      const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid_sig";
      const resp = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${fakeJwt}` },
        }),
      );
      // PB 返 401（无效凭证），Deno 透传不拦
      assertEquals(resp.status, 401);
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
