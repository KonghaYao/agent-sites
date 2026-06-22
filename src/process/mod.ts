// PocketBase 进程管理器
//
// 由 crates/server/src/process/mod.rs 1:1 迁移而来。
// 负责：进程生命周期（start/stop/restart）、自愈限流（5min×3 滑动窗口）、
// 端口冲突三重匹配检测、SIGTERM 优雅停 + SIGKILL 强杀兜底。
//
// 翻译决策（DESIGN CONTEXT）：
// - parking_lot::RwLock<HashMap> → Map（Deno 单线程事件循环，无锁）
// - tokio::process::Child.try_wait（零开销非阻塞）→ settled 标志位 +
//   child.status 的 Promise.then 缓存 exitCode；is_alive 同步返回 !settled
// - Drop trait SIGKILL 兜底 → (a) ManagedProcess [Symbol.asyncDispose]
//   child.kill('SIGKILL')；(b) main.ts 注册 addSignalListener 全局 cleanup；
//   (c) 调用点 try/finally 显式 stop。承认 OOM/SIGKILL 残留是 JS 无 RAII
//   的不可消除差距。
// - STOP_GRACE_PERIOD=5s：child.kill('SIGTERM') +
//   Promise.race([child.status, delay(5000)])，超时 SIGKILL + await reap zombie
// - findAndKillConflictingPb：lsof + /proc 或 ps 读 cmdline，
//   三重匹配（pocketbase + serve + app_id）才 kill -9
// - 5min×3 滑动窗口：单线程事件循环天然原子，无需 Mutex

import { AppError } from "../error.ts";
import { buildServeArgs, waitForHealth } from "./pocketbase.ts";
import { PortAllocator } from "./port_allocator.ts";

// ---------------------------------------------------------------------------
// RestartCounter：自愈限流（按 app_id 滑动窗口）
// ---------------------------------------------------------------------------

/**
 * PocketBase 自愈限流计数器（按 app_id 滑动窗口）。
 *
 * 每次 `recordAndCheck` 推入当前时间戳，清理已过期记录后判断是否超限。
 * Rust 原实现单独持有 RwLock 避免与 processes HashMap 锁嵌套；
 * Deno 单线程事件循环天然原子，直接用 Map 即可。
 */
export class RestartCounter {
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly inner: Map<string, number[]> = new Map();

  constructor(windowMs: number, maxAttempts: number) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
  }

  /**
   * 记录一次重启尝试 + 返回是否仍允许（true=未超限）。
   * 同步段内完成清理 + 推入 + 判断（Rust 在同一 write guard 内）。
   */
  recordAndCheck(appId: string): boolean {
    const now = Date.now();
    let entry = this.inner.get(appId);
    if (!entry) {
      entry = [];
      this.inner.set(appId, entry);
    }
    // 清理已过期记录
    entry = entry.filter((t) => now - t < this.windowMs);
    if (entry.length >= this.maxAttempts) {
      this.inner.set(appId, entry);
      return false;
    }
    entry.push(now);
    this.inner.set(appId, entry);
    return true;
  }
}

// ---------------------------------------------------------------------------
// RestartOutcome：restart_if_needed 的返回结果
// ---------------------------------------------------------------------------

/**
 * restart_if_needed 的返回结果（Rust enum RestartOutcome）。
 *
 * - Restarted：成功重启，调用方应重试请求
 * - StillHealthy：二次检查发现进程还活着（race），调用方直接重试请求
 * - RateLimited：5min×3 次重启上限触发，调用方应返回 503
 * - GiveUp：health check 失败或端口冲突无法解决，调用方应返回 503
 */
export type RestartOutcome =
  | "Restarted"
  | "StillHealthy"
  | "RateLimited"
  | "GiveUp";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * Issue #9：SIGTERM 后等待子进程退出的最大时长（毫秒）。
 *
 * PocketBase 正常响应 SIGTERM，但若子进程忽略信号或卡死，无限 wait 会
 * 阻塞调用方（健康检查失败回滚路径上更危险）。超时后强杀（SIGKILL）。
 */
