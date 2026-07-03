// PocketBase 进程管理器单测，迁移自 crates/server/src/process/mod_test.rs
// 被测：src/process/mod.ts
//   - RestartCounter / PocketBaseProcessManager.start/stop/restartIfNeeded/isAlive
// 测试隔离：
//   - 端口段 mod_test 23000-23799（apps_test 19000-20999 / lib_test 24000+ 互不冲突）
//   - 涉及真实 PB 的 spawn 测试用 withTestSpawnLock 串行化（SQLite init 竞争 / macOS fork 限速）
//   - 每个用例独立 Deno.makeTempDir()，结束 Deno.remove(recursive)
//   - pbBinaryAvailable() 为 false 时 skip（复刻 Rust 的跳过逻辑）
import { assertEquals } from "jsr:@std/assert@^1";
import { initSuperuser, pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "./pocketbase.ts";
import { PortAllocator } from "./port_allocator.ts";
import { PocketBaseProcessManager, RestartCounter } from "./mod.ts";

// 测试 helper：spawn pb 前预置 superuser，避免 /_/ Admin UI 暴露「创建第一个
// superuser」抢注页面。所有测试 pm.start() 必须走这个 helper——直接 pm.start()
// 会留下未预置的 SQLite，测试运行期间任何能访问 localhost:PORT/_/ 的人都可抢注。
// spawn 阶段的并行 race 由 withTestSpawnLock 处理。
async function startWithSuperuser(
  pm: PocketBaseProcessManager,
  appId: string,
  dataDir: string,
  allocator: PortAllocator,
): Promise<number> {
  try {
    initSuperuser(
      pm.binary,
      dataDir,
      `${appId}@test.local`,
      "test-superuser-password-12345",
    );
  } catch (e) {
    throw new Error(`测试 initSuperuser 失败: ${e}`);
  }
  try {
    return await pm.start(appId, dataDir, `/${appId}/`, allocator);
  } catch (e) {
    throw new Error(`测试 pm.start 失败: ${e}`);
  }
}

/** 复刻 Rust `kill -9 <pid>`：对 PID 发 SIGKILL（不通过 PM.stop） */
async function externalKill(pid: number): Promise<void> {
  const cmd = new Deno.Command("kill", {
    args: ["-9", String(pid)],
    stdout: "null",
    stderr: "null",
  });
  try {
    await cmd.output();
  } catch {
    // 忽略 kill 失败
  }
}

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

test("test_pm_启动_pocketbase_并健康检查通过", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const portMin = 23000; // mod_test 独立端口段
      const portMax = 23099;
      const allocator = new PortAllocator(portMin, portMax);
      const dataDir = `${tmp}/app-test1`;
      await Deno.mkdir(dataDir, { recursive: true });
      // 显式预置 superuser（本测试要验证 pm.start 的成功路径，不走 helper）
      initSuperuser(
        pm.binary,
        dataDir,
        "app-test1@test.local",
        "test-superuser-password-12345",
      );
      // Act
      const port = await pm.start("app-test1", dataDir, "/app-test1/", allocator);
      // Assert
      assertEquals(port >= portMin && port <= portMax, true, "端口应在范围内");
      assertEquals(pm.isRunning("app-test1"), true, "进程应在运行");
      assertEquals(pm.getPort("app-test1"), port);
      // 清理
      await pm.stop("app-test1");
      assertEquals(pm.isRunning("app-test1"), false, "停止后不应在运行");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_pm_重复启动同一_id_返回已有端口", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23100, 23199);
      const dataDir = `${tmp}/app-test2`;
      await Deno.mkdir(dataDir, { recursive: true });
      // 预置一次即可（第二次 start 命中缓存返回同端口，不再 spawn）
      initSuperuser(
        pm.binary,
        dataDir,
        "app-test2@test.local",
        "test-superuser-password-12345",
      );
      // Act
      const port1 = await pm.start("app-test2", dataDir, "/app-test2/", allocator);
      const port2 = await pm.start("app-test2", dataDir, "/app-test2/", allocator);
      // Assert
      assertEquals(port1, port2, "重复启动应返回同端口");
      // 清理
      await pm.stop("app-test2");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_pm_stop_未启动的_id_不报错", async () => {
  const pm = new PocketBaseProcessManager(pbBinaryPath());
  // Act + Assert: stop 未启动的进程不应抛错
  await pm.stop("app-never-started");
  assertEquals(pm.isRunning("app-never-started"), false);
});

test("test_pm_分配的端口_互不冲突", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23200, 23299);
      // Act
      const ports: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = `app-t${i}`;
        const dir = `${tmp}/${id}`;
        await Deno.mkdir(dir, { recursive: true });
        const port = await startWithSuperuser(pm, id, dir, allocator);
        ports.push(port);
      }
      // Assert
      const unique = new Set(ports);
      assertEquals(unique.size, 3, "三个端口必须互不相同");
      // 清理
      for (let i = 0; i < 3; i++) {
        await pm.stop(`app-t${i}`);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_restart_counter_首次记录_返回true", () => {
  const counter = new RestartCounter(300_000, 3);
  assertEquals(counter.recordAndCheck("app-a"), true, "首次应允许");
});

test("test_restart_counter_短窗口内第三次_返回true_第四次返回false", () => {
  const counter = new RestartCounter(300_000, 3);
  assertEquals(counter.recordAndCheck("app-a"), true);
  assertEquals(counter.recordAndCheck("app-a"), true);
  assertEquals(counter.recordAndCheck("app-a"), true);
  // 第四次：超限
  assertEquals(counter.recordAndCheck("app-a"), false, "第四次应超限");
});

