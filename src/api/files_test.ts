// 前端文件上传 PUT /api/apps/{id}/files/{*path} 单测
// 被测：src/api/files.ts + src/lib.ts 路由 + apps.ts 占位 index.html
//
// 测试隔离：
//   - 端口段 26000-26999（与其他测试文件互不重叠）
//   - 涉及真实 PB spawn 用 withTestSpawnLock + pbBinaryAvailable skip
//   - 每用例独立 Deno.makeTempDir()，结束 Deno.remove(recursive)
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "../app/store.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { AppState } from "../state.ts";
import { createApp as makeRouter } from "../lib.ts";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "../process/pocketbase.ts";
import { validateUploadPath } from "./files.ts";

const MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(
  tmp: string,
  portMin = 26000,
  portMax = 26100,
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

// ---------------------------------------------------------------------------
// validateUploadPath 单元测试（纯逻辑，不依赖 PB）
// ---------------------------------------------------------------------------

Deno.test("test_validate_path_空_拒绝", () => {
  let caught = false;
  try {
    validateUploadPath("");
  } catch (e) {
    caught = (e as { code?: string }).code === "BAD_REQUEST";
  }
  assertEquals(caught, true);
});

Deno.test("test_validate_path_两点穿越_拒绝", () => {
  let caught = false;
  try {
    validateUploadPath("../etc/passwd.txt");
  } catch (e) {
    caught = (e as { code?: string }).code === "BAD_REQUEST";
  }
  assertEquals(caught, true);
});

Deno.test("test_validate_path_段内两点_拒绝", () => {
  let caught = false;
  try {
    validateUploadPath("sub/../index.html");
  } catch (e) {
    caught = (e as { code?: string }).code === "BAD_REQUEST";
  }
  assertEquals(caught, true);
});

Deno.test("test_validate_path_非白名单后缀_拒绝", () => {
  let caught = false;
  try {
    validateUploadPath("index.exe");
  } catch (e) {
    caught = (e as { code?: string }).code === "BAD_REQUEST";
  }
  assertEquals(caught, true);
});

Deno.test("test_validate_path_无后缀_拒绝", () => {
  let caught = false;
  try {
    validateUploadPath("README");
  } catch (e) {
    caught = (e as { code?: string }).code === "BAD_REQUEST";
  }
  assertEquals(caught, true);
});

Deno.test("test_validate_path_合法路径_返回规范化", () => {
  const out = validateUploadPath("assets/index.html");
  assertEquals(out, "assets/index.html");
});

Deno.test("test_validate_path_前导斜杠_被剥离", () => {
  const out = validateUploadPath("/index.html");
  assertEquals(out, "index.html");
});

// ---------------------------------------------------------------------------
// e2e（router）测试
// ---------------------------------------------------------------------------

test("test_upload_file_200_并能浏览器访问", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 26200, 26300);
      const handler = makeRouter(state);
      // 先建 app
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
      const appId = (await createResp.json()).data.id;

      // PUT 上传 index.html（覆盖占位）
      const htmlContent = "<!doctype html><h1>uploaded</h1>";
      const putResp = await handler(
        new Request(`http://x/api/apps/${appId}/files/index.html`, {
          method: "PUT",
          headers: {
            "content-type": "text/html",
            "X-Master-Key": MASTER_KEY,
          },
          body: htmlContent,
        }),
      );
      assertEquals(putResp.status, 200);
      const putBody = await putResp.json();
      assertEquals(putBody.data.path, `/${appId}/index.html`);
      assertEquals(putBody.data.bytes, new TextEncoder().encode(htmlContent).byteLength);

      // GET 静态文件能拿到上传内容（HTML 会注入 fetch shim，
      // 原内容作为子串保留）
      const getResp = await handler(
        new Request(`http://x/${appId}/index.html`),
      );
      assertEquals(getResp.status, 200);
      const getText = await getResp.text();
      assert(
        getText.includes(htmlContent),
        `GET 应含上传内容（含 fetch shim 注入）: ${getText}`,
      );
      assert(
        getText.includes("window.fetch = function"),
        `HTML 响应应注入 fetch shim: ${getText}`,
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

test("test_upload_file_子目录路径_自动建目录", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 26400, 26500);
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

      const putResp = await handler(
        new Request(`http://x/api/apps/${appId}/files/assets/app.js`, {
          method: "PUT",
          headers: {
            "content-type": "application/javascript",
            "X-Master-Key": MASTER_KEY,
          },
          body: "console.log('hi')",
        }),
      );
      assertEquals(putResp.status, 200);

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

test("test_upload_file_app_不存在_404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps/app-notexist/files/index.html", {
        method: "PUT",
        headers: {
          "content-type": "text/html",
          "X-Master-Key": MASTER_KEY,
        },
        body: "hi",
      }),
    );
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_upload_file_无_master_key_401", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps/app-x/files/index.html", {
        method: "PUT",
        body: "hi",
      }),
    );
    assertEquals(resp.status, 401);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_upload_file_路径穿越_400", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 26600, 26700);
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

      // 注：URL parser 会归一化 ".." 段；通过手动构造 Request 绕过归一化
      // 来模拟恶意客户端。直接构造 req 不用 new Request。
      // 这里用纯 router 调用：pathname 直接含 "sub/../index.exe"
      // （router 用 new URL 会归一化），所以转用 validateUploadPath
      // 在单元测试里覆盖穿越场景。这里 e2e 只覆盖"非白名单后缀"的 400。
      const putResp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bad.exe`, {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "X-Master-Key": MASTER_KEY,
          },
          body: "x",
        }),
      );
      assertEquals(putResp.status, 400);
      const body = await putResp.json();
      assertEquals(body.error.code, "BAD_REQUEST");

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

test("test_upload_file_超_1MB_413", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 26800, 26900);
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

      const bigBody = new Uint8Array(2 * 1024 * 1024).fill(0x41); // 2MB
      const putResp = await handler(
        new Request(`http://x/api/apps/${appId}/files/big.js`, {
          method: "PUT",
          headers: { "X-Master-Key": MASTER_KEY },
          body: bigBody,
        }),
      );
      assertEquals(putResp.status, 413);

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

test("test_create_app_自动建占位_index_html", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 27000, 27100);
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

      // GET /{id}/ 直接 200
      const getResp = await handler(new Request(`http://x/${appId}/`));
      assertEquals(getResp.status, 200);
      const text = await getResp.text();
      assertEquals(text.includes("占位页"), true, `占位页应含提示文字，实际: ${text}`);

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