const STOP_GRACE_PERIOD_MS = 5_000;

// ---------------------------------------------------------------------------
// ManagedProcess：正在运行的 PocketBase 进程信息
// ---------------------------------------------------------------------------

/**
 * 正在运行的 PocketBase 进程信息。
 *
 * 翻译决策（DESIGN CONTEXT）：
 * 进程存活检测用 settled 标志位 + child.status 的 Promise.then 缓存 exitCode。
 * is_alive(appId) 同步返回 !settled（零开销，等价 try_wait）。
 * 严禁 Promise.race 探测后重复 await status（Deno.ChildProcess.status 消费式）。
 */
export class ManagedProcess implements AsyncDisposable {
  readonly child: Deno.ChildProcess;
  readonly port: number;
  /** status Promise 是否已 settle（true=已退出） */
  private settled = false;
  /** 缓存的退出码（仅在 settled 后有意义） */
  exitCode: number | null = null;
  /** 缓存的 status Promise（消费式，只能 await 一次）。
   *  pub readonly 是因为 stop() 需要在 SIGTERM 后 race 它判断超时。 */
  readonly statusPromise: Promise<Deno.CommandStatus>;
  /** settle 处理 promise（statusPromise.then(...).catch(...) 的返回值）。
   *  保存 reference 是因为 Deno.test 结束时检测 pending promise,
   *  floating .then() 链会导致 "Promise resolution is still pending but the
   *  event loop has already resolved"。stop() 必须 await 这个 handler 完成。 */
  readonly exitHandler: Promise<void>;

  constructor(child: Deno.ChildProcess, port: number) {
    this.child = child;
    this.port = port;
    // 缓存 status Promise 并在 settle 时更新标志位
    this.statusPromise = child.status;
    this.exitHandler = this.statusPromise
      .then((status: Deno.CommandStatus) => {
        this.settled = true;
        this.exitCode = status.code;
      })
      .catch(() => {
        // status 永不 reject（Deno 契约），保险
        this.settled = true;
      });
  }

  /**
   * 零开销非阻塞存活检测：等价 tokio::process::Child::try_wait。
   * settled=true 且 exitCode 已知 → 返回 { code };
   * settled=true 但 exitCode 未知（status reject 但微任务已调度）→ null（视为未知，调用方走自愈路径）;
   * settled=false → null（仍存活）。
   */
  tryWait(): { code: number } | null {
    if (this.settled && this.exitCode !== null) {
      return { code: this.exitCode };
    }
    return null;
  }

  /** 进程是否仍存活（try_wait 返回 None 等价 true） */
  isAlive(): boolean {
    return !this.settled;
  }

  /** PID（Deno.ChildProcess.pid） */
  getPid(): number | undefined {
    return this.child.pid;
  }

  /** SIGTERM/SIGKILL：Deno.ChildProcess.kill 默认 SIGTERM */
  startKill(): void {
    try {
      this.child.kill("SIGTERM");
    } catch {
      // 忽略：可能已退出
    }
  }

  /** 强杀：SIGKILL */
  async killAndWait(): Promise<void> {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // 忽略
    }
    try {
      await this.statusPromise;
    } catch {
      // 忽略
    }
  }

  /**
   * Drop trait SIGKILL 兜底等价物。
   * 复用 killAndWait:SIGKILL + await statusPromise reap zombie。
   * JS 无 RAII,真正生效需要调用方 `using await`(ES2025 Explicit Resource Management)
   * 或 main.ts 入口 addSignalListener 全局 cleanup 配合调用点 try/finally。
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.killAndWait();
  }
}

// ---------------------------------------------------------------------------
// PocketBaseProcessManager
// ---------------------------------------------------------------------------

/**
 * PocketBase 进程管理器。
 *
 * 翻译决策（DESIGN CONTEXT）：
 * Rust 端 AppState 借鉴 class + 单线程天然共享（无 Arc clone 概念），
 * 但保留同步段语义（spawn + insert 在同一微任务内不跨 await）以防未来 Worker 化。
 */
