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
   * 启动自定义应用子进程。
   *
   * 约定：deno run --allow-net --allow-env=PORT
   *       --allow-read=<codeDir> --allow-read=<runtimeDir>
   *       --allow-write=<runtimeDir> <entryFile>
   * PORT 环境变量注入分配的端口。
   */
  start(params: CustomAppStartParams): ManagedProcess {
    const { appId, port, codeDir, runtimeDir, entryFile } = params;

    // 如果已在运行，先停
    const existing = this.processes.get(appId);
    if (existing && existing.isAlive()) {
      existing.startKill();
    }

    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-net",
        "--allow-env=PORT",
        `--allow-read=${codeDir}`,
        `--allow-read=${runtimeDir}`,
        `--allow-write=${runtimeDir}`,
        entryFile,
      ],
      cwd: codeDir,
      stdin: "null",
      stdout: "null",
      stderr: "null",
      clearEnv: false,
      env: { PORT: String(port) },
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
   */
  async startAndWait(
    params: CustomAppStartParams,
    timeoutSecs = 10,
  ): Promise<ManagedProcess> {
    const proc = this.start(params);
    const healthy = await tcpHealthCheck(params.port, timeoutSecs);
    if (!healthy) {
      await this.stop(params.appId);
      throw new Error(
        `自定义应用健康检查失败 app_id=${params.appId} port=${params.port}`,
      );
    }
    return proc;
  }

  /** 停止并清理。 */
  async stop(appId: string): Promise<void> {
    const proc = this.processes.get(appId);
    if (!proc) return;
    this.processes.delete(appId);
    proc.startKill();
    await raceWithTimeout(proc.statusPromise, 5_000).catch(() => {
      proc.child.kill("SIGKILL");
    });
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

/** TCP 端口探活：轮询 localhost:port，每次 200ms 间隔。 */
async function tcpHealthCheck(
  port: number,
  timeoutSecs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port,
        transport: "tcp",
      });
      conn.close();
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
