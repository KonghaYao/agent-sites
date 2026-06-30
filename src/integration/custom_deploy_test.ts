// src/integration/custom_deploy_test.ts
// 端到端测试：custom app 创建 → 部署 → 代理请求 → 重部署 → 删除
//
// 需要 sanitize 全关（子进程 + 定时器残留）。

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { AppState } from "../state.ts";
import { AppStore } from "../app/store.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { CustomProcessManager } from "../app/custom_pm.ts";
import { createApp } from "../lib.ts";
import { pbBinaryPath } from "../process/pocketbase.ts";

const TEST_MASTER_KEY = "test-key-32bytes-long!!";

// 生成一个简单的 gzip tar 包，包含若干个文件。
// 使用系统 tar + gzip 命令创建包（macOS/Linux 均可）。
async function makeTestGzipBundle(files: Record<string, string>): Promise<Uint8Array> {
  const tmpDir = await Deno.makeTempDir();
  try {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = `${tmpDir}/${name}`;
      const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      if (parentDir.length > tmpDir.length) {
        await Deno.mkdir(parentDir, { recursive: true });
      }
      await Deno.writeTextFile(fullPath, content);
    }
    const tarPath = `${tmpDir}.tar.gz`;
    const tarCmd = new Deno.Command("tar", {
      args: ["-czf", tarPath, "-C", tmpDir, "."],
      stdout: "null",
      stderr: "null",
    });
    const output = await tarCmd.output();
    if (!output.success) {
      throw new Error("tar 打包失败");
    }
    return await Deno.readFile(tarPath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    await Deno.remove(`${tmpDir}.tar.gz`).catch(() => {});
  }
}