export class PocketBaseProcessManager {
  readonly binary: string;
  /** app_id → ManagedProcess（Deno 单线程，无需锁） */
  readonly processes: Map<string, ManagedProcess> = new Map();
  /** pub 是为测试预填方便（lib_test 直接调 record_and_check） */
  restartCounter: RestartCounter;

  constructor(binary: string) {
    this.binary = binary;
    // 5min × 3 次重启上限（mod.rs:96）
    this.restartCounter = new RestartCounter(300_000, 3);
  }

  /**
   * 启动一个 App 的 PocketBase 进程。
   *
   * - 已启动则返回已有端口
   * - 否则分配端口、spawn 进程、健康检查
   *
   * Issue #6：端口分配 + spawn + 插入 processes map 在同一同步段内完成，
   * 消除「先释放锁做 allocate_port、再获取锁插入」导致的并发 start 分配到
   * 同一端口的 TOCTOU 竞态。spawn 是同步操作不持 await，可在锁内完成；
   * 健康检查在锁外做（持锁等待会阻塞其他 start）。健康检查失败时再回滚。
   */
  async start(
    appId: string,
    dataDir: string,
    cookiePath: string,
    allocator: PortAllocator,
  ): Promise<number> {
    // 注：原 Rust 用 tokio Mutex 串行 spawn，Deno 单线程事件循环下 spawn 是
    // 同步操作，本函数「检查已启动→分配端口→spawn→insert」天然原子（无 await
    // 即无让出）。测试代码若需跨用例串行 spawn（macOS fork 限速 / SQLite init
    // race），应在外层用 withTestSpawnLock 包装——**绝不能**在此处再调
    // withTestSpawnLock，否则测试外层持有锁 + 本函数内部再请求锁 → Mutex 不
    // 支持重入 → 死锁 → Deno 报「Promise resolution is still pending」。
    // 数据目录创建（路径来自 app id，互不影响）
    try {
      await Deno.mkdir(dataDir, { recursive: true });
    } catch (e) {
      throw AppError.Internal(`创建数据目录失败: ${e}`);
    }

    // === 原子段：检查已启动 → 分配端口 → spawn → insert ===
    // Deno 单线程，本段内无 await 即「锁内」语义
    const existing = this.processes.get(appId);
    if (existing) {
      // 已启动 → 返回同端口
      return existing.port;
    }
    // 扫描已用端口并分配
    const used: Set<number> = new Set();
    for (const p of this.processes.values()) used.add(p.port);
    const port = allocator.allocate(used);
    if (port === 0) {
      throw AppError.Conflict("端口范围耗尽");
    }
    // spawn（同步操作，不跨 await = 锁内）
    const args = buildServeArgs(dataDir, port, cookiePath);
    console.info(
      `启动 PocketBase 进程 app_id=${appId} port=${port} args=${JSON.stringify(args)}`,
    );
    let child: Deno.ChildProcess;
    try {
      const command = new Deno.Command(this.binary, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "null",
        // clearEnv: true + env 配合实现完全替换。
        // Deno 2.x 默认会把 env 字段合并到继承的父进程 env 上（与 Node
        // child_process 不同），仅传 env 不足以阻挡 AGENT_SITES_MASTER_KEY
        // 泄漏到 PB 子进程。clearEnv 先清空继承，再应用白名单。
        clearEnv: true,
        env: pbEnvWhitelist(),
      });
      child = command.spawn();
    } catch (e) {
      throw AppError.Internal(`PocketBase spawn 失败: ${e}`);
    }
    this.processes.set(appId, new ManagedProcess(child, port));