test("test_restart_counter_不同app_id独立计数", () => {
  const counter = new RestartCounter(300_000, 3);
  assertEquals(counter.recordAndCheck("app-a"), true);
  assertEquals(counter.recordAndCheck("app-a"), true);
  assertEquals(counter.recordAndCheck("app-a"), true);
  // app-b 独立计数，不受 app-a 影响
  assertEquals(counter.recordAndCheck("app-b"), true, "app-b 独立计数");
});

test("test_restart_counter_窗口过期后_旧记录清理", async () => {
  const counter = new RestartCounter(50, 2);
  assertEquals(counter.recordAndCheck("app-a"), true);
  assertEquals(counter.recordAndCheck("app-a"), true);
  // 等待窗口过期
  await delay(80);
  // 旧记录已清理，应允许再次记录
  assertEquals(counter.recordAndCheck("app-a"), true, "窗口过期后应允许");
});

test("test_is_alive_无记录_返回false", () => {
  // PM 中没记录该 app_id 时，isAlive 应返回 false（视为不存活）
  const pm = new PocketBaseProcessManager(pbBinaryPath());
  assertEquals(pm.isAlive("app-not-registered"), false);
});

test("test_is_alive_进程存在_返回true", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23300, 23399);
      const dataDir = `${tmp}/app-alive`;
      await Deno.mkdir(dataDir, { recursive: true });
      await startWithSuperuser(pm, "app-alive", dataDir, allocator);
      assertEquals(pm.isAlive("app-alive"), true, "刚启动的 pb 应存活");
      await pm.stop("app-alive");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_is_alive_进程被外部kill_返回false", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23400, 23499);
      const dataDir = `${tmp}/app-killed`;
      await Deno.mkdir(dataDir, { recursive: true });
      await startWithSuperuser(pm, "app-killed", dataDir, allocator);
      const pid = pm.getPid("app-killed");
      assertEquals(pid !== undefined, true, "应有子进程 PID");
      // 模拟外部 kill：直接对 PID 发 SIGKILL（不通过 PM.stop）
      await externalKill(pid!);
      await delay(500);
      assertEquals(
        pm.isAlive("app-killed"),
        false,
        "被外部 kill 的 pb 应判为不存活",
      );
      // 清理 PM 内部记录（避免 child drop 时重复 kill 报错）
      try {
        await pm.stop("app-killed");
      } catch {
        // 忽略
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_restart_if_needed_进程还活着_返回stillhealthy", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23500, 23599);
      const dataDir = `${tmp}/app-healthy`;
      await Deno.mkdir(dataDir, { recursive: true });
      await startWithSuperuser(pm, "app-healthy", dataDir, allocator);
      const port = pm.getPort("app-healthy");
      assertEquals(port !== undefined, true, "应获取到分配端口");
      // 进程还活着 → restartIfNeeded 应返回 StillHealthy，不重启
      const outcome = await pm.restartIfNeeded("app-healthy", dataDir, port!);
      assertEquals(outcome, "StillHealthy", `应返回 StillHealthy，实际: ${outcome}`);
      // 验证没产生新进程（仍存活）
      assertEquals(pm.isAlive("app-healthy"), true);
      await pm.stop("app-healthy");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_restart_if_needed_进程死了_返回restarted", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23600, 23699);
      const dataDir = `${tmp}/app-dead`;
      await Deno.mkdir(dataDir, { recursive: true });
      await startWithSuperuser(pm, "app-dead", dataDir, allocator);
      // 外部 kill pb 进程（用 getPid 精确获取，避免 lsof 误杀）
      const pid = pm.getPid("app-dead");
      assertEquals(pid !== undefined, true, "应有子进程 PID");
      await externalKill(pid!);
      await delay(500);
      const port = pm.getPort("app-dead");
      assertEquals(port !== undefined, true, "应获取到分配端口");
      // restartIfNeeded 应重启
      const outcome = await pm.restartIfNeeded("app-dead", dataDir, port!);
      assertEquals(outcome, "Restarted", `应返回 Restarted，实际: ${outcome}`);
      assertEquals(pm.isAlive("app-dead"), true, "重启后应存活");
      await pm.stop("app-dead");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_restart_if_needed_短窗口内超过3次_rate_limited", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const pm = new PocketBaseProcessManager(pbBinaryPath());
      const allocator = new PortAllocator(23700, 23799);
      const dataDir = `${tmp}/app-ratelimit`;
      await Deno.mkdir(dataDir, { recursive: true });
      await startWithSuperuser(pm, "app-ratelimit", dataDir, allocator);
      const rlPort = pm.getPort("app-ratelimit");
      assertEquals(rlPort !== undefined, true, "应获取到分配端口");
      // 连续 kill+restart 3 次（每次都占满一个计数槽位）
      for (let i = 0; i < 3; i++) {
        const pid = pm.getPid("app-ratelimit");
        assertEquals(pid !== undefined, true, "应有子进程 PID");
        await externalKill(pid!);
        await delay(500);
        const outcome = await pm.restartIfNeeded(
          "app-ratelimit",
          dataDir,
          rlPort!,
        );
        assertEquals(outcome, "Restarted", `第 ${i + 1} 次应 Restarted`);
      }
      // 第 4 次调用 → 计数已 = 3（上限），应 RateLimited
      const outcome = await pm.restartIfNeeded(
        "app-ratelimit",
        dataDir,
        rlPort!,
      );
      assertEquals(outcome, "RateLimited", "第 4 次应 RateLimited");
      // 清理
      try {
        await pm.stop("app-ratelimit");
      } catch {
        // 忽略
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** Promise 化的 setTimeout */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
