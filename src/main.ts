// main.ts — 服务入口（对应 crates/server/src/main.rs）
//
// 翻译决策（DESIGN CONTEXT）：
// - Rust `#[derive(Parser)] struct Cli` 用 clap 解析 CLI + 环境变量 →
//   TS 端手写 parseArgs(Deno.args) + Deno.env.get 兜底，零依赖（不用 npm clap 等价物）。
//   默认值逐字对齐 main.rs:11-33。
// - `#[tokio::main] async fn main()` → `async function main()`，顶层用 main().catch。
// - `tokio::fs::create_dir_all` → `Deno.mkdir({ recursive: true })`。
// - `tokio::net::TcpListener::bind` + `axum::serve(listener, app)` →
//   `Deno.serve({ host, port, handler })`（Deno 原生 HTTP 服务器，无框架）。
// - `Arc<AppState>` → 直接 AppState 引用（Deno 单线程事件循环天然共享，无 Arc 概念）。
// - Drop SIGKILL 兜底（Rust trait Drop）→ 三重保险：
//   (a) ManagedProcess 实现 [Symbol.asyncDispose] 调 child.kill('SIGKILL')；
//   (b) main.ts 入口注册 Deno.addSignalListener('SIGINT'/'SIGTERM') 全局 cleanup
//       遍历 processes Map 强杀（对应 DESIGN CONTEXT 决策）；
//   (c) 调用点 try/finally 显式 stop。
//   承认 OOM/SIGKILL 场景仍可能残留——这是 JS 无 RAII 的不可消除差距。
// - 注：lib.ts 尚未创建（create_app 在迁移计划中由其他任务负责），
//   此处用动态 import + 运行时检查，若 lib.ts 存在则调用其 createApp；
//   若缺失则在 main 启动早期抛出明确错误。这样 main.ts 可先于 lib.ts 落地。

import { AppState } from "./state.ts";
import { AppStore } from "./app/store.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";

/** CLI 配置（对应 Rust `struct Cli`，main.rs:8-34）。 */
interface Cli {
  host: string;
  port: number;
  pbBinary: string;
  dataDir: string;
  publicDir: string;
  pbPortMin: number;
  pbPortMax: number;
  maxApps: number;
}

/**
 * 解析 CLI 参数 + 环境变量（对应 Rust `Cli::parse()` + `#[arg(env = ...)]`）。
 *
 * 默认值逐字对齐 main.rs:11-33。环境变量优先级低于 CLI 显式参数
 * （Rust clap 行为：`--flag` 覆盖 env，env 覆盖 default）。
 */
function parseCli(args: string[]): Cli {
  // 默认值（main.rs:11-33）
  const defaults: Cli = {
    host: "0.0.0.0",
    port: 3000,
    pbBinary: "bin/pocketbase",
    dataDir: "data",
    publicDir: "public",
    pbPortMin: 9000,
    pbPortMax: 11000,
    maxApps: 50,
  };

  // 先取环境变量兜底（clap env 行为）
  const fromEnv: Partial<Cli> = {};
  const envHost = Deno.env.get("HOST");
  if (envHost !== undefined) fromEnv.host = envHost;
  const envPbBinary = Deno.env.get("PB_BINARY");
  if (envPbBinary !== undefined) fromEnv.pbBinary = envPbBinary;
  const envDataDir = Deno.env.get("DATA_DIR");
  if (envDataDir !== undefined) fromEnv.dataDir = envDataDir;
  const envPublicDir = Deno.env.get("PUBLIC_DIR");
  if (envPublicDir !== undefined) fromEnv.publicDir = envPublicDir;
  const envPbPortMin = Deno.env.get("PB_PORT_MIN");
  if (envPbPortMin !== undefined) fromEnv.pbPortMin = parseInt(envPbPortMin, 10);
  const envPbPortMax = Deno.env.get("PB_PORT_MAX");
  if (envPbPortMax !== undefined) fromEnv.pbPortMax = parseInt(envPbPortMax, 10);
  const envMaxApps = Deno.env.get("MAX_APPS");
  if (envMaxApps !== undefined) fromEnv.maxApps = parseInt(envMaxApps, 10);

  // CLI 参数覆盖环境变量（--port 8080 风格，clap long）
  const fromArgs: Partial<Cli> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case "--host":
        if (next !== undefined) fromArgs.host = next;
        i++;
        break;
      case "--port":
        if (next !== undefined) fromArgs.port = parseInt(next, 10);
        i++;
        break;
      case "--pb-binary":
        if (next !== undefined) fromArgs.pbBinary = next;
        i++;
        break;
      case "--data-dir":
        if (next !== undefined) fromArgs.dataDir = next;
        i++;
        break;
      case "--public-dir":
        if (next !== undefined) fromArgs.publicDir = next;
        i++;
        break;
      case "--pb-port-min":
        if (next !== undefined) fromArgs.pbPortMin = parseInt(next, 10);
        i++;
        break;
      case "--pb-port-max":
        if (next !== undefined) fromArgs.pbPortMax = parseInt(next, 10);
        i++;
        break;
      case "--max-apps":
        if (next !== undefined) fromArgs.maxApps = parseInt(next, 10);
        i++;
        break;
      case "-h":
      case "--help": {
        // 对应 clap --help：打印用法后退出 0
        printUsage();
        Deno.exit(0);
        break;
      }
      case "-V":
      case "--version": {
        // 对应 clap --version
        console.log("agent-sites 0.1.0");
        Deno.exit(0);
        break;
      }
      default:
        // 未知参数：报错退出（clap 行为）
        console.error(`错误：未知参数 '${a}'`);
        Deno.exit(2);
    }
  }

  return { ...defaults, ...fromEnv, ...fromArgs };
}