    // === 健康检查 ===
    const healthy = await waitForHealth(port, 10);
    if (!healthy) {
      // 失败：kill + 移除
      try {
        await this.stop(appId);
      } catch {
        // 忽略回滚失败
      }
      throw AppError.Internal("PocketBase 健康检查超时（10s）");
    }
    console.info(`PocketBase 健康检查通过 app_id=${appId} port=${port}`);
    return port;
  }

  /**
   * 停止 App 的 PocketBase 进程。
   *
   * Issue #9：先 SIGTERM 等最多 STOP_GRACE_PERIOD，超时则 SIGKILL 强杀。
   * 原实现 wait().await 无超时，子进程忽略 SIGTERM 时会无限阻塞。
   */
  async stop(appId: string): Promise<void> {
    const proc = this.processes.get(appId);
    if (!proc) return;
    this.processes.delete(appId);
    console.info(`停止 PocketBase app_id=${appId} port=${proc.port}`);
    // start_kill: SIGTERM
    proc.startKill();
    // 等待退出,超时则强杀。用 raceWithTimeout 确保 setTimeout 清除
    // (裸 Promise.race + delay 会在 statusPromise 先胜时悬挂 timer,
    //  Deno sanitizeOps 报 "Promise resolution is still pending")
    const timedOut = await raceWithTimeout(
      proc.statusPromise.then(() => false),
      STOP_GRACE_PERIOD_MS,
      () => true,
    );
    if (timedOut) {
      console.warn(
        `PocketBase 未在 ${STOP_GRACE_PERIOD_MS}ms 内退出，强制 SIGKILL app_id=${appId} port=${proc.port}`,
      );
      await proc.killAndWait();
    }
    // 关键:await exitHandler 确保 floating .then().catch() 链 drain
    // (否则 Deno.test 报 "Promise resolution is still pending but the event
    //  loop has already resolved")
    await proc.exitHandler;
  }

  isRunning(appId: string): boolean {
    return this.processes.has(appId);
  }

  getPort(appId: string): number | undefined {
    return this.processes.get(appId)?.port;
  }

  /** 获取 app_id 对应子进程的 PID（用于外部交互或测试）。 */
  getPid(appId: string): number | undefined {
    return this.processes.get(appId)?.getPid();
  }

  /**
   * 检测 app_id 对应的 PocketBase 进程是否存活。
   *
   * - 未在 PM 中注册 → false（视为不存活）
   * - 注册了但 settled=true → false（进程已退出）
   * - settled=false → true（仍存活）
   *
   * 零开销：检查同步标志位，不持 await。等价 try_wait。
   */
  isAlive(appId: string): boolean {
    const p = this.processes.get(appId);
    if (!p) return false;
    return p.isAlive();
  }

  /**
   * 检查并按需重启 PocketBase 进程。
   *
   * 调用前提：调用方已经判断需要自愈（is_alive=false 或 forward 失败）。
   *
   * 流程：
   * 1. 限流检查：5min×3 次超限 → RateLimited
   * 2. 拿原端口（PM 没记录则分配新端口）
   * 3. 同步段内：二次确认（try_wait）。还活着 → StillHealthy
   * 4. 锁外：端口冲突处理（如果端口被占）→ 验证 cmdline 是 pocketbase 才 kill
   * 5. 同步段内：用原端口 spawn → 写入 processes map
   * 6. 锁外 wait_for_health，超时 → GiveUp（回滚 kill + remove）
   * 7. 返回 Restarted
   */
  async restartIfNeeded(
    appId: string,
    dataDir: string,
    allocator: PortAllocator,
  ): Promise<RestartOutcome> {
    // 注：测试串行化在测试代码层用 withTestSpawnLock 包装；此处不能再调
    // withTestSpawnLock，否则与外层测试锁嵌套 → 死锁。
    // === 1. 限流检查 ===
    if (!this.restartCounter.recordAndCheck(appId)) {
      console.warn(`5min 内重启超限，RateLimited app_id=${appId}`);
      return "RateLimited" as RestartOutcome;
    }

    // === 2. 拿原端口 ===
    const existingProc = this.processes.get(appId);
    const port: number = existingProc ? existingProc.port : (() => {
      // PM 没记录该 app_id：分配新端口
      const used: Set<number> = new Set();
      for (const p of this.processes.values()) used.add(p.port);
      const newPort = allocator.allocate(used);
      if (newPort === 0) {
        throw AppError.Internal("端口范围耗尽");
      }
      return newPort;
    })();

    // === 3. 二次确认（同步段，不跨 await） ===
    const existing2 = this.processes.get(appId);
    if (existing2) {
      if (existing2.isAlive()) {
        // 还活着（race）→ 不重启
        return "StillHealthy" as RestartOutcome;
      }
      // 已退出 → 从 map 移除
      this.processes.delete(appId);
    }

    // === 4. 端口冲突处理 ===
    if (await PocketBaseProcessManager.isPortInUse(port)) {
      const outcome = await PocketBaseProcessManager
        .findAndKillConflictingPb(port, appId);
      if (outcome === "killed") {
        // 已 kill，继续 spawn
      } else if (outcome === "not-target") {
        console.error(
          `端口被非 pocketbase 进程占用，放弃重启避免误杀 app_id=${appId} port=${port}`,
        );
        return "GiveUp" as RestartOutcome;
      } else {
        // outcome === 'detect-error'
        console.warn(`端口冲突检测失败，继续尝试 spawn port=${port}`);
      }
    }

    // === 5. spawn（同步段，spawn 不跨 await） ===
    const args = buildServeArgs(dataDir, port, `/${appId}/`);
    console.info(
      `重启 PocketBase 进程 app_id=${appId} port=${port} args=${JSON.stringify(args)}`,
    );
    let child: Deno.ChildProcess;
    try {
      const command = new Deno.Command(this.binary, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "null",
        // clearEnv: true + env 配合实现完全替换。
        // Deno 2.x 默认会把 env 字段合并到继承的父进程 env 上（与 Node
        // child_process 不同），仅传 env 不足以阻挡 AGENT_SITES_MASTER_KEY
        // 泄漏到 PB 子进程。clearEnv 先清空继承，再应用白名单。
        clearEnv: true,
        env: pbEnvWhitelist(),
      });
      child = command.spawn();
    } catch (e) {
      throw AppError.Internal(`PocketBase 重启 spawn 失败: ${e}`);
    }
    this.processes.set(appId, new ManagedProcess(child, port));

    // === 6. health check ===
    const healthy = await waitForHealth(port, 10);
    if (!healthy) {
      console.error(`重启后健康检查失败，GiveUp app_id=${appId} port=${port}`);
      try {
        await this.stop(appId);
      } catch {
        // 忽略回滚失败
      }
      return "GiveUp" as RestartOutcome;
    }
    console.info(`PocketBase 重启成功 app_id=${appId} port=${port}`);
    return "Restarted" as RestartOutcome;
  }

  /**
   * 检测端口是否被占用（尝试 bind）。
   * Rust 用 TcpListener::bind；Deno 用 Deno.listen 等价。
   */
  static isPortInUse(port: number): Promise<boolean> {
    let listener: Deno.Listener | null = null;
    try {
      listener = Deno.listen({ hostname: "127.0.0.1", port });
      return Promise.resolve(false);
    } catch {
      return Promise.resolve(true);
    } finally {
      try {
        listener?.close();
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 检测端口占用者是否为当前 app_id 对应的 pocketbase 进程。
   * 是 → kill + 返回 "killed"；不是 → 返回 "not-target"（不误杀）。
   * 检测失败 → 返回 "detect-error"。
   *
   * 安全关键逻辑（mod.rs:342-400）逐字保留：
   * lsof -ti:{port} 取 PID → /proc/{pid}/cmdline（Linux）或
   * ps -p {pid} -o command=（macOS）→ cmdline 必须 includes('pocketbase')
   * && includes('serve') && includes(app_id) 三重匹配才 kill -9 + sleep 300ms。
   */
  static async findAndKillConflictingPb(
    port: number,
    appId: string,
  ): Promise<"killed" | "not-target" | "detect-error"> {
    let pids: string[] = [];
    try {
      const output = await runCmd("lsof", ["-ti", `:${port}`]);
      pids = output.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    } catch (e) {
      console.warn(`端口冲突检测失败 port=${port} error=${e}`);
      return "detect-error";
    }
    if (pids.length === 0) {
      return "not-target"; // 无占用者
    }
    for (const pid of pids) {
      // 读 cmdline：优先 /proc（Linux），失败用 ps（macOS/Linux 通用）
      let cmdline = "";
      if (Deno.build.os === "linux") {
        try {
          const bytes = await Deno.readFile(`/proc/${pid}/cmdline`);
          cmdline = new TextDecoder().decode(bytes).replace(/\0/g, " ").trim();
        } catch {
          // 落到 ps
        }
      }
      if (!cmdline) {
        try {
          cmdline = (await runCmd("ps", ["-p", pid, "-o", "command="])).trim();
        } catch {
          cmdline = "";
        }
      }
      if (!cmdline) {
        console.warn(
          `无法读取进程 cmdline，跳过端口冲突处理 port=${port} pid=${pid}`,
        );
        continue;
      }
      const isPb = cmdline.includes("pocketbase") &&
        cmdline.includes("serve");
      // 匹配 data_dir（如 --dir=/path/to/app-xxx 或 --dir=data/app-xxx）
      const matchesApp = cmdline.includes(appId);
      if (isPb && matchesApp) {
        try {
          await runCmd("kill", ["-9", pid]);
        } catch {
          // 忽略 kill 失败
        }
        await delay(300);
        return "killed";
      }
      // 不论是其他 app 的 pocketbase 还是无关进程，都不误杀
      console.warn(
        `端口被非当前 app 进程占用，不误杀 port=${port} pid=${pid} expected_app=${appId} cmdline=${cmdline} is_pocketbase=${isPb}`,
      );
      return "not-target";
    }
    return "not-target";
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** Promise 化的 setTimeout */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的等待,Promise.race 胜出后 clearTimeout。
 * Deno sanitizeOps 会检测悬挂 setTimeout(默认 op leak 阈值),
 * 所以 stop() / findAndKill 等 race 路径必须用这个,不能用裸 delay().race()。
 */
async function raceWithTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(onTimeout());
    }, ms);
  });
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    // 无论谁胜出,清除 timer 避免悬挂 op
    if (timer !== undefined) clearTimeout(timer);
    // 标记 timedOut 用于外部判断(此处仅靠返回值,故保留以防未来扩展)
    void timedOut;
  }
}

/** 运行命令并返回 stdout 字符串；非 0 退出码 throw */
async function runCmd(cmd: string, args: string[]): Promise<string> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(
      `${cmd} 退出码 ${output.code}: ${stderr}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/**
 * PocketBase 子进程的环境变量白名单。
 *
 * 默认 Deno.Command 继承父进程所有环境变量，包括 AGENT_SITES_MASTER_KEY。
 * PB 子进程不需要 master key（它的权限是文件系统级的，由 data_dir 隔离），
 * 因此显式只传 PATH/HOME/LANG/TZ 四个基本变量，防止 PB hooks 跑外部代码时
 * 通过读取环境变量泄漏平台凭证。
 */
export function pbEnvWhitelist(): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
    LANG: Deno.env.get("LANG") ?? "en_US.UTF-8",
    TZ: Deno.env.get("TZ") ?? "",
  };
}
