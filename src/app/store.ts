// AppStore：单文件 JSON 持久化的 App 仓储（线程安全的内存 Map + 原子写盘）
// 由 crates/server/src/app/store.rs 1:1 迁移而来。
//
// 翻译决策：
// - parking_lot::RwLock<Vec<App>> → 模块内 Map / 数组（Deno 单线程事件循环，无需锁；
//   check+insert 在同一同步段内完成，TOCTOU 竞态天然消除）
// - Arc<RwLock<...>> Clone → 直接传引用（class 实例共享，无 clone 概念）
// - serde Serialize/Deserialize → JSON.parse / JSON.stringify
// - tokio::fs::write + rename 原子写 → Deno.writeTextFile + Deno.rename
// - Result<T, anyhow::Error> → 抛 Error（调用方 try/catch）
// - tracing::warn! / tracing::error! → console.warn / console.error
// - HashSet<u16> → Set<number>
// - Vec<App>.clone() 返回快照 → 数组 slice / structuredClone 返回新引用

import type { App } from "./model.ts";

/** 磁盘文件结构（对应 Rust StoreFile）。 */
interface StoreFile {
  apps: App[];
}

/**
 * App 仓储：管理内存中的 App 列表 + 持久化到 apps.json。
 *
 * 等价 Rust `pub struct AppStore`。注意：
 * - 构造时从磁盘加载并做端口范围校验（SSRF 防护，Issue #4）。
 * - 所有读写方法都在同一事件循环 tick 内同步完成，无 await 间隙，
 *   因此 `add_if_absent` 的 check+insert 原子性等价 Rust write guard。
 */
export class AppStore {
  /** 内存中的 App 列表（顺序敏感，list 返回快照）。 */
  private apps: App[];
  /** 持久化文件路径（apps.json）。 */
  private readonly path: string;

  /**
   * 创建 store 并加载磁盘上的 apps.json。
   *
   * Issue #4：加载完成后校验每个 App.port 是否在 [portMin, portMax] 范围内，
   * 防止篡改 apps.json 后将代理指向非法端口（SSRF 入口，如 22/6379）。
   * 越界端口会被记录 error 日志并跳过。
   */
  constructor(path: string, portMin: number, portMax: number) {
    let apps: App[] = [];
    try {
      const file = AppStore.loadFromDisk(path);
      apps = file.apps;
    } catch (e) {
      console.warn(
        `加载 apps.json 失败，使用空集合 path=${path} error=${(e as Error).message}`,
      );
      apps = [];
    }
    // 端口范围校验（SSRF 防护）：越界端口跳过
    this.apps = apps.filter((a) => {
      if (a.port < portMin || a.port > portMax) {
        console.error(
          `App 端口越界，跳过加载（疑似 apps.json 被篡改）` +
            ` app_id=${a.id} port=${a.port} min=${portMin} max=${portMax}`,
        );
        return false;
      }
      return true;
    });
    this.path = path;
  }

  /** 读取并解析 apps.json（对应 Rust load_from_disk）。 */
  private static loadFromDisk(path: string): StoreFile {
    const text = Deno.readTextFileSync(path);
    const file = JSON.parse(text) as StoreFile;
    return file;
  }

  /** 持久化内存快照到 apps.json（原子写：tmp + rename）。 */
  async flush(): Promise<void> {
    const file: StoreFile = { apps: this.snapshot() };
    const text = JSON.stringify(file, null, 2);
    // 原子写：先写临时文件再 rename
    const tmpPath = this.tmpPath();
    await Deno.writeTextFile(tmpPath, text);
    await Deno.rename(tmpPath, this.path);
  }

  /** 返回内存快照（对应 Rust list：read guard → clone）。
   *  保留 async 是为了与未来切换到真正异步存储后端（如 sqlite/deno-kv）的接口稳定性,
   *  调用方都已经 await,无需因内存操作同步化而改签名。 */
  // deno-lint-ignore require-await
  async list(): Promise<App[]> {
    return this.snapshot();
  }

  /** 按 id 查找，返回克隆（对应 Rust get：Option<App>）。 */
  // deno-lint-ignore require-await
  async get(id: string): Promise<App | undefined> {
    const found = this.apps.find((a) => a.id === id);
    return found ? cloneApp(found) : undefined;
  }

  /** 追加 App（对应 Rust add：push 进 write guard）。 */
  // deno-lint-ignore require-await
  async add(app: App): Promise<void> {
    this.apps.push(cloneApp(app));
  }

  /**
   * 原子插入：仅在 id 不存在时插入（对应 Rust add_if_absent）。
   *
   * Issue #5：在同一个同步段内完成 check+insert，消除 create_app 中
   * "先 get 检查冲突 → 再 add"之间的 TOCTOU 竞态。
   * 返回 true 表示插入成功，false 表示 id 已存在（调用方应重试生成 id）。
   */
  // deno-lint-ignore require-await
  async addIfAbsent(app: App): Promise<boolean> {
    // 同步段：check + insert 不跨 await，单线程事件循环天然原子
    if (this.apps.some((a) => a.id === app.id)) {
      return false;
    }
    this.apps.push(cloneApp(app));
    return true;
  }

  /** 全量替换指定 ID 的 App，返回是否找到（对应 Rust update）。 */
  // deno-lint-ignore require-await
  async update(app: App): Promise<boolean> {
    const idx = this.apps.findIndex((a) => a.id === app.id);
    if (idx === -1) return false;
    this.apps[idx] = cloneApp(app);
    return true;
  }

  /** 删除并返回是否删除成功（对应 Rust remove：retain 比较长度）。 */
  // deno-lint-ignore require-await
  async remove(id: string): Promise<boolean> {
    const before = this.apps.length;
    this.apps = this.apps.filter((a) => a.id !== id);
    return this.apps.length !== before;
  }

  /** 返回当前所有占用端口集合（对应 Rust used_ports：HashSet<u16>）。 */
  // deno-lint-ignore require-await
  async usedPorts(): Promise<Set<number>> {
    return new Set(this.apps.map((a) => a.port));
  }

  /** 当前内存快照（浅克隆数组 + 每个 App 克隆，保证调用方修改不影响内部）。 */
  private snapshot(): App[] {
    return this.apps.map(cloneApp);
  }

  /** 临时文件路径：apps.json → apps.json.tmp（对应 Rust with_extension）。 */
  private tmpPath(): string {
    // 与 Rust with_extension("json.tmp") 等价：把扩展名换成 json.tmp
    // Rust 行为：apps.json → apps.json.tmp（追加 .tmp 后缀在扩展名后）
    return `${this.path}.tmp`;
  }
}

/** 深克隆单个 App，避免外部修改污染内部状态（等价 Rust derived Clone）。 */
function cloneApp(app: App): App {
  return { ...app };
}
