import { assertRejects } from "jsr:@std/assert@^1";
import { AppState } from "../state.ts";
import { AppStore } from "../app/store.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { CustomProcessManager } from "../app/custom_pm.ts";

function makeTestState(tmpDir: string): AppState {
  const store = new AppStore(`${tmpDir}/apps.json`, 9000, 11000);
  const pm = new PocketBaseProcessManager("pocketbase");
  const tokenStore = new TokenStore(`${tmpDir}/tokens.json`);
  const cache = new PbTokenCache();
  const customPm = new CustomProcessManager();
  const state = new AppState(
    "pocketbase",
    tmpDir,
    `${tmpDir}/public`,
    store,
    pm,
    50,
    9000,
    11000,
    "test-master-key-32bytes-long!!",
    tokenStore,
    cache,
    customPm,
  );
  return state;
}

Deno.test("test_deploy_test_reject_non_custom_app", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const state = makeTestState(tmpDir);
    const now = new Date().toISOString();
    await state.store.add({
      id: "app-dead0001",
      name: "test-pb",
      type: "pocketbase",
      port: 9000,
      status: "running",
      created_at: now,
      updated_at: now,
      superuser_email: "",
      superuser_password: "",
    });

    const { deployApp } = await import("./deploy.ts");
    const req = new Request("http://localhost/api/apps/app-dead0001/deploy", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: new Uint8Array([0x1f, 0x8b]),
    });
    await assertRejects(
      () => deployApp(req, { state, params: { id: "app-dead0001" }, requestId: "test" }),
      Error,
      "不是自定义类型",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test_deploy_test_app_not_found", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const state = makeTestState(tmpDir);
    const { deployApp } = await import("./deploy.ts");
    const req = new Request("http://localhost/api/apps/app-nope000/deploy", {
      method: "POST",
      body: new Uint8Array(0),
    });
    await assertRejects(
      () => deployApp(req, { state, params: { id: "app-nope000" }, requestId: "test" }),
      Error,
      "不存在",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
