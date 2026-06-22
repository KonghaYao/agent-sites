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
