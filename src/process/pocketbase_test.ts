// PocketBase 二进制交互层单测,迁移自 crates/server/src/process/pocketbase_test.rs
// 被测: src/process/pocketbase.ts
//   - buildServeArgs / healthCheckUrl: 纯函数,无 spawn
//   - initSuperuser / pbBinaryAvailable: 真实 PocketBase CLI,不可用时 skip
// 测试隔离:
//   - 涉及真实 PB 的测试用 withTestSpawnLock 串行化(SQLite init 竞争 / macOS fork 限速)
//   - 每个用例独立 Deno.makeTempDir(),结束 Deno.remove(recursive)
//   - pbBinaryAvailable() 为 false 时 skip(复刻 Rust 的跳过逻辑)
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildServeArgs,
  healthCheckUrl,
  initSuperuser,
  pbBinaryAvailable,
  pbBinaryPath,
  probePortFree,
  waitForHealth,
  withTestSpawnLock,
} from "./pocketbase.ts";

Deno.test("test_build_serve_args_包含全部必需参数", () => {
  const args = buildServeArgs("data/app-aaa111", 9001, "/app-aaa111/");
  const joined = args.join(" ");
  assertEquals(joined.includes("serve"), true, "必须有 serve 子命令");
  assertEquals(joined.includes("--dir=data/app-aaa111"), true);
  assertEquals(joined.includes("--http=localhost:9001"), true);
});

Deno.test("test_build_serve_args_顺序稳定", () => {
  const args = buildServeArgs("data/app-x", 9005, "/app-x/");
  assertEquals(args[0], "serve");
  // 后续参数顺序无关紧要,但每个都应存在
  assertEquals(args.some((a) => a.startsWith("--dir=")), true);
  assertEquals(args.some((a) => a.startsWith("--http=")), true);
});

Deno.test("test_health_check_url_正确拼接", () => {
  const url = healthCheckUrl(9001);
  assertEquals(url, "http://localhost:9001/api/health");
});

Deno.test("test_health_check_url_不同端口", () => {
  assertEquals(healthCheckUrl(9050), "http://localhost:9050/api/health");
  assertEquals(healthCheckUrl(11000), "http://localhost:11000/api/health");
});

// 测试端口段：pocketbase_test 用 22600-22699（mod_test 23000+ / apps_test
// 19000+ / lib_test 24000+ 互不冲突）
Deno.test("test_probe_port_free_空闲端口_返回true", () => {
  assertEquals(probePortFree(22600), true, "空闲端口应可绑定");
});

Deno.test("test_probe_port_free_被占用端口_返回false", () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 22601 });
  try {
    assertEquals(probePortFree(22601), false, "被占用端口应不可绑定");
  } finally {
    listener.close();
  }
});

// waitForHealth 的 isAlive 回调：进程退出时立即失败（不误连端口上
// 其他实例的假健康），这是防「同端口多个 running 记录」的第二道闸
// mock HTTP server 工具：onListen 回调保证就绪后才返回
async function startMockHealthServer(
  port: number,
): Promise<{ shutdown: () => Promise<void> }> {
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port,
      onListen: () => onReady(),
    },
    () => new Response("ok", { status: 200 }),
  );
  await ready;
  return { shutdown: () => server.shutdown() };
}

Deno.test("test_wait_for_health_进程已退出_立即返回false", async () => {
  // isAlive 恒为 false：即使端口上有健康服务也不应去连
  const result = await waitForHealth(22602, 5, () => false);
  assertEquals(result.ok, false, "进程已退出应判健康检查失败");
});

Deno.test("test_wait_for_health_响应200且进程存活_返回true", async () => {
  const port = 22603;
  const mock = await startMockHealthServer(port);
  try {
    const result = await waitForHealth(port, 5, () => true);
    assertEquals(result.ok, true, "进程存活且响应 200 应通过");
    assertEquals(result.lastError, null, "成功时不应携带失败原因");
    assertEquals(result.lastStatus, null, "成功时不应携带失败状态码");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("test_wait_for_health_响应200但进程已退出_返回false", async () => {
  const port = 22604;
  const mock = await startMockHealthServer(port);
  try {
    // 端口响应者不是本进程（isAlive=false）→ 200 是假健康，必须判失败
    const result = await waitForHealth(port, 5, () => false);
    assertEquals(result.ok, false, "进程已退出时端口上的 200 应视为假健康");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("test_wait_for_health_进程存活但端口无响应_返回false且携带连接错误", async () => {
  // 空闲端口（无监听）+ isAlive 恒 true → 一直连接拒绝，超时后应失败
  const port = 22605;
  const result = await waitForHealth(port, 1, () => true);
  assertEquals(result.ok, false, "无监听端口应判健康检查失败");
  assertEquals(
    result.lastError !== null,
    true,
    "连接拒绝时 lastError 应记录具体原因",
  );
});

Deno.test("test_wait_for_health_进程存活但返回非200_记录状态码", async () => {
  // mock 返回 500：进程活着但健康端点异常 → 记录状态码供诊断
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 22606,
      onListen: () => onReady(),
    },
    () => new Response("err", { status: 500 }),
  );
  await ready;
  try {
    const result = await waitForHealth(22606, 1, () => true);
    assertEquals(result.ok, false, "非 200 应判健康检查失败");
    assertEquals(result.lastStatus, 500, "应记录最后一次非 200 状态码");
  } finally {
    await server.shutdown();
  }
});

Deno.test("test_init_superuser_空目录_成功_目录非空", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过:pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      // Act: 空目录预置 superuser 应成功
      initSuperuser(
        pbBinaryPath(),
        tmp,
        "admin@app-test1.local",
        "abcdef1234567890abcdef1234567890",
      );
      // PocketBase 自动初始化 schema,data.db 必须存在
      const dataDb = `${tmp}/data.db`;
      const stat = await Deno.stat(dataDb);
      assertEquals(stat.isFile, true, "init 后 data.db 应存在");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

Deno.test("test_init_superuser_幂等更新密码_二次调用成功", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过:pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      initSuperuser(
        pbBinaryPath(),
        tmp,
        "admin@app-test2.local",
        "firstpassword1234567890",
      );
      // 第二次 upsert(同 email 不同密码)应成功更新
      initSuperuser(
        pbBinaryPath(),
        tmp,
        "admin@app-test2.local",
        "secondpassword12345678",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

Deno.test("test_init_superuser_email非法_返回错误", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过:pocketbase 不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      // Act + Assert: 缺 TLD 的 email,PocketBase 拒绝。initSuperuser 同步抛错
      // (outputSync 内部 throw),改用 assertThrows 而非 assertRejects。
      assertThrows(
        () => {
          initSuperuser(
            pbBinaryPath(),
            tmp,
            "admin@local", // 缺 TLD,PB 拒绝
            "abcdef1234567890abcdef1234567890",
          );
        },
        Error,
        undefined,
        "非法 email 必须抛错",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

Deno.test("test_init_superuser_pb不存在_返回错误", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // 无需 withTestSpawnLock:不 spawn 真实 PB,只是命令不存在立即失败
    assertThrows(
      () => {
        initSuperuser(
          "/nonexistent/pocketbase-binary",
          tmp,
          "admin@app-test3.local",
          "abcdef1234567890abcdef1234567890",
        );
      },
      Error,
      undefined,
      "PB 不存在必须抛错",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
