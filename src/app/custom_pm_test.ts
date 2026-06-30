// src/app/custom_pm_test.ts
// 测试策略：创建一个最简单的 HTTP 服务 main.ts，验证 CustomPM 的 start/stop/isAlive 全链路。
// 使用 sanitizeOps: false, sanitizeResources: false, sanitizeExit: false（子进程残留 timer 必需）。

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { CustomProcessManager } from "./custom_pm.ts";

const MINI_SERVER_TS = `
const port = parseInt(Deno.env.get("PORT") || "0");
Deno.serve({ hostname: "127.0.0.1", port }, () => new Response("ok"));
`;

Deno.test("test_custom_pm_start_and_stop", {
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  const entryPath = `${tmpDir}/main.ts`;
  await Deno.writeTextFile(entryPath, MINI_SERVER_TS);

  const pm = new CustomProcessManager();
  const port = 19999;

  try {
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

    await pm.stop("app-test0001");
    assertFalse(pm.isAlive("app-test0001"));
  } finally {
    await pm.stop("app-test0001").catch(() => {});
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test_custom_pm_replace_stale_process", {
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  const entryPath = `${tmpDir}/main.ts`;
  await Deno.writeTextFile(entryPath, MINI_SERVER_TS);

  const pm = new CustomProcessManager();
  const port1 = 19998;
  const port2 = 19997;

  try {
    const proc1 = await pm.startAndWait({
      appId: "app-test0002",
      port: port1,
      codeDir: tmpDir,
      runtimeDir: tmpDir,
      entryFile: "main.ts",
    }, 5);
    assert(proc1.isAlive());

    // 第二次启动：内部会 stop 旧进程
    const proc2 = await pm.startAndWait({
      appId: "app-test0002",
      port: port2,
      codeDir: tmpDir,
      runtimeDir: tmpDir,
      entryFile: "main.ts",
    }, 5);
    assert(proc2.isAlive());
    assertEquals(pm.getPort("app-test0002"), port2);
    assertFalse(proc1.isAlive());
  } finally {
    await pm.stop("app-test0002").catch(() => {});
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
