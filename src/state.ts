// 全局共享状态（硬切换后无 sqlx）
//
// 由 crates/server/src/state.rs 1:1 迁移而来。
//
// 翻译决策（DESIGN CONTEXT）：
// - Rust `pub struct AppState` 字段全部 pub → TS class public readonly 字段
// - `PathBuf` → string（Deno 端统一用字符串表示文件系统路径）
// - Rust struct literal 构造 → TS class constructor 初始化
// - `#[cfg(test)] with_port_range` 测试辅助 → 保留为普通方法（TS 无条件编译，
//   方法名沿用 withPortRange，仅测试调用）
// - AppState 借鉴 C 的 class + 单线程天然共享（无 Arc clone 概念），
//   但保留 A 的同步段语义（spawn + insert 在同一微任务内不跨 await）以防未来 Worker 化
// - AppState 通过引用在 handler 间共享：lib.ts 的 createApp 接收 AppState 实例，
//   ctx (Ctx) 携带 AppState 引用（DESIGN CONTEXT: Handler 签名
//   (req: Request, ctx: Ctx) => Promise<Response>）

import type { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import type { PocketBaseProcessManager } from "./process/mod.ts";

/**
 * 全局共享状态（对应 Rust `pub struct AppState`）。
 *
 * 硬切换后无 sqlx，AppState 仅持有：
 * - PocketBase 二进制路径
 * - 数据根目录 / 前端静态文件根目录
 * - AppStore（apps.json 持久化）
 * - PocketBaseProcessManager（进程生命周期）
 * - 端口范围 + App 数量上限
 *
 * 所有字段公开供 handler/router 直接读取。Deno 单线程事件循环天然共享，
 * 无需 Rust 的 `Arc<AppState>` clone——传引用即可。
 */
export class AppState {
  /** PocketBase 二进制路径（对应 Rust `pb_binary: PathBuf`）。 */
  public pbBinary: string;
  /** App 数据根目录（对应 Rust `data_dir: PathBuf`，env DATA_DIR）。 */
  public dataDir: string;
  /** App 前端静态文件根目录（对应 Rust `public_dir: PathBuf`，env PUBLIC_DIR）。 */
  public publicDir: string;
  /** App 仓储（apps.json 持久化）。 */
  public store: AppStore;
  /** PocketBase 进程管理器（生命周期 + 自愈 + 端口冲突检测）。 */
  public processManager: PocketBaseProcessManager;
  /** App 数量上限（对应 Rust `max_apps: usize`，env MAX_APPS）。 */
  public maxApps: number;
  /** PocketBase 端口范围起（对应 Rust `port_min: u16`，env PB_PORT_MIN）。 */
  public portMin: number;
  /** PocketBase 端口范围止（对应 Rust `port_max: u16`，env PB_PORT_MAX）。 */
  public portMax: number;
  /** Master key（环境变量 AGENT_SITES_MASTER_KEY 注入）。 */
  public masterKey: string;
  /** Token 仓储（tokens.json 持久化）。 */
  public tokenStore: TokenStore;
  /** PB token 缓存（凭证代换层）。 */
  public pbTokenCache: PbTokenCache;

  /**
   * 创建全局共享状态。
   *
   * 参数顺序与 Rust `AppState::new` 一一对应（除了 TS 命名改为 camelCase）。
   * Rust 端 `#[allow(clippy::too_many_arguments)]` 容忍多参数构造器；
   * TS 端保留同样的参数列表以维持 1:1 公共 API（调用方 main.ts 集中构造）。
   */
  constructor(
    pbBinary: string,
    dataDir: string,
    publicDir: string,
    store: AppStore,
    processManager: PocketBaseProcessManager,
    maxApps: number,
    portMin: number,
    portMax: number,
    masterKey: string,
    tokenStore: TokenStore,
    pbTokenCache: PbTokenCache,
  ) {
    this.pbBinary = pbBinary;
    this.dataDir = dataDir;
    this.publicDir = publicDir;
    this.store = store;
    this.processManager = processManager;
    this.maxApps = maxApps;
    this.portMin = portMin;
    this.portMax = portMax;
    this.masterKey = masterKey;
    this.tokenStore = tokenStore;
    this.pbTokenCache = pbTokenCache;
  }

  /**
   * 测试用：覆盖默认端口范围（对应 Rust `with_port_range`）。
   *
   * Rust 端用 builder 风格 `mut self` 链式调用；TS 端直接原地修改字段并
   * 返回 this 以保持链式语义（仅测试调用，生产路径不应使用）。
   */
  withPortRange(min: number, max: number): this {
    this.portMin = min;
    this.portMax = max;
    return this;
  }
}