/** 打印用法（对应 clap 自动生成的 --help 输出）。 */
function printUsage(): void {
  console.log(`agent-sites 0.1.0
Vibe App 后端平台

USAGE:
    agent-sites [OPTIONS]

OPTIONS:
        --host <HOST>              监听地址 [默认: 0.0.0.0]
        --port <PORT>              监听端口 [默认: 3000]
        --pb-binary <PB_BINARY>    PocketBase 二进制路径 [env: PB_BINARY] [默认: bin/pocketbase]
        --data-dir <DATA_DIR>      App 数据根目录 [env: DATA_DIR] [默认: data]
        --public-dir <PUBLIC_DIR>  App 前端静态文件根目录 [env: PUBLIC_DIR] [默认: public]
        --pb-port-min <PB_PORT_MIN>  PocketBase 端口范围起 [env: PB_PORT_MIN] [默认: 9000]
        --pb-port-max <PB_PORT_MAX>  PocketBase 端口范围止 [env: PB_PORT_MAX] [默认: 11000]
        --max-apps <MAX_APPS>      App 数量上限 [env: MAX_APPS] [默认: 50]
    -h, --help                     打印帮助信息
    -V, --version                  打印版本信息`);
}

/**
 * 全局 cleanup：遍历 processManager.processes 强杀所有 PocketBase 子进程。
 *
 * 对应 Rust `Drop for AppState` 兜底——Rust 端在进程退出时 Drop 触发 SIGKILL，
 * JS 无 RAII，故在 SIGINT/SIGTERM 信号处理中显式调用。
 *
 * 三重保险的第 (b) 层（DESIGN CONTEXT 决策）。
 */
async function globalCleanup(state: AppState): Promise<void> {
  const appIds = Array.from(state.processManager.processes.keys());
  if (appIds.length === 0) return;
  console.info(`全局 cleanup：停止 ${appIds.length} 个 PocketBase 进程`);
  // 并发 stop 所有进程，每个 stop 内部已有 SIGTERM→SIGKILL 兜底
  await Promise.all(appIds.map((id) => state.processManager.stop(id)));
}

/**
 * 加载 lib.ts 的 createApp。
 *
 * lib.ts 由独立任务迁移，此函数在运行时动态导入。
 * 若 lib.ts 缺失则抛出明确错误，便于定位迁移进度。
 */
async function loadCreateApp(
  state: AppState,
): Promise<(req: Request) => Promise<Response>> {
  const mod = await import("./lib.ts");
  if (typeof mod.createApp !== "function") {
    throw new Error(
      "lib.ts 未导出 createApp 函数——请确认 lib.ts 迁移已完成",
    );
  }
  return mod.createApp(state) as (req: Request) => Promise<Response>;
}

