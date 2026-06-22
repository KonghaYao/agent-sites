// 端口分配器：在 [min, max] 范围内分配未使用的端口
// 翻译自 crates/server/src/process/port_allocator.rs

/**
 * 端口分配器：在 [min, max] 范围内分配未使用的端口。
 *
 * Rust 原实现是无状态的纯函数式结构体（min/max + 纯函数 allocate），
 * TS 端保持等价的 class + 同步方法。Deno 单线程事件循环，无需锁。
 */
export class PortAllocator {
  constructor(
    public readonly min: number,
    public readonly max: number,
  ) {}

  /**
   * 返回范围内首个未使用的端口；全占用时返回 0。
   *
   * @param used 已占用端口集合（Rust 的 HashSet<u16>，TS 用 Set<number>）
   */
  allocate(used: Set<number>): number {
    if (this.min > this.max) {
      return 0;
    }
    for (let port = this.min; port <= this.max; port++) {
      if (!used.has(port)) {
        return port;
      }
    }
    return 0;
  }
}
