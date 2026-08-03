// PocketBase 二进制交互层
//
// 由 Rust crates/server/src/process/pocketbase.rs 1:1 迁移而来。
// 负责：二进制路径探测、可用性检测、serve 参数构造、健康检查轮询、
// superuser 预置。所有 PocketBase 0.23.x 退出码坑（Issue #2/#7/#12）
// 在此模块统一防御，调用方无需重复处理。

// ---------------------------------------------------------------------------
// 测试专用全局串行锁
// ---------------------------------------------------------------------------
//
// Rust 用 tokio::sync::Mutex（可跨 await 持有）。Deno 单线程事件循环下
// 用模块级 Promise 链 mutex 等价实现：spawn + health check 阶段串行化，
// 运行期请求不持锁。生产路径（不导入此符号）完全无锁。
//
// PocketBase CLI upsert + spawn 在并行测试下会 race（SQLite init 竞争 /
// macOS fork 限速），导致 wait_for_health 超时 → start 失败 → FLAKY。

let _testSpawnLockChain: Promise<void> = Promise.resolve();

/**
 * 测试专用串行锁：保证 PocketBase spawn 互斥执行。
 *
 * 用法：
 * ```ts
 * await withTestSpawnLock(async () => { /* spawn + health *\/ });
 * ```
 */
export async function withTestSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _testSpawnLockChain;
  let release!: () => void;
  _testSpawnLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// 二进制路径探测
// ---------------------------------------------------------------------------

/**
 * 测试专用：返回 PocketBase 二进制路径。
 *
 * - 优先 `bin/pocketbase`（仓库内置，相对 CWD）
 * - 否则回退 `pocketbase`（假设在 PATH 中）
 *
 * Issue #12：抽到共享 helper，避免各测试文件各自实现导致检测逻辑不一致。
 */
export function pbBinaryPath(): string {
  const candidate = "bin/pocketbase";
  try {
    // Deno.statSync 同步探测文件存在性，等价 Rust Path::exists()
    Deno.statSync(candidate);
    return candidate;
  } catch {
    return "pocketbase";
  }
}

/**
 * 测试专用：检测 PocketBase 二进制是否可用。
 *
 * Issue #12：统一使用 `pocketbase --version`（flag）而非 `pocketbase version`
 * （位置参数）。PocketBase 0.23.x 对未知子命令（如 `version`）会输出
 * "unknown command" 错误但**退出码为 0**，导致旧实现误判为 true。
 * `--version` flag 在所有版本都正确打印版本且退出码语义正确。
 */