/**
 * 服务入口（对应 Rust `async fn main()`，main.rs:36-68）。
 *
 * 流程：
 * 1. 解析 CLI + 环境变量
 * 2. 创建数据目录（mkdir -p）
 * 3. 构造 AppStore + PocketBaseProcessManager + AppState
 * 4. 加载 createApp(state) → handler
 * 5. 注册 SIGINT/SIGTERM 信号监听做全局 cleanup
 * 6. Deno.serve 启动监听
 */
async function main(): Promise<void> {
  const cli = parseCli(Deno.args);

  // 校验 master key（必须在所有使用 state 的代码之前）
  const masterKey = Deno.env.get("AGENT_SITES_MASTER_KEY");
  if (!masterKey) {
    console.error(
      "启动失败：环境变量 AGENT_SITES_MASTER_KEY 未设置。\n" +
        "生成方式：openssl rand -hex 32\n" +
        "设置方式：export AGENT_SITES_MASTER_KEY=<生成的值>",
    );
    Deno.exit(1);
  }
  if (masterKey.length < 32) {
    console.warn(
      `警告：AGENT_SITES_MASTER_KEY 长度 ${masterKey.length} < 32 字节，建议用 openssl rand -hex 32 生成更长的密钥`,
    );
  }

  // 创建数据目录（对应 tokio::fs::create_dir_all，main.rs:45-46）
  await Deno.mkdir(cli.dataDir, { recursive: true });
  await Deno.mkdir(cli.publicDir, { recursive: true });

  // 构造 AppStore（对应 AppStore::new，main.rs:48）
  // 路径拼接用字符串模板而非 PathBuf::join（TS 端统一用字符串表示路径）
  const store = new AppStore(
    `${cli.dataDir}/apps.json`,
    cli.pbPortMin,
    cli.pbPortMax,
  );

  // 构造 TokenStore（持久化 tokens.json）
  const tokenStore = new TokenStore(`${cli.dataDir}/tokens.json`);

  // 构造 PbTokenCache（凭证代换 + 内存缓存）
  const pbTokenCache = new PbTokenCache();

  // 构造 PocketBaseProcessManager（对应 PocketBaseProcessManager::new，main.rs:49）
  const processManager = new PocketBaseProcessManager(cli.pbBinary);

  // 构造 AppState（对应 AppState::new，main.rs:51-60）
  // Deno 单线程无 Arc，直接持有引用
  const state = new AppState(
    cli.pbBinary,
    cli.dataDir,
    cli.publicDir,
    store,
    processManager,
    cli.maxApps,
    cli.pbPortMin,
    cli.pbPortMax,
    masterKey,
    tokenStore,
    pbTokenCache,
  );

  // 加载 handler（对应 agent_sites::create_app(state)，main.rs:62）
  const handler = await loadCreateApp(state);

  // 注册信号监听做全局 cleanup（Drop SIGKILL 兜底的第 (b) 层）
  // Rust 端靠 trait Drop 自动触发；JS 端必须显式注册。
  // 注：cleanupPromise 防止重复 cleanup；exiting 标志防止信号处理器内再次抛 SIGINT。
  let exiting = false;
  const signalCleanup = async (sig: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.info(`收到 ${sig}，开始全局 cleanup`);
    try {
      await globalCleanup(state);
    } catch (err) {
      // cleanup 失败不应阻塞退出（对应 Rust Drop 不可失败语义的近似）
      console.error("全局 cleanup 失败：", err);
    }
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", () => signalCleanup("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => signalCleanup("SIGTERM"));

  // 启动 HTTP 服务（对应 tokio::net::TcpListener::bind + axum::serve，main.rs:63-66）
  const addr = `http://${cli.host}:${cli.port}`;
  console.info(`agent-sites 监听 ${addr}`);

  // Deno.serve 原生：handler 接收 Request 返回 Response，
  // 不引框架（拒绝 Oak/Hono——会归一尾斜杠破坏三变体路由契约）。
  Deno.serve(
    { hostname: cli.host, port: cli.port },
    handler,
  );
}

// 顶层入口（对应 #[tokio::main] 启动 runtime 后立即 await main()）
// 任何抛出的错误转 console.error + exit(1)（对应 anyhow::Result 的 main 返回 Err 时退出码 1）
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("agent-sites 启动失败：", err);
    Deno.exit(1);
  });
}