/** 构造 AppState（独立临时目录 + 独立端口段）。 */
async function makeState(tmpDir: string): Promise<AppState> {
  const dataDir = `${tmpDir}/data`;
  const publicDir = `${tmpDir}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });

  // 使用独立端口段 25000-25099，避免与 lib_test (24000+) 等冲突
  const portMin = 25000;
  const portMax = 25099;

  const store = new AppStore(`${dataDir}/apps.json`, portMin, portMax);
  const pm = new PocketBaseProcessManager(pbBinaryPath());
  const tokenStore = new TokenStore(`${dataDir}/tokens.json`);
  const cache = new PbTokenCache();
  const customPm = new CustomProcessManager();
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    store,
    pm,
    50,
    portMin,
    portMax,
    TEST_MASTER_KEY,
    tokenStore,
    cache,
    customPm,
  );
}

/** Promise 化的 setTimeout。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 端到端：创建 custom app → 部署 Deno 服务 → 代理请求 → 验证响应 →
// 重部署新版本 → 验证切换 → 删除
Deno.test({
  name: "test_custom_app_create_deploy_proxy_redeploy_delete",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  const state = await makeState(tmpDir);
  const handler = createApp(state);

  try {
    // === Step 1: 创建 custom app ===
    const createResp = await handler(
      new Request("http://localhost/api/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-master-key": TEST_MASTER_KEY,
        },
        body: JSON.stringify({ name: "test-custom", type: "custom" }),
      }),
    );
    assertEquals(createResp.status, 200);
    const createJson = await createResp.json();
    assertEquals(createJson.error, null, "创建不应返回 error");
    const appId: string = createJson.data.id;
    assertEquals(createJson.data.type, "custom", "type 应为 custom");
    assertEquals(createJson.data.port, 0, "custom app 初始 port 为 0");
    assertEquals(createJson.data.status, "running", "custom app 初始 status 为 running");
    console.info(`[custom_deploy_test] Created custom app: ${appId}`);

    // === Step 2: 部署 gzip 包（含一个最小 Deno HTTP 服务） ===
    // 注意：serveCustomProxy 转发时将完整 pathname（含 /{app_id} 前缀）
    // 透传给自定义应用，故测试服务用 endsWith 匹配路径。
    const serverCode = `
const port = parseInt(Deno.env.get("PORT") || "8080");
Deno.serve({ hostname: "127.0.0.1", port }, (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/api/hello")) {
    return Response.json({ message: "hello from custom app" });
  }
  return new Response("custom app index page", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`;
    const gzipBundle = await makeTestGzipBundle({ "main.ts": serverCode });

    const deployResp = await handler(
      new Request(
        `http://localhost/api/apps/${appId}/deploy`,
        {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "x-master-key": TEST_MASTER_KEY,
          },
          body: gzipBundle.slice().buffer,
        },
      ),
    );
    assertEquals(deployResp.status, 200);
    const deployJson = await deployResp.json();
    assertEquals(deployJson.error, null, "部署不应返回 error");
    assertEquals(deployJson.data.entry_file, "main.ts", "入口文件应为 main.ts");
    assert(deployJson.data.port > 0, "部署后 port 应 > 0");
    const appPort: number = deployJson.data.port;
    const firstSlot: string = deployJson.data.slot;
    console.info(
      `[custom_deploy_test] Deployed on port ${appPort}, slot ${firstSlot}`,
    );

    // 等待进程稳定
    await delay(500);

    // === Step 3: 通过代理请求验证 ===

    // 3a. 请求 index 页面（GET /{appId}/）
    const indexResp = await handler(
      new Request(
        `http://localhost/${appId}/`,
        { method: "GET" },
      ),
    );
    assertEquals(indexResp.status, 200, "index 页面应返回 200");
    const indexBody = await indexResp.text();
    assert(
      indexBody.includes("custom app index page"),
      `index 页面应包含 'custom app index page'，实际: ${indexBody.slice(0, 200)}`,
    );

    // 3b. 请求 API（GET /{appId}/api/hello）
    const apiResp = await handler(
      new Request(
        `http://localhost/${appId}/api/hello`,
        { method: "GET" },
      ),
    );
    assertEquals(apiResp.status, 200, "API 应返回 200");
    const apiJson = await apiResp.json();
    assertEquals(
      apiJson.message,
      "hello from custom app",
      "API 应返回 hello 消息",
    );

    // 3c. 请求不存在路径（覆盖 catch-all）
    const unknownResp = await handler(
      new Request(
        `http://localhost/${appId}/some/random/path`,
        { method: "GET" },
      ),
    );
    assertEquals(unknownResp.status, 200, "catch-all 也应返回 200");
    assert(
      (await unknownResp.text()).includes("custom app index page"),
    );

    // === Step 4: 重新部署（双槽位切换验证） ===
    const serverCodeV2 = `
const port = parseInt(Deno.env.get("PORT") || "8080");
Deno.serve({ hostname: "127.0.0.1", port }, () => {
  return new Response("v2 updated", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`;
    const gzipBundleV2 = await makeTestGzipBundle({ "main.ts": serverCodeV2 });

    const redeployResp = await handler(
      new Request(
        `http://localhost/api/apps/${appId}/deploy`,
        {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "x-master-key": TEST_MASTER_KEY,
          },
          body: gzipBundleV2.slice().buffer,
        },
      ),
    );
    assertEquals(redeployResp.status, 200);
    const redeployJson = await redeployResp.json();
    assertEquals(redeployJson.error, null, "重部署不应返回 error");
    const secondPort: number = redeployJson.data.port;
    const secondSlot: string = redeployJson.data.slot;
    console.info(
      `[custom_deploy_test] Redeployed on port ${secondPort}, slot ${secondSlot}`,
    );
    // 双槽位切换：slot 应与首次不同
    assert(
      secondSlot !== firstSlot,
      `双槽位切换后 slot 应变化: ${firstSlot} → ${secondSlot}`,
    );

    // 等待切换 + 旧进程停止
    await delay(500);

    // 验证新版本
    const v2Resp = await handler(
      new Request(
        `http://localhost/${appId}/`,
        { method: "GET" },
      ),
    );
    assertEquals(v2Resp.status, 200, "重部署后 index 应返回 200");
    assert(
      (await v2Resp.text()).includes("v2 updated"),
      "重部署后应返回新版本内容 'v2 updated'",
    );

    // === Step 5: 删除 app ===
    const deleteResp = await handler(
      new Request(
        `http://localhost/api/apps/${appId}`,
        {
          method: "DELETE",
          headers: { "x-master-key": TEST_MASTER_KEY },
        },
      ),
    );
    assertEquals(deleteResp.status, 200, "删除应返回 200");
    const deleteJson = await deleteResp.json();
    assertEquals(
      deleteJson.data.deleted,
      appId,
      "删除响应应包含被删除的 appId",
    );

    // 验证删除后进程已停
    assert(
      !state.customProcessManager.isAlive(appId),
      "删除后 custom 进程应已停止",
    );

    // 验证删除后路由不可达
    const goneResp = await handler(
      new Request(
        `http://localhost/${appId}/`,
        { method: "GET" },
      ),
    );
    assertEquals(goneResp.status, 404, "删除后 GET /{appId}/ 应返回 404");
  } finally {
    // 清理所有 custom 进程
    for (const [id] of state.customProcessManager.processes) {
      await state.customProcessManager.stop(id).catch(() => {});
    }
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
