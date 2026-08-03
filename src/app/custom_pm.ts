// src/app/custom_pm.ts
// 自定义应用进程管理器——管理 deno run 子进程生命周期。
// 与 PocketBaseProcessManager 独立，不耦合。
// 惰性重启在请求代理层处理（lib.ts 中检测进程不在时调用 start）。

import { ManagedProcess } from "../process/mod.ts";

/** 启动自定义应用的参数 */
export interface CustomAppStartParams {
  appId: string;
  port: number;
  codeDir: string; // 代码目录（deploy-a 或 deploy-b）
  runtimeDir: string; // 运行时数据目录（cwd）
  entryFile: string; // "main.ts" 或 "main.js"
  /** PB 连接信息（enable_pb=true 时传入）。custom 进程通过 PB SDK 直连此 URL。 */
  pbUrl?: string;
  pbSuperuserEmail?: string;
  pbSuperuserPassword?: string;
}

/**
 * 自定义应用进程白名单环境变量。
 * 只透传四个基本环境变量，防止平台凭证（如 AGENT_SITES_MASTER_KEY）泄漏到子进程。
 */
function customEnvWhitelist(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TZ"]) {
    const v = Deno.env.get(key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * 自定义应用进程管理器。
 *
 * 一个 App 一个 ManagedProcess。双槽位切换期间临时持有两个进程
 * （旧进程仍在运行，新进程启动探活），切换完成后停止旧进程。
 */
export class CustomProcessManager {
  /** app_id → ManagedProcess */
  readonly processes: Map<string, ManagedProcess> = new Map();
  /**
   * 端口分配声明集合：deploy 分配新端口后立即声明占用，防止并发 deploy
   * 读到同一份 usedPorts 快照分到同一端口（R5）。进程启动成功（端口已被
   * 真实绑定）或失败（端口未被占用）后由 deploy 释放。
   */
  readonly reservedPorts: Set<number> = new Set();

  /** 声明占用端口（deploy 分配后同步调用，防并发 deploy 撞端口）。 */
  reservePort(port: number): void {
    this.reservedPorts.add(port);
  }

  /** 释放端口声明（进程启动完成或失败时调用）。 */
  releasePort(port: number): void {
    this.reservedPorts.delete(port);
  }

  /**
   * 启动自定义应用子进程。
   *
   * 约定：deno run --allow-net --allow-env=PORT,PB_URL,PB_SUPERUSER_EMAIL,PB_SUPERUSER_PASSWORD
   *       --allow-read=<codeDir> --allow-read=<runtimeDir>
   *       --allow-write=<runtimeDir> <entryFile>
   * PORT / PB_URL / PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD 由平台注入。
   */
  start(params: CustomAppStartParams): ManagedProcess {
    const {
      appId,
      port,
      codeDir,
      runtimeDir,
      entryFile,
      pbUrl,
      pbSuperuserEmail,
      pbSuperuserPassword,
    } = params;

    // 如果已在运行，先停
    const existing = this.processes.get(appId);
    if (existing && existing.isAlive()) {
      existing.startKill();
    }

    // 构建环境变量白名单
    const envVars: Record<string, string> = { ...customEnvWhitelist(), PORT: String(port) };
    const allowEnv = ["PORT"];
    if (pbUrl) {
      envVars["PB_URL"] = pbUrl;
      allowEnv.push("PB_URL");
    }
    if (pbSuperuserEmail) {
      envVars["PB_SUPERUSER_EMAIL"] = pbSuperuserEmail;
      allowEnv.push("PB_SUPERUSER_EMAIL");
    }
    if (pbSuperuserPassword) {
      envVars["PB_SUPERUSER_PASSWORD"] = pbSuperuserPassword;
      allowEnv.push("PB_SUPERUSER_PASSWORD");
    }

    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-net",
        `--allow-env=${allowEnv.join(",")}`,
        `--allow-read=${codeDir}`,
        `--allow-read=${runtimeDir}`,
        `--allow-write=${runtimeDir}`,
        entryFile,
      ],
      cwd: codeDir,
      stdin: "null",
      stdout: "null",
      stderr: "null",
      clearEnv: true,
      env: envVars,
    });

    let child: Deno.ChildProcess;
    try {
      child = command.spawn();
    } catch (e) {
      throw new Error(`spawn deno run 失败: ${e}`);
    }

    const proc = new ManagedProcess(child, port);
    this.processes.set(appId, proc);
    return proc;
  }

  /**
   * 异步启动 + TCP 探活（轮询端口直到可连接，超时 10s）。
   * 成功返回 ManagedProcess，失败停止进程并 throw。
   *
   * R2：双槽位切换时旧进程在 start() 内已被 SIGTERM；健康检查通过后
   * 按「引用」回收旧进程（等退出 + SIGKILL 兜底），而不是让调用方
   * stop(id)——map 已被替换为新进程，stop(id) 会误杀新进程。
   * R3：探活带 isAlive 确认，进程已退出（bind 失败/崩溃）时立即失败，
   * 不误连端口上其他进程的假健康。
   */
  async startAndWait(
    params: CustomAppStartParams,
    timeoutSecs = 10,
  ): Promise<ManagedProcess> {
    const existing = this.processes.get(params.appId);
    const proc = this.start(params);
    const healthy = await tcpHealthCheck(params.port, timeoutSecs, () => proc.isAlive());
    if (!healthy) {
      await this.stop(params.appId);
      throw new Error(
        `自定义应用健康检查失败 app_id=${params.appId} port=${params.port}`,
      );
    }
    // 健康检查通过：回收旧进程（start() 已对其发 SIGTERM，这里等退出 + 强杀兜底）
    if (existing && existing !== proc) {
      await this.stopProcess(existing);
    }
    return proc;
  }

  /**
   * 按引用停止指定进程（不查 map）。
   * 用于回收已被新进程替换的旧进程（双槽位切换），避免 stop(id) 误杀新进程。
   */
  async stopProcess(proc: ManagedProcess): Promise<void> {
    proc.startKill();
    try {
      await raceWithTimeout(proc.statusPromise, 5_000);
    } catch {
      proc.child.kill("SIGKILL");
      // await the status to reap zombie
      try {
        await proc.statusPromise;
      } catch { /* ignore */ }
    }
    // drain exitHandler to prevent floating promise chain
    try {
      await proc.exitHandler;
    } catch { /* ignore */ }
  }

  /** 停止并清理。 */
  async stop(appId: string): Promise<void> {
    const proc = this.processes.get(appId);
    if (!proc) return;
    this.processes.delete(appId);
    await this.stopProcess(proc);
  }

  /** 进程是否存活。 */
  isAlive(appId: string): boolean {
    const proc = this.processes.get(appId);
    return proc !== undefined && proc.isAlive();
  }

  /** 获取进程端口。 */
  getPort(appId: string): number | undefined {
    return this.processes.get(appId)?.port;
  }

  /** 获取进程。 */
  getProcess(appId: string): ManagedProcess | undefined {
    return this.processes.get(appId);
  }

  /** 直接设置进程记录（双槽位切换时替换为新进程）。 */
  setProcess(appId: string, proc: ManagedProcess): void {
    this.processes.set(appId, proc);
  }
}

/**
 * TCP 端口探活：轮询 localhost:port，每次 200ms 间隔。
 *
 * R3：isAlive 回调（可选）——进程已退出时立即失败，且连接成功后再确认
 * 进程仍活着：若已退出，说明连上的是端口上其他进程（假健康），必须判失败。
 * 此前纯 TCP connect 连上即判 healthy，外部进程/PB 抢端口时 custom 进程
 * bind 失败退出后仍被记 running，代理把请求打到错误的进程。
 */
async function tcpHealthCheck(
  port: number,
  timeoutSecs: number,
  isAlive?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    // 进程已退出（如 bind 失败）：立即失败，不白等也不误连其他实例
    if (isAlive && !isAlive()) return false;
    try {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port,
        transport: "tcp",
      });
      conn.close();
      // 连接成功后再确认进程活着：若已退出，200 来自端口上的其他实例
      if (isAlive && !isAlive()) return false;
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

/** Promise.race 带超时，超时后不泄漏 timer。 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: number;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
