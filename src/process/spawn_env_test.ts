// 验证 PB 子进程不会继承 AGENT_SITES_MASTER_KEY
// 被测：src/process/mod.ts 的 pbEnvWhitelist + start/restartIfNeeded 显式传 env
//
// 设计说明：
// - 测试 1：纯函数单测 pbEnvWhitelist 内容（核心安全逻辑）
// - 测试 2：用 Deno.Command 模拟 spawn 链路：父进程设置敏感 env → 用
//   pbEnvWhitelist 显式传 env 给子进程 → 子进程回显自己的 env → 父进程
//   断言敏感 env 不在子进程里。这跨平台可靠（不依赖 /proc/<pid>/environ
//   或 ps eww 的 BSD 风格差异）
import { assertEquals } from "jsr:@std/assert@^1";
import { pbEnvWhitelist } from "./mod.ts";

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn,
  });
}

test("test_pb_env_whitelist_excludes_master_key", () => {
  // 设置敏感环境变量（确保白名单过滤能挡住）
  const sentinel = "sentinel-master-key-should-not-leak";
  const before = Deno.env.get("AGENT_SITES_MASTER_KEY");
  Deno.env.set("AGENT_SITES_MASTER_KEY", sentinel);
  try {
    const env = pbEnvWhitelist();
    // 白名单显式枚举，不含 AGENT_SITES_MASTER_KEY
    assertEquals(
      Object.prototype.hasOwnProperty.call(env, "AGENT_SITES_MASTER_KEY"),
      false,
      "白名单不应包含 AGENT_SITES_MASTER_KEY",
    );
    // 值也不应出现（防意外通过其他 key 串入）
    assertEquals(
      JSON.stringify(env).includes(sentinel),
      false,
      "白名单不应含 sentinel 值",
    );
    // 必备 key 应在
    assertEquals(Object.prototype.hasOwnProperty.call(env, "PATH"), true);
    assertEquals(Object.prototype.hasOwnProperty.call(env, "HOME"), true);
    assertEquals(Object.prototype.hasOwnProperty.call(env, "LANG"), true);
    assertEquals(Object.prototype.hasOwnProperty.call(env, "TZ"), true);
  } finally {
    if (before === undefined) {
      Deno.env.delete("AGENT_SITES_MASTER_KEY");
    } else {
      Deno.env.set("AGENT_SITES_MASTER_KEY", before);
    }
  }
});

test("test_spawn_with_whitelist_does_not_leak_master_key", async () => {
  // 端到端：用 Deno.Command 跑 `env` 命令，clearEnv + env 配合（与
  // PM.spawn PocketBase 时的机制一致）。Deno 2.x 单纯传 env 会与继承的
  // 父进程 env 合并，必须 clearEnv: true 才能完全替换。
  // 子进程的 env 输出不应包含父进程的 AGENT_SITES_MASTER_KEY。
  const sentinel = "sentinel-master-key-spawn-should-not-leak";
  const before = Deno.env.get("AGENT_SITES_MASTER_KEY");
  Deno.env.set("AGENT_SITES_MASTER_KEY", sentinel);
  try {
    const cmd = new Deno.Command("env", {
      stdout: "piped",
      stderr: "null",
      clearEnv: true,
      env: pbEnvWhitelist(),
    });
    const out = await cmd.output();
    const envText = new TextDecoder().decode(out.stdout);
    assertEquals(
      envText.includes("AGENT_SITES_MASTER_KEY"),
      false,
      "子进程不应继承 AGENT_SITES_MASTER_KEY",
    );
    assertEquals(
      envText.includes(sentinel),
      false,
      "子进程不应包含父进程的 master key 值",
    );
    assertEquals(envText.includes("PATH="), true, "PATH 应在子进程 env 里");
  } finally {
    if (before === undefined) {
      Deno.env.delete("AGENT_SITES_MASTER_KEY");
    } else {
      Deno.env.set("AGENT_SITES_MASTER_KEY", before);
    }
  }
});
