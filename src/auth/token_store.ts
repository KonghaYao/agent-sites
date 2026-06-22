// TokenStore：单文件 JSON 持久化的 token 元数据仓储（参考 AppStore 模式）
//
// 跟 AppStore 的差异：
// - 不需要 SSRF 端口校验（token 不含端口）
// - 多了 revoke / revokeAllByApp / updateLastUsed 三个状态变更方法
// - 不存 token 字符串本身（只用 master key + payload 重算）

/** Token 状态。active=有效 / revoked=已吊销。 */
export type TokenStatus = "active" | "revoked";

/** Token 元数据（不含 token 字符串）。 */
export interface TokenRecord {
  token_id: string;
  app_id: string;
  status: TokenStatus;
  issued_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** 磁盘文件结构。 */
interface StoreFile {
  tokens: TokenRecord[];
}

/**
 * Token 仓储：内存中 Map<token_id, TokenRecord> + 持久化到 tokens.json。
 *
 * 跟 AppStore 一样，所有读写方法在同同步段内完成，无锁但天然原子。
 * 调用方负责显式 flush 把状态写到磁盘。
 */
export class TokenStore {
  private records: Map<string, TokenRecord>;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.records = new Map();
    try {
      const text = Deno.readTextFileSync(path);
      const file = JSON.parse(text) as StoreFile;
      for (const r of file.tokens ?? []) {
        this.records.set(r.token_id, { ...r });
      }
    } catch {
      // 文件不存在或解析失败：空集合（首次启动）
    }
  }

  /** 加一个 token，id 已存在返回 false。 */
  // deno-lint-ignore require-await
  async add(record: TokenRecord): Promise<boolean> {
    if (this.records.has(record.token_id)) return false;
    this.records.set(record.token_id, { ...record });
    return true;
  }

  /** 按 id 查找。 */
  // deno-lint-ignore require-await
  async get(tokenId: string): Promise<TokenRecord | undefined> {
    const r = this.records.get(tokenId);
    return r ? { ...r } : undefined;
  }

  /** 列出所有 token。 */
  // deno-lint-ignore require-await
  async list(): Promise<TokenRecord[]> {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  /** 按 app_id 过滤列表。 */
  // deno-lint-ignore require-await
  async listByApp(appId: string): Promise<TokenRecord[]> {
    return Array.from(this.records.values())
      .filter((r) => r.app_id === appId)
      .map((r) => ({ ...r }));
  }

  /** 吊销 token（status → revoked + revoked_at 写时间戳）。成功返回 true。 */
  // deno-lint-ignore require-await
  async revoke(tokenId: string, revokedAt: string): Promise<boolean> {
    const r = this.records.get(tokenId);
    if (!r) return false;
    r.status = "revoked";
    r.revoked_at = revokedAt;
    return true;
  }

  /** 吊销某 app 的所有 active token。返回吊销数量。 */
  // deno-lint-ignore require-await
  async revokeAllByApp(appId: string, revokedAt: string): Promise<number> {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.app_id === appId && r.status === "active") {
        r.status = "revoked";
        r.revoked_at = revokedAt;
        n++;
      }
    }
    return n;
  }

  /** 更新 last_used_at（代理层每次成功转发时调）。 */
  // deno-lint-ignore require-await
  async updateLastUsed(tokenId: string, usedAt: string): Promise<boolean> {
    const r = this.records.get(tokenId);
    if (!r) return false;
    r.last_used_at = usedAt;
    return true;
  }

  /** 持久化到磁盘（原子写：tmp + rename）。 */
  async flush(): Promise<void> {
    const file: StoreFile = {
      tokens: Array.from(this.records.values()).map((r) => ({ ...r })),
    };
    const text = JSON.stringify(file, null, 2);
    const tmpPath = `${this.path}.tmp`;
    await Deno.writeTextFile(tmpPath, text);
    await Deno.rename(tmpPath, this.path);
  }
}