export function pbBinaryAvailable(): boolean {
  try {
    const cmd = new Deno.Command(pbBinaryPath(), {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = cmd.outputSync();
    return output.success;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// serve 参数构造
// ---------------------------------------------------------------------------

/**
 * 构造 `pocketbase serve` 的命令行参数。
 *
 * 注：PocketBase 0.23.x 不支持 `--cookiePath`/`--queryTimeout`（plan 原始假设
 * 有误），因此只传 `serve --dir --http`。
 *
 * Issue #1：App 间 auth cookie 隔离（架构文档 §6.1）由 proxy 层负责 ——
 * `proxy.forward` 在转发响应时把上游 `Set-Cookie` 中的 `Path=/`
 * 改写为 `Path=/{app_id}`。`_cookiePath` 参数保留是为了兼容调用方签名，
 * 但 PocketBase 不再消费它。
 */
export function buildServeArgs(
  dataDir: string,
  port: number,
  _cookiePath: string,
): string[] {
  return [
    "serve",
    `--dir=${dataDir}`,
    `--http=localhost:${port}`,
  ];
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

/** PocketBase 健康检查 URL */
export function healthCheckUrl(port: number): string {
  return `http://localhost:${port}/api/health`;
}

/**
 * 探测端口是否可被绑定（用于 spawn 前检查端口占用）。
 *
 * 背景：PocketBase spawn 到被外部进程占用的端口时 bind 失败立即退出，
 * 但健康检查可能连到端口上**其他实例**的 /api/health 返回 200 → 假健康
 * （apps.json 里同端口多个 running 记录就是这么来的）。spawn 前先探测，
 * 端口被占直接失败，从源头消除该竞态。
 *
 * 语义（保守）：任一地址族被占用即判为不可用。
 * - IPv4（127.0.0.1）被占 → 判占用。PB `--http=localhost:port` 与健康
 *   检查 fetch 通常都走 127.0.0.1，这是最常见的占用场景。
 * - IPv6（::1）被占（EADDRINUSE）→ 判占用：此时健康检查 fetch 可能解析
 *   到 ::1 连上其他实例（假健康），宁可显式失败也不静默错乱。
 * - 无 IPv6 支持（EAFNOSUPPORT 等环境性错误）→ 不算占用，放行。
 */
export function probePortFree(port: number): boolean {
  // IPv4 探测
  let listener: Deno.Listener | undefined;
  try {
    listener = Deno.listen({ hostname: "127.0.0.1", port });
  } catch {
    return false;
  } finally {
    listener?.close();
  }
  // IPv6 探测
  try {
    const v6 = Deno.listen({ hostname: "::1", port });
    v6.close();
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE") return false;
    // 其他错误（EAFNOSUPPORT / ENODEV 等）视为环境无 IPv6 支持，放行
  }
  return true;
}

/**
 * 健康检查结果：成功与否 + 最后一次失败的具体原因（可诊断性）。
 *
 * lastError/lastStatus 仅在 ok=false 时有意义，用于让上层错误消息
 * 能区分「连接拒绝（进程没起来）」「HTTP 非 200（进程起来了但异常）」
 * 「超时（一直无响应）」等失败类型，而不是笼统报「健康检查超时」。
 */
export interface HealthCheckResult {
  ok: boolean;
  /** 最后一次 fetch 异常信息（连接拒绝 / abort 等）；ok=true 时为 null */
  lastError: string | null;
  /** 最后一次非 200 的 HTTP 状态码；ok=true 或从未收到非 200 时为 null */
  lastStatus: number | null;
}

/**
 * 轮询健康检查端点，最多等 timeoutSecs 秒。
 *
 * Issue #7：原 Rust 实现用 `reqwest::Client::builder().build().unwrap()`
 * 在生产路径 panic，违反 CLAUDE.md「unwrap 仅用于构造测试数据」。迁移到
 * Deno 用原生 fetch + AbortSignal.timeout 实现，无构造失败路径。
 *
 * `isAlive` 回调（可选）：spawn 的子进程存活检测。进程已退出时立即
 * 返回失败，不等满 timeoutSecs，也避免 fetch 连到端口上其他实例的
 * 假健康（进程退出 → 端口响应者不可能是本进程）。
 *
 * 返回 HealthCheckResult 而非 bool：失败时携带最后一次 fetch 的错误
 * 与状态码，供上层拼进错误消息（修复「健康检查超时」不给出任何细节）。
 * 不 throw。
 */
export async function waitForHealth(
  port: number,
  timeoutSecs: number,
  isAlive?: () => boolean,
): Promise<HealthCheckResult> {
  const url = healthCheckUrl(port);
  const deadline = Date.now() + timeoutSecs * 1000;
  let lastError: string | null = null;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    // 进程已退出（如 bind 失败）：立即失败，不白等也不误连其他实例
    if (isAlive && !isAlive()) return { ok: false, lastError, lastStatus };
    // AbortSignal.timeout 的内部 timer 在 fetch 提前完成时会悬挂,
    // 导致 Deno.test 报 "Promise resolution is still pending but the event
    // loop has already resolved"。改用 AbortController + 显式 clearTimeout。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      try {
        if (resp.ok) {
          // 响应到达后再确认进程仍活着：若已退出，说明 200 来自端口上的
          // 其他实例（假健康），必须判失败
          if (isAlive && !isAlive()) return { ok: false, lastError, lastStatus };
          return { ok: true, lastError: null, lastStatus: null };
        }
        // 进程活着但返回非 200：记录状态码，继续轮询
        lastStatus = resp.status;
      } finally {
        // 消费/取消响应体：避免连接与 buffer 泄漏（Deno 2 测试 sanitize 检测）
        await resp.body?.cancel();
      }
    } catch (e) {
      // 连接拒绝 / 超时 → 记录原因后继续重试
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    await delay(200);
  }
  return { ok: false, lastError, lastStatus };
}

/** Promise 化的 setTimeout */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// superuser 预置
// ---------------------------------------------------------------------------

/**
 * 在 spawn PocketBase 之前预置 superuser，避免首次注册页面被抢注。
 *
 * 调用 `pocketbase superuser upsert <email> <password>`，操作 SQLite
 * 数据目录，**不需要 PocketBase 进程在运行**。空目录时 PocketBase 自动
 * 初始化 schema（生成 data.db / auxiliary.db / types.d.ts）。
 *
 * `upsert` 幂等：同 email 二次调用更新密码，无副作用。
 * 调用方应保证 email RFC 格式（如 `admin@app-xxx.local`），否则
 * PocketBase 拒绝并返回错误。
 *
 * Issue #2：原方案靠 ADMIN_TOKEN 在网关层防御 /_/ 抢注，但只要
 * /_/ 路由暴露 + 未预置 superuser，第一访问者仍可创建超管。本函数
 * 在 spawn 前写入凭证，从根上消除抢注窗口。
 *
 * @throws Error 当 upsert 退出码非 0 或 stdout 以 "Error:" 开头
 */
export function initSuperuser(
  binary: string,
  dataDir: string,
  email: string,
  password: string,
): void {
  const cmd = new Deno.Command(binary, {
    args: [
      "superuser",
      "upsert",
      `--dir=${dataDir}`,
      email,
      password,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = cmd.outputSync();
  if (!output.success) {
    const code = output.code;
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(
      `superuser upsert 退出码 ${code}: ${stderr}`,
    );
  }
  // PocketBase 0.23.x 对非法 email 等校验错误**退出码仍为 0**（同 Issue #12
  // 的 `version` 子命令坑），错误信息打到 stdout 形如 `Error: ...`。仅靠
  // output.success 无法识别失败，所以额外检查 stdout 不以 `Error:` 开头。
  // 成功时 stdout 形如 `Successfully saved superuser "<email>"!`。
  const stdout = new TextDecoder().decode(output.stdout);
  if (stdout.startsWith("Error:")) {
    throw new Error(
      `superuser upsert 被拒绝: ${stdout.trim()}`,
    );
  }
}
