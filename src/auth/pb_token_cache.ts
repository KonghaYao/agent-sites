// PB token 缓存：凭证代换 + 内存缓存
//
// 调用方（lib.ts 代理层）拿到 platform token 验证通过后，需要把请求转发到 PB。
// 转发前用 app 的 superuser 凭证换一个 PB token 注入 Authorization header。
// 本模块负责"换 token"逻辑 + 跨请求复用缓存（同一 baseUrl 的 PB token
// 在缓存里复用，避免每次请求都换）。

interface CacheEntry {
  pbToken: string;
}

/**
 * PB token 缓存。键是 baseUrl（一个 PocketBase 进程一个缓存项）。
 *
 * 进程重启缓存即失效，下次请求自动重新换。不持久化（PB token 短命）。
 *
 * 缓存失效场景：
 * - PB 401 反馈（代理层检测到）→ 调 invalidate(baseUrl) → 下次重新换
 * - 进程重启（内存丢失）
 */
export class PbTokenCache {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * 取（缓存命中）或换（缓存未命中）一个 PB token。
   *
   * @param baseUrl PocketBase 的 origin，如 `http://localhost:9000`
   * @param email superuser email
   * @param password superuser password
   * @returns PB superuser token 字符串
   * @throws PB 返回非 2xx 时抛 Error
   */
  async get(baseUrl: string, email: string, password: string): Promise<string> {
    const cached = this.cache.get(baseUrl);
    if (cached) return cached.pbToken;

    const pbToken = await this.fetchPbToken(baseUrl, email, password);
    this.cache.set(baseUrl, { pbToken });
    return pbToken;
  }

  /** 清除某 baseUrl 的缓存（PB 报 401 时调）。 */
  invalidate(baseUrl: string): void {
    this.cache.delete(baseUrl);
  }

  /** 清空所有缓存。 */
  clear(): void {
    this.cache.clear();
  }

  private async fetchPbToken(baseUrl: string, email: string, password: string): Promise<string> {
    const url = `${baseUrl}/api/collections/_superusers/auth-with-password`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `PB auth-with-password 失败 status=${resp.status} body=${text}`,
      );
    }
    const data = await resp.json() as { token?: string };
    if (typeof data.token !== "string") {
      throw new Error(`PB auth-with-password 响应缺少 token 字段`);
    }
    return data.token;
  }
}
