# 三层鉴权模型实现 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现三层鉴权模型（master key 管理 + platform token 操作 app + PB Rules 业务前端），凭证不出 Deno 层，token 可主动吊销。

**Architecture:** Deno 平台层自签 HMAC token（不依赖 PB token）；tokens.json 持久化 token metadata（含吊销状态）；代理层用 HMAC 试签名区分 platform token vs PB token，前者走凭证代换 + 内存缓存 PB token，后者透传到 PB Rules。

**Tech Stack:** Deno 2.x + TypeScript strict + Web Crypto API（HMAC-SHA256）+ 单文件 JSON 持久化（沿用 AppStore 模式）+ PocketBase 0.23 superuser auth API。

**Spec：** `docs/superpowers/specs/2026-06-19-token-only-access-design.md`

---

## 文件结构

**新增**：

- `src/auth/master_key.ts` — `signPlatformToken` / `verifyPlatformToken` / `verifyMasterKeyHeader`（纯函数，Web Crypto HMAC-SHA256）
- `src/auth/master_key_test.ts` — 单测
- `src/auth/token_store.ts` — `TokenStore` 类（参考 AppStore，操作 `tokens.json`）
- `src/auth/token_store_test.ts` — 单测
- `src/auth/pb_token_cache.ts` — PB token 缓存 + 凭证代换（`getPbToken(appId, credentials)`）
- `src/auth/pb_token_cache_test.ts` — 单测
- `src/api/tokens.ts` — Token CRUD handler（`createToken` / `listTokens` / `getToken` / `revokeToken`）
- `src/api/tokens_test.ts` — 单测

**修改**：

- `src/api/apps.ts` — `AppResponse` 移除凭证字段；`POST /api/apps` 不再返回凭证/token
- `src/state.ts` — 加 `masterKey` + `tokenStore` + `pbTokenCache` 字段
- `src/main.ts` — 启动校验 `AGENT_SITES_MASTER_KEY`
- `src/lib.ts` — `/api/*` master key 中间件；`/{app_id}/api/*` 代理层鉴权 + 凭证代换；新增 `/api/tokens*` 路由
- `src/process/mod.ts` — `spawn` 时清空 env，只传白名单
- `src/api/apps_test.ts` — 改造凭证断言
- `CLAUDE.md` — 加 `AGENT_SITES_MASTER_KEY`

---

## Task 1: master_key.ts — HMAC 签名/校验 + master key 头校验

**Files:**
- Create: `src/auth/master_key.ts`
- Test: `src/auth/master_key_test.ts`

- [ ] **Step 1.1: 写失败的测试**

创建 `src/auth/master_key_test.ts`：

```typescript
// master_key 单测
// 被测：src/auth/master_key.ts
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import {
  signPlatformToken,
  verifyPlatformToken,
  verifyMasterKeyHeader,
} from "./master_key.ts";

const TEST_KEY = "test-master-key-0123456789abcdef";

Deno.test({
  name: "test_sign_and_verify_roundtrip",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      TEST_KEY,
    );
    const payload = await verifyPlatformToken(token, TEST_KEY);
    assertEquals(payload, { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 });
  },
});

Deno.test({
  name: "test_verify_wrong_key_returns_null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      TEST_KEY,
    );
    const payload = await verifyPlatformToken(token, "wrong-key");
    assertEquals(payload, null);
  },
});

Deno.test({
  name: "test_verify_tampered_payload_returns_null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      TEST_KEY,
    );
    // 篡改 payload 段（base64url 解码 → 改 tid → 重新编码）
    const [payloadB64, sigB64] = token.split(".");
    const tamperedPayloadB64 = payloadB64.slice(0, -2) + "XX";
    const tamperedToken = `${tamperedPayloadB64}.${sigB64}`;
    const payload = await verifyPlatformToken(tamperedToken, TEST_KEY);
    assertEquals(payload, null);
  },
});

Deno.test({
  name: "test_verify_non_platform_token_returns_null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // 模拟 PB user token（标准 JWT 三段格式）
    const fakeJwt = "eyJhbGci.eyJzdWIi.signature";
    const payload = await verifyPlatformToken(fakeJwt, TEST_KEY);
    assertEquals(payload, null);
  },
});

Deno.test({
  name: "test_verify_master_key_header_correct",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const headers = new Headers({ "X-Master-Key": TEST_KEY });
    assertEquals(verifyMasterKeyHeader(headers, TEST_KEY), true);
  },
});

Deno.test({
  name: "test_verify_master_key_header_missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const headers = new Headers();
    assertEquals(verifyMasterKeyHeader(headers, TEST_KEY), false);
  },
});

Deno.test({
  name: "test_verify_master_key_header_wrong",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const headers = new Headers({ "X-Master-Key": "wrong" });
    assertEquals(verifyMasterKeyHeader(headers, TEST_KEY), false);
  },
});

Deno.test({
  name: "test_two_signatures_differ_per_key",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const t1 = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      "key-1",
    );
    const t2 = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      "key-2",
    );
    assertNotEquals(t1, t2);
  },
});
```

- [ ] **Step 1.2: 运行测试确认失败**

```bash
deno test --allow-all src/auth/master_key_test.ts
```

Expected: FAIL — `Cannot find module './master_key.ts'` 或 `Cannot find name 'signPlatformToken'`

- [ ] **Step 1.3: 实现 master_key.ts**

创建 `src/auth/master_key.ts`：

```typescript
// Platform token HMAC 签名/校验 + master key header 校验
//
// Platform token 格式：base64url(payload_json) + "." + base64url(hmac_sha256_sig)
// payload: { tid: string, aid: string, iat: number }
//
// 注意：跟 PB token（JWT 三段 xxx.yyy.zzz）结构不同，HMAC 试签名验证失败
// 即可认定不是 platform token，让代理层透传到 PB。

/** Platform token payload。 */
export interface PlatformTokenPayload {
  /** Token ID（tok-xxx 格式）。 */
  tid: string;
  /** App ID（app-xxx 格式）。 */
  aid: string;
  /** 签发时间（Unix 秒）。 */
  iat: number;
}

/**
 * 用 master key 签 platform token。
 *
 * 返回 `base64url(payload_json).base64url(hmac_sha256(payload_b64, master_key))`。
 * 用 payload_b64 做 HMAC input（不是裸 JSON），保证验签侧不需要重新序列化
 * JSON（避免 key 顺序差异导致签名不匹配）。
 */
export async function signPlatformToken(
  payload: PlatformTokenPayload,
  masterKey: string,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const key = await importKey(masterKey);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

/**
 * 验证 platform token。成功返回 payload，失败（签名错/格式错）返回 null。
 *
 * 注意：返回 null 不代表"无效 token"——可能是 PB user token 或匿名，
 * 调用方应继续当 PB token 透传处理。
 */
export async function verifyPlatformToken(
  token: string,
  masterKey: string,
): Promise<PlatformTokenPayload | null> {
  const dot = token.indexOf(".");
  // platform token 恰好一段点号；JWT 有两段，dot 位置之后还有 dot 即非 platform token
  const secondDot = token.indexOf(".", dot + 1);
  if (dot === -1 || secondDot !== -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  // 提前验签名，避免 decode 失败的 payload 浪费时间
  const key = await importKey(masterKey);
  const sigBytes = base64UrlDecode(sigB64);
  if (sigBytes === null) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(payloadB64),
  );
  if (!ok) return null;
  const payloadBytes = base64UrlDecode(payloadB64);
  if (payloadBytes === null) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as PlatformTokenPayload;
    if (typeof payload.tid !== "string" || typeof payload.aid !== "string" || typeof payload.iat !== "number") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * 校验 X-Master-Key header 是否匹配 master key。
 * 常数时间比较防 timing attack。
 */
export function verifyMasterKeyHeader(headers: Headers, masterKey: string): boolean {
  const provided = headers.get("X-Master-Key");
  if (provided === null) return false;
  return constantTimeEqual(provided, masterKey);
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

async function importKey(masterKey: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 常数时间字符串比较。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 1.4: 运行测试确认通过**

```bash
deno test --allow-all src/auth/master_key_test.ts
```

Expected: 8 个用例全部 PASS

- [ ] **Step 1.5: 类型检查 + lint + commit**

```bash
deno check src/auth/master_key.ts src/auth/master_key_test.ts
deno lint src/auth/
git add src/auth/master_key.ts src/auth/master_key_test.ts
git commit -m "$(cat <<'EOF'
feat(auth): platform token HMAC 签名/校验 + master key 头校验

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

Expected: check/lint 无错误；commit 成功

---

## Task 2: token_store.ts — Token metadata CRUD

**Files:**
- Create: `src/auth/token_store.ts`
- Test: `src/auth/token_store_test.ts`

- [ ] **Step 2.1: 写失败的测试**

创建 `src/auth/token_store_test.ts`：

```typescript
// TokenStore 单测
// 被测：src/auth/token_store.ts（参考 AppStore 模式）
import { assertEquals } from "jsr:@std/assert@^1";
import { TokenStore } from "./token_store.ts";

async function withStore<T>(
  fn: (store: TokenStore) => Promise<T>,
): Promise<T> {
  const tmp = await Deno.makeTempDir();
  const path = `${tmp}/tokens.json`;
  const store = new TokenStore(path);
  try {
    return await fn(store);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test({
  name: "test_add_and_get_token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      const added = await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      assertEquals(added, true);
      const got = await store.get("tok-abc");
      assertEquals(got?.app_id, "app-xyz");
      assertEquals(got?.status, "active");
    });
  },
});

Deno.test({
  name: "test_add_duplicate_returns_false",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const second = await store.add({
        token_id: "tok-abc",
        app_id: "app-different",
        status: "active",
        issued_at: "2026-06-19T11:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      assertEquals(second, false);
    });
  },
});

Deno.test({
  name: "test_revoke_marks_status_revoked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const ok = await store.revoke("tok-abc", "2026-06-19T12:00:00Z");
      assertEquals(ok, true);
      const got = await store.get("tok-abc");
      assertEquals(got?.status, "revoked");
      assertEquals(got?.revoked_at, "2026-06-19T12:00:00Z");
    });
  },
});

Deno.test({
  name: "test_revoke_unknown_returns_false",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      const ok = await store.revoke("tok-not-exist", "2026-06-19T12:00:00Z");
      assertEquals(ok, false);
    });
  },
});

Deno.test({
  name: "test_revoke_all_by_app_revokes_every_token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      for (const tid of ["tok-1", "tok-2", "tok-3"]) {
        await store.add({
          token_id: tid,
          app_id: "app-xyz",
          status: "active",
          issued_at: "2026-06-19T10:00:00Z",
          revoked_at: null,
          last_used_at: null,
        });
      }
      await store.add({
        token_id: "tok-other",
        app_id: "app-other",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const n = await store.revokeAllByApp("app-xyz", "2026-06-19T12:00:00Z");
      assertEquals(n, 3);
      // app-other 不受影响
      const other = await store.get("tok-other");
      assertEquals(other?.status, "active");
    });
  },
});

Deno.test({
  name: "test_list_returns_all",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-1",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      await store.add({
        token_id: "tok-2",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T11:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const list = await store.list();
      assertEquals(list.length, 2);
    });
  },
});

Deno.test({
  name: "test_list_by_app_filters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-1",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      await store.add({
        token_id: "tok-2",
        app_id: "app-other",
        status: "active",
        issued_at: "2026-06-19T11:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const list = await store.listByApp("app-xyz");
      assertEquals(list.length, 1);
      assertEquals(list[0].token_id, "tok-1");
    });
  },
});

Deno.test({
  name: "test_flush_persists_across_instances",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const tmp = await Deno.makeTempDir();
    const path = `${tmp}/tokens.json`;
    try {
      const store1 = new TokenStore(path);
      await store1.add({
        token_id: "tok-persist",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      await store1.flush();
      // 新实例加载
      const store2 = new TokenStore(path);
      const got = await store2.get("tok-persist");
      assertEquals(got?.app_id, "app-xyz");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "test_update_last_used",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const ok = await store.updateLastUsed("tok-abc", "2026-06-19T11:30:00Z");
      assertEquals(ok, true);
      const got = await store.get("tok-abc");
      assertEquals(got?.last_used_at, "2026-06-19T11:30:00Z");
    });
  },
});
```

- [ ] **Step 2.2: 运行测试确认失败**

```bash
deno test --allow-all src/auth/token_store_test.ts
```

Expected: FAIL — `Cannot find module './token_store.ts'`

- [ ] **Step 2.3: 实现 token_store.ts**

创建 `src/auth/token_store.ts`：

```typescript
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
    const file: StoreFile = { tokens: Array.from(this.records.values()).map((r) => ({ ...r })) };
    const text = JSON.stringify(file, null, 2);
    const tmpPath = `${this.path}.tmp`;
    await Deno.writeTextFile(tmpPath, text);
    await Deno.rename(tmpPath, this.path);
  }
}
```

- [ ] **Step 2.4: 运行测试确认通过**

```bash
deno test --allow-all src/auth/token_store_test.ts
```

Expected: 9 个用例全部 PASS

- [ ] **Step 2.5: 类型检查 + lint + commit**

```bash
deno check src/auth/token_store.ts src/auth/token_store_test.ts
deno lint src/auth/token_store.ts
git add src/auth/token_store.ts src/auth/token_store_test.ts
git commit -m "$(cat <<'EOF'
feat(auth): TokenStore 单文件 JSON 持久化 + 吊销状态

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: pb_token_cache.ts — 凭证代换 + 内存缓存 PB token

**Files:**
- Create: `src/auth/pb_token_cache.ts`
- Test: `src/auth/pb_token_cache_test.ts`

- [ ] **Step 3.1: 写失败的测试**

创建 `src/auth/pb_token_cache_test.ts`：

```typescript
// pb_token_cache 单测
// 被测：src/auth/pb_token_cache.ts
// 验证：凭证代换 + 缓存 + 过期重新换
import { assertEquals } from "jsr:@std/assert@^1";
import { PbTokenCache } from "./pb_token_cache.ts";

/** 起一个假 PocketBase HTTP 服务，记录被调次数，返回固定 token。 */
async function startFakePb(
  responses: { status: number; body: string }[] = [
    { status: 200, body: JSON.stringify({ token: "pb-token-1" }) },
  ],
): Promise<{ port: number; calls: { path: string; body: string }[]; stop: () => Promise<void> }> {
  const calls: { path: string; body: string }[] = [];
  let idx = 0;
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      calls.push({ path: url.pathname, body });
      const resp = responses[Math.min(idx, responses.length - 1)];
      idx++;
      return new Response(resp.body, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    calls,
    stop: async () => {
      controller.abort();
      await server.finished.catch(() => {});
    },
  };
}

Deno.test({
  name: "test_first_call_fetches_pb_token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb();
    try {
      const cache = new PbTokenCache();
      const token = await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      assertEquals(token, "pb-token-1");
      assertEquals(fake.calls.length, 1);
      assertEquals(fake.calls[0].path, "/api/collections/_superusers/auth-with-password");
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "test_second_call_uses_cache_no_fetch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb();
    try {
      const cache = new PbTokenCache();
      await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      assertEquals(fake.calls.length, 1);
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "test_invalidate_forces_refetch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb([
      { status: 200, body: JSON.stringify({ token: "pb-token-1" }) },
      { status: 200, body: JSON.stringify({ token: "pb-token-2" }) },
    ]);
    try {
      const cache = new PbTokenCache();
      const t1 = await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      cache.invalidate(`http://localhost:${fake.port}`);
      const t2 = await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      assertEquals(t1, "pb-token-1");
      assertEquals(t2, "pb-token-2");
      assertEquals(fake.calls.length, 2);
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "test_fetch_failure_throws",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb([
      { status: 401, body: JSON.stringify({ message: "invalid credentials" }) },
    ]);
    try {
      const cache = new PbTokenCache();
      let threw = false;
      try {
        await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "wrong");
      } catch (_e) {
        threw = true;
      }
      assertEquals(threw, true);
    } finally {
      await fake.stop();
    }
  },
});
```

- [ ] **Step 3.2: 运行测试确认失败**

```bash
deno test --allow-all src/auth/pb_token_cache_test.ts
```

Expected: FAIL — `Cannot find module './pb_token_cache.ts'`

- [ ] **Step 3.3: 实现 pb_token_cache.ts**

创建 `src/auth/pb_token_cache.ts`：

```typescript
// PB token 缓存：凭证代换 + 内存缓存
//
// 调用方（lib.ts 代理层）拿到 platform token 验证通过后，需要把请求转发到 PB。
// 转发前用 app 的 superuser 凭证换一个 PB token 注入 Authorization header。
// 本模块负责"换 token"逻辑 + 跨请求复用缓存（同一 baseUrl 同一凭证的 PB token
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
```

- [ ] **Step 3.4: 运行测试确认通过**

```bash
deno test --allow-all src/auth/pb_token_cache_test.ts
```

Expected: 4 个用例全部 PASS

- [ ] **Step 3.5: 类型检查 + lint + commit**

```bash
deno check src/auth/pb_token_cache.ts src/auth/pb_token_cache_test.ts
deno lint src/auth/pb_token_cache.ts
git add src/auth/pb_token_cache.ts src/auth/pb_token_cache_test.ts
git commit -m "$(cat <<'EOF'
feat(auth): PB token 缓存 + 凭证代换

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: AppState 加 masterKey + tokenStore + pbTokenCache；main.ts 启动校验

**Files:**
- Modify: `src/state.ts`
- Modify: `src/main.ts`
- Test: `src/state_test.ts`（新建）

- [ ] **Step 4.1: 写失败的测试**

创建 `src/state_test.ts`：

```typescript
// AppState 新增字段的单测
import { assertEquals } from "jsr:@std/assert@^1";
import { AppState } from "./state.ts";
import { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";

Deno.test({
  name: "test_appstate_holds_master_key_and_token_store",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const store = new AppStore("/tmp/test-apps.json", 9000, 11000);
    const tokenStore = new TokenStore("/tmp/test-tokens.json");
    const pbTokenCache = new PbTokenCache();
    const pm = new PocketBaseProcessManager("/tmp/pb");
    const state = new AppState(
      "/tmp/pb",
      "/tmp/data",
      "/tmp/public",
      store,
      pm,
      50,
      9000,
      11000,
      "my-master-key",
      tokenStore,
      pbTokenCache,
    );
    assertEquals(state.masterKey, "my-master-key");
    assertEquals(state.tokenStore, tokenStore);
    assertEquals(state.pbTokenCache, pbTokenCache);
  },
});
```

- [ ] **Step 4.2: 运行测试确认失败**

```bash
deno test --allow-all src/state_test.ts
```

Expected: FAIL — 构造函数参数数量不对 / `masterKey` 字段不存在

- [ ] **Step 4.3: 改 state.ts**

修改 `src/state.ts`：

在文件顶部 import 区追加：

```typescript
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
```

把 `AppState` class 改为（加 3 个字段 + 改构造函数）：

```typescript
export class AppState {
  public pbBinary: string;
  public dataDir: string;
  public publicDir: string;
  public store: AppStore;
  public processManager: PocketBaseProcessManager;
  public maxApps: number;
  public portMin: number;
  public portMax: number;
  /** Master key（环境变量 AGENT_SITES_MASTER_KEY 注入）。 */
  public masterKey: string;
  /** Token 仓储（tokens.json 持久化）。 */
  public tokenStore: TokenStore;
  /** PB token 缓存（凭证代换层）。 */
  public pbTokenCache: PbTokenCache;

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

  withPortRange(min: number, max: number): this {
    this.portMin = min;
    this.portMax = max;
    return this;
  }
}
```

- [ ] **Step 4.4: 改 main.ts 启动时校验 + 注入**

修改 `src/main.ts`：

在 import 区追加：

```typescript
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
```

在 `main()` 函数中，紧接 `parseCli(Deno.args)` 之后插入 master key 校验：

```typescript
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
```

在构造 `store` 之后插入 TokenStore + PbTokenCache 构造：

```typescript
  // 构造 TokenStore（持久化 tokens.json）
  const tokenStore = new TokenStore(`${cli.dataDir}/tokens.json`);

  // 构造 PbTokenCache（凭证代换 + 内存缓存）
  const pbTokenCache = new PbTokenCache();
```

修改 `new AppState(...)` 调用，末尾追加 3 个参数：

```typescript
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
```

- [ ] **Step 4.5: 更新 apps_test.ts 的 makeAppState helper**

`src/api/apps_test.ts` 的 `makeAppStateWithRange` 函数末尾 `new AppState(...)` 也需要追加 3 个参数。

在文件顶部 import 区追加：

```typescript
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
```

把 `makeAppStateWithRange` 函数体改为：

```typescript
async function makeAppStateWithRange(
  tmp: string,
  portMin: number,
  portMax: number,
): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  const store = new AppStore(`${dataDir}/apps.json`, portMin, portMax);
  const pm = new PocketBaseProcessManager(pbBinaryPath());
  const tokenStore = new TokenStore(`${dataDir}/tokens.json`);
  const pbTokenCache = new PbTokenCache();
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    store,
    pm,
    50,
    portMin,
    portMax,
    "test-master-key-fixed-0123456789abcdef",
    tokenStore,
    pbTokenCache,
  );
}
```

注：所有用 `makeAppState` helper 的测试文件都会自动获得这 3 个字段。

- [ ] **Step 4.6: 运行所有测试确认通过**

```bash
deno task test
```

Expected: 全部 PASS（除 pb 不可用时被 skip 的）

- [ ] **Step 4.7: 类型检查 + lint + commit**

```bash
deno task check
deno task lint
git add src/state.ts src/main.ts src/state_test.ts src/api/apps_test.ts
git commit -m "$(cat <<'EOF'
feat(state): AppState 加 masterKey/tokenStore/pbTokenCache；main 校验环境变量

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: lib.ts 加 master key 中间件

**Files:**
- Modify: `src/lib.ts`
- Test: `src/lib_master_key_test.ts`（新建）

- [ ] **Step 5.1: 写失败的测试**

创建 `src/lib_master_key_test.ts`：

```typescript
// master key 中间件单测
// 被测：src/lib.ts 的 requireMasterKey 包装
import { assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";
import { AppState } from "./state.ts";
import { createApp as makeRouter } from "./lib.ts";
import { pbBinaryPath } from "./process/pocketbase.ts";

async function makeState(tmp: string): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    new AppStore(`${dataDir}/apps.json`, 9000, 11000),
    new PocketBaseProcessManager(pbBinaryPath()),
    50,
    9000,
    11000,
    "test-master-key-fixed-0123456789abcdef",
    new TokenStore(`${dataDir}/tokens.json`),
    new PbTokenCache(),
  );
}

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, sanitizeExit: false, fn });
}

test("test_api_apps_无_master_key_返回_401", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(new Request("http://x/api/apps", { method: "GET" }));
    assertEquals(resp.status, 401);
    const body = await resp.json();
    assertEquals(body.error.code, "UNAUTHORIZED");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_api_apps_错误_master_key_返回_401", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps", {
        method: "GET",
        headers: { "X-Master-Key": "wrong-key" },
      }),
    );
    assertEquals(resp.status, 401);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_api_apps_正确_master_key_返回_200", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/apps", {
        method: "GET",
        headers: { "X-Master-Key": "test-master-key-fixed-0123456789abcdef" },
      }),
    );
    assertEquals(resp.status, 200);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_health_不需要_master_key", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(new Request("http://x/health"));
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "ok");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
```

- [ ] **Step 5.2: 运行测试确认失败**

```bash
deno test --allow-all src/lib_master_key_test.ts
```

Expected: FAIL — 没带 header 应该 401 但现在返回 200（中间件还没加）

- [ ] **Step 5.3: 改 lib.ts 加 master key 中间件**

修改 `src/lib.ts`，import 区追加：

```typescript
import { verifyMasterKeyHeader } from "./auth/master_key.ts";
import { AppError } from "./error.ts";  // 已存在，无需重复
```

在 `dispatchWithRequestId` 函数中，路由匹配成功之后、调 handler 之前加 master key 校验。找到：

```typescript
  const matched = matchRoute(routes, req.method, pathname);
  if (!matched) {
    throw AppError.NotFound(`路由不存在: ${req.method} ${pathname}`);
  }
```

之后追加：

```typescript
  // Master key 中间件：所有 /api/* 路径强制校验 X-Master-Key
  // （/health 不在 /api/* 下，不受影响；/{app_id}/api/* 是 PB 代理，不走这里——
  //   PB 代理有独立的 token 验证逻辑，见 serveApiProxy）
  if (pathname === "/api/apps" || pathname.startsWith("/api/apps/") ||
      pathname === "/api/tokens" || pathname.startsWith("/api/tokens/")) {
    if (!verifyMasterKeyHeader(req.headers, state.masterKey)) {
      return AppError.Unauthorized("缺少或错误的 X-Master-Key").toResponse();
    }
  }
```

- [ ] **Step 5.4: 运行测试确认通过**

```bash
deno test --allow-all src/lib_master_key_test.ts
```

Expected: 4 个用例全部 PASS

- [ ] **Step 5.5: 类型检查 + lint + commit**

```bash
deno task check
deno task lint
git add src/lib.ts src/lib_master_key_test.ts
git commit -m "$(cat <<'EOF'
feat(lib): /api/* 路由前置 master key 中间件

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: AppResponse 移除凭证字段；改造 apps_test.ts 断言

**Files:**
- Modify: `src/api/apps.ts`
- Modify: `src/api/apps_test.ts`

- [ ] **Step 6.1: 改 AppResponse 类型**

修改 `src/api/apps.ts` 的 `AppResponse` 接口（删除凭证字段）：

```typescript
/** App 响应体（不含任何敏感字段）。 */
export interface AppResponse {
  id: string;
  name: string;
  port: number;
  status: string;
  api_path: string;
  created_at: string;
}
```

修改 `toAppResponse` 函数（移除凭证赋值）：

```typescript
export function toAppResponse(a: App): AppResponse {
  return {
    id: a.id,
    name: a.name,
    port: a.port,
    status: a.status,
    api_path: `/${a.id}/api`,
    created_at: a.created_at,
  };
}
```

- [ ] **Step 6.2: 改 apps_test.ts 的断言**

`src/api/apps_test.ts` 中的测试用到了 `data.superuser_email` / `data.superuser_password`（行 226-227、280-281）。这些断言需要替换成"凭证不在响应里"的验证。

找到所有 `superuser_email` / `superuser_password` 引用，把形如：

```typescript
const email = data.superuser_email;
const password = data.superuser_password;
```

替换为：

```typescript
// 凭证不在 HTTP 响应里（参见 token-only-access 设计）
assertEquals(data.superuser_email, undefined);
assertEquals(data.superuser_password, undefined);
```

把后续用到 `email` / `password` 的代码（如调 `_superusers/auth-with-password`）改成从 store 直接读内部凭证：

```typescript
// 测试用：从 store 直接读凭证（生产路径用户拿不到）
const app = await state.store.get(data.id);
const email = app?.superuser_email ?? "";
const password = app?.superuser_password ?? "";
```

注意：需要把对应测试用例的 `state` 引用从 helper 里暴露出来。如果当前测试用例没持有 `state`，把 helper 改成返回 `{ state, handler }` 元组。

- [ ] **Step 6.3: 运行 apps_test.ts 确认通过**

```bash
deno test --allow-all src/api/apps_test.ts
```

Expected: 全部 PASS

- [ ] **Step 6.4: 全量测试 + 类型检查 + commit**

```bash
deno task test
deno task check
deno task lint
git add src/api/apps.ts src/api/apps_test.ts
git commit -m "$(cat <<'EOF'
feat(api): AppResponse 移除 superuser 凭证字段

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 7: api/tokens.ts — Token CRUD handler

**Files:**
- Create: `src/api/tokens.ts`
- Test: `src/api/tokens_test.ts`

- [ ] **Step 7.1: 写失败的测试**

创建 `src/api/tokens_test.ts`：

```typescript
// Token CRUD handler 单测
// 被测：src/api/tokens.ts + src/lib.ts 的 /api/tokens 路由
import { assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "../app/store.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { AppState } from "../state.ts";
import { createApp as makeRouter } from "../lib.ts";
import { pbBinaryPath, pbBinaryAvailable, withTestSpawnLock } from "../process/pocketbase.ts";

const MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(tmp: string, portMin = 21000, portMax = 21100): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    new AppStore(`${dataDir}/apps.json`, portMin, portMax),
    new PocketBaseProcessManager(pbBinaryPath()),
    50,
    portMin,
    portMax,
    MASTER_KEY,
    new TokenStore(`${dataDir}/tokens.json`),
    new PbTokenCache(),
  );
}

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, sanitizeExit: false, fn });
}

test("test_post_tokens_for_unknown_app_returns_404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const resp = await handler(
      new Request("http://x/api/tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Master-Key": MASTER_KEY,
        },
        body: JSON.stringify({ app_id: "app-not-exist" }),
      }),
    );
    assertEquals(resp.status, 404);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_post_tokens_for_existing_app_returns_token", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21200, 21300);
      const handler = makeRouter(state);
      // 先创建一个 app
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ name: "demo" }),
        }),
      );
      const createBody = await createResp.json();
      const appId = createBody.data.id;
      // 申请 token
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Master-Key": MASTER_KEY,
          },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      assertEquals(tokenResp.status, 200);
      const tokenBody = await tokenResp.json();
      assertEquals(typeof tokenBody.data.token, "string");
      assertEquals(tokenBody.data.token.includes("."), true);
      assertEquals(tokenBody.data.app_id, appId);
      assertEquals(tokenBody.data.status, "active");
      // cleanup
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_post_tokens_multiple_times_creates_independent_tokens", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21400, 21500);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "demo2" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      const t1 = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const t2 = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const b1 = await t1.json();
      const b2 = await t2.json();
      assertEquals(b1.data.token_id !== b2.data.token_id, true);
      assertEquals(b1.data.token !== b2.data.token, true);
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_get_tokens_returns_list_without_token_string", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21600, 21700);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "demo3" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const listResp = await handler(
        new Request("http://x/api/tokens", {
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      const listBody = await listResp.json();
      assertEquals(Array.isArray(listBody.data), true);
      assertEquals(listBody.data.length >= 1, true);
      // 列表项不含 token 字符串
      assertEquals(listBody.data[0].token, undefined);
      assertEquals(listBody.data[0].token_id !== undefined, true);
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_delete_token_marks_revoked", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 21800, 21900);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "demo4" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const tokenId = (await tokenResp.json()).data.token_id;
      const revokeResp = await handler(
        new Request(`http://x/api/tokens/${tokenId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      assertEquals(revokeResp.status, 200);
      // 查列表，状态应为 revoked
      const getResp = await handler(
        new Request(`http://x/api/tokens/${tokenId}`, {
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      const getBody = await getResp.json();
      assertEquals(getBody.data.status, "revoked");
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_delete_app_revokes_all_tokens", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 22000, 22100);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "demo5" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      for (let i = 0; i < 2; i++) {
        await handler(
          new Request("http://x/api/tokens", {
            method: "POST",
            headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
            body: JSON.stringify({ app_id: appId }),
          }),
        );
      }
      // 删 app
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      // 查 app 所有 token，都应为 revoked
      const listResp = await handler(
        new Request(`http://x/api/tokens?app_id=${appId}`, {
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      const listBody = await listResp.json();
      for (const t of listBody.data) {
        assertEquals(t.status, "revoked");
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});
```

- [ ] **Step 7.2: 运行测试确认失败**

```bash
deno test --allow-all src/api/tokens_test.ts
```

Expected: FAIL — 路由 `/api/tokens` 不存在（404）

- [ ] **Step 7.3: 实现 api/tokens.ts**

创建 `src/api/tokens.ts`：

```typescript
// Token CRUD handler（/api/tokens 端点）
//
// 所有 endpoint 都被 lib.ts 的 master key 中间件强制 X-Master-Key 校验。
// handler 内部不再单独校验 master key。
//
// 设计要点：
// - POST /api/tokens 颁发新 token，返回完整 token 字符串（仅此一次）
// - GET /api/tokens / GET /api/tokens/{id} 只返回 metadata，不返回 token 字符串
// - DELETE /api/tokens/{id} 软删除（status → revoked），不真删记录

import type { AppState } from "../state.ts";
import type { Ctx, Handler } from "./apps.ts";
import { AppError } from "../error.ts";
import { signPlatformToken } from "../auth/master_key.ts";
import { generateTokenId } from "../auth/token_id.ts";

/** POST /api/tokens 请求体。 */
interface CreateTokenRequest {
  app_id: string;
}

/** POST /api/tokens 返回（含 token 字符串）。 */
export interface CreateTokenResponse {
  token_id: string;
  app_id: string;
  token: string;
  status: "active";
  issued_at: string;
}

/** GET /api/tokens / GET /api/tokens/{id} 返回（不含 token 字符串）。 */
export interface TokenResponse {
  token_id: string;
  app_id: string;
  status: "active" | "revoked";
  issued_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** POST /api/tokens —— 颁发新 token。 */
export async function createToken(req: Request, ctx: Ctx): Promise<Response> {
  const state = ctx.state;
  const body = await parseBody<CreateTokenRequest>(req);
  if (!body.app_id) {
    throw AppError.BadRequest("缺少 app_id");
  }
  const app = await state.store.get(body.app_id);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${body.app_id}`);
  }
  const now = new Date().toISOString();
  const tokenId = generateTokenId();
  const payload = { tid: tokenId, aid: app.id, iat: Math.floor(Date.now() / 1000) };
  const token = await signPlatformToken(payload, state.masterKey);
  await state.tokenStore.add({
    token_id: tokenId,
    app_id: app.id,
    status: "active",
    issued_at: now,
    revoked_at: null,
    last_used_at: null,
  });
  await state.tokenStore.flush();
  const resp: CreateTokenResponse = {
    token_id: tokenId,
    app_id: app.id,
    token,
    status: "active",
    issued_at: now,
  };
  return Response.json({ data: resp, error: null });
}

/** GET /api/tokens —— 列出所有 token（可选 ?app_id= 过滤）。 */
export async function listTokens(_req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(_req.url);
  const appIdFilter = url.searchParams.get("app_id");
  const all = appIdFilter
    ? await ctx.state.tokenStore.listByApp(appIdFilter)
    : await ctx.state.tokenStore.list();
  const resp: TokenResponse[] = all.map(tokenToResponse);
  return Response.json({ data: resp, error: null });
}

/** GET /api/tokens/{id} —— 查询 token。 */
export async function getToken(_req: Request, ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  const t = await ctx.state.tokenStore.get(id);
  if (!t) {
    throw AppError.NotFound(`Token 不存在: ${id}`);
  }
  return Response.json({ data: tokenToResponse(t), error: null });
}

/** DELETE /api/tokens/{id} —— 吊销 token。 */
export async function revokeToken(_req: Request, ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  const now = new Date().toISOString();
  const ok = await ctx.state.tokenStore.revoke(id, now);
  if (!ok) {
    throw AppError.NotFound(`Token 不存在: ${id}`);
  }
  await ctx.state.tokenStore.flush();
  return Response.json({ data: { revoked: id }, error: null });
}

/** 在 deleteApp 内部调用：吊销某 app 的所有 active token。 */
export async function revokeAllTokensByApp(
  state: AppState,
  appId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const n = await state.tokenStore.revokeAllByApp(appId, now);
  if (n > 0) await state.tokenStore.flush();
  return n;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function tokenToResponse(t: {
  token_id: string;
  app_id: string;
  status: "active" | "revoked";
  issued_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}): TokenResponse {
  return {
    token_id: t.token_id,
    app_id: t.app_id,
    status: t.status,
    issued_at: t.issued_at,
    revoked_at: t.revoked_at,
    last_used_at: t.last_used_at,
  };
}

async function parseBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export type { Handler };
```

- [ ] **Step 7.4: 创建 token_id.ts helper**

创建 `src/auth/token_id.ts`：

```typescript
// Token ID 生成器
// tok-{8 位 hex}，跟 app id 同样格式但前缀不同（避免混淆）

/** 生成 tok-xxxxxxxx 格式的 token ID。 */
export function generateTokenId(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `tok-${hex.slice(0, 8)}`;
}

/** 校验 token ID 格式：tok-{4..20 个 hex 字符}。 */
export function isValidTokenId(id: string): boolean {
  const rest = id.startsWith("tok-") ? id.slice("tok-".length) : null;
  if (rest === null) return false;
  return rest.length >= 1 && rest.length <= 20 && /^[0-9a-f]+$/.test(rest);
}
```

- [ ] **Step 7.5: 在 lib.ts 加 /api/tokens 路由**

修改 `src/lib.ts`，import 区追加：

```typescript
import {
  createToken as createTokenHandler,
  getToken as getTokenHandler,
  listTokens as listTokensHandler,
  revokeToken as revokeTokenHandler,
} from "./api/tokens.ts";
```

在 `buildRoutes()` 的 `/api/apps/{id}` DELETE 之后追加 4 个路由：

```typescript
    // Token CRUD（master key 强制）
    {
      method: "post",
      segments: parsePattern("/api/tokens"),
      handler: createTokenHandler,
    },
    {
      method: "get",
      segments: parsePattern("/api/tokens"),
      handler: listTokensHandler,
    },
    {
      method: "get",
      segments: parsePattern("/api/tokens/{id}"),
      handler: getTokenHandler,
    },
    {
      method: "delete",
      segments: parsePattern("/api/tokens/{id}"),
      handler: revokeTokenHandler,
    },
```

也在 `dispatchWithRequestId` 的 master key 中间件判定里追加 `pathname.startsWith("/api/tokens/")` 等（如果 Task 5 已经加了，跳过）。

- [ ] **Step 7.6: 在 deleteApp handler 调用 revokeAllTokensByApp**

修改 `src/api/apps.ts` 的 `deleteApp` 函数，在 "删记录" 之后、"删数据目录" 之前插入：

```typescript
  // 吊销该 app 的所有 token（避免悬挂 token）
  await revokeAllTokensByApp(state, id);
```

import 区追加：

```typescript
import { revokeAllTokensByApp } from "./tokens.ts";
```

- [ ] **Step 7.7: 运行 tokens_test 确认通过**

```bash
deno test --allow-all src/api/tokens_test.ts
```

Expected: 6 个用例（除 pb 不可用 skip 的）全部 PASS

- [ ] **Step 7.8: 全量测试 + 类型检查 + commit**

```bash
deno task test
deno task check
deno task lint
git add src/api/tokens.ts src/api/tokens_test.ts src/auth/token_id.ts src/lib.ts src/api/apps.ts
git commit -m "$(cat <<'EOF'
feat(api): Token CRUD handler + /api/tokens 路由 + 删 app 联动吊销

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 8: PM.spawn 清空 env（不传 master key 给 PB 子进程）

**Files:**
- Modify: `src/process/mod.ts`
- Test: `src/process/spawn_env_test.ts`（新建）

- [ ] **Step 8.1: 写失败的测试**

创建 `src/process/spawn_env_test.ts`：

```typescript
// 验证 PB 子进程不会继承 AGENT_SITES_MASTER_KEY
import { assertEquals } from "jsr:@std/assert@^1";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "./pocketbase.ts";
import { PocketBaseProcessManager } from "./mod.ts";
import { PortAllocator } from "./port_allocator.ts";
import { initSuperuser } from "./pocketbase.ts";

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, sanitizeExit: false, fn });
}

test("test_pb_spawn_does_not_inherit_master_key", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    // 在父进程设置敏感环境变量
    const sentinel = "sentinel-master-key-should-not-leak";
    const before = Deno.env.get("AGENT_SITES_MASTER_KEY");
    Deno.env.set("AGENT_SITES_MASTER_KEY", sentinel);
    try {
      const tmp = await Deno.makeTempDir();
      try {
        const pm = new PocketBaseProcessManager(pbBinaryPath());
        const allocator = new PortAllocator(24000, 24099);
        const dataDir = `${tmp}/app-env`;
        await Deno.mkdir(dataDir, { recursive: true });
        initSuperuser(pm.binary, dataDir, "x@y.local", "pw12345678");
        await pm.start("app-env", dataDir, "/app-env/", allocator);

        // 用 PocketBase 自己的 hook 检查环境变量不可行（PB hooks 是 JS 沙箱）
        // 改成查进程的环境变量（macOS: ps eww <pid>；Linux: /proc/<pid>/environ）
        const pid = pm.getPid("app-env");
        assertEquals(pid !== undefined, true);
        const envText = await readProcessEnv(pid!);
        assertEquals(
          envText.includes("AGENT_SITES_MASTER_KEY"),
          false,
          "PB 子进程不应继承 AGENT_SITES_MASTER_KEY",
        );
        assertEquals(
          envText.includes(sentinel),
          false,
          "PB 子进程不应包含父进程的 master key 值",
        );
        // 基本环境变量应该还在
        assertEquals(envText.includes("PATH"), true);

        await pm.stop("app-env");
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    } finally {
      if (before === undefined) {
        Deno.env.delete("AGENT_SITES_MASTER_KEY");
      } else {
        Deno.env.set("AGENT_SITES_MASTER_KEY", before);
      }
    }
  });
});

async function readProcessEnv(pid: number): Promise<string> {
  // macOS: ps eww <pid> 输出含环境变量
  // Linux: cat /proc/<pid>/environ（\0 分隔）
  const cmd = new Deno.Command("ps", { args: ["eww", String(pid)], stdout: "piped", stderr: "null" });
  const out = await cmd.output();
  return new TextDecoder().decode(out.stdout);
}
```

- [ ] **Step 8.2: 运行测试确认失败**

```bash
deno test --allow-all src/process/spawn_env_test.ts
```

Expected: FAIL — PB 子进程继承了 `AGENT_SITES_MASTER_KEY`

- [ ] **Step 8.3: 修改 PM.spawn 清空 env**

修改 `src/process/mod.ts` 中 `start` 方法里的 `new Deno.Command` 调用，加 `env` 字段。

找到（约 275 行）：

```typescript
      const command = new Deno.Command(this.binary, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      });
```

改成：

```typescript
      const command = new Deno.Command(this.binary, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "null",
        env: pbEnvWhitelist(),
      });
```

`restartIfNeeded` 方法里同样的 `new Deno.Command` 调用（约 438 行）也改成同样的样子。

在文件底部辅助函数区追加：

```typescript
/**
 * PocketBase 子进程的环境变量白名单。
 *
 * 默认 Deno.Command 继承父进程所有环境变量，包括 AGENT_SITES_MASTER_KEY。
 * PB 子进程不需要 master key（它的权限是文件系统级的，由 data_dir 隔离）。
 * 这里显式只传 PATH/HOME/LANG/TZ 四个基本变量，防止 PB hooks 跑外部代码时泄漏。
 */
function pbEnvWhitelist(): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
    LANG: Deno.env.get("LANG") ?? "en_US.UTF-8",
    TZ: Deno.env.get("TZ") ?? "",
  };
}
```

- [ ] **Step 8.4: 运行测试确认通过**

```bash
deno test --allow-all src/process/spawn_env_test.ts
```

Expected: PASS

- [ ] **Step 8.5: 全量测试 + commit**

```bash
deno task test
deno task check
deno task lint
git add src/process/mod.ts src/process/spawn_env_test.ts
git commit -m "$(cat <<'EOF'
fix(process): PM.spawn 清空 env 只传白名单，不泄漏 master key 给 PB 子进程

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 9: lib.ts 代理层 token 验证 + 凭证代换

**Files:**
- Modify: `src/lib.ts`
- Test: `src/lib_proxy_auth_test.ts`（新建）

- [ ] **Step 9.1: 写失败的测试**

创建 `src/lib_proxy_auth_test.ts`：

```typescript
// 代理层鉴权 + 凭证代换端到端单测
import { assertEquals } from "jsr:@std/assert@^1";
import { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";
import { AppState } from "./state.ts";
import { createApp as makeRouter } from "./lib.ts";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "./process/pocketbase.ts";

const MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(tmp: string, portMin: number, portMax: number): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    new AppStore(`${dataDir}/apps.json`, portMin, portMax),
    new PocketBaseProcessManager(pbBinaryPath()),
    50,
    portMin,
    portMax,
    MASTER_KEY,
    new TokenStore(`${dataDir}/tokens.json`),
    new PbTokenCache(),
  );
}

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, sanitizeExit: false, fn });
}

/** 端到端：创建 app → 申请 token → 用 token 调 PB 建 collection */
test("test_proxy_with_platform_token_creates_collection", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25000, 25100);
      const handler = makeRouter(state);
      // 1. 创建 app
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "proxydemo" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      // 2. 申请 token
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const platformToken = (await tokenResp.json()).data.token;
      // 3. 用 platform token 调 PB 建 collection
      const createColl = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          method: "POST",
          headers: { "content-type": "application/json", "Authorization": `Bearer ${platformToken}` },
          body: JSON.stringify({
            name: "tasks",
            type: "base",
            listRule: "",
            viewRule: "",
            createRule: "",
            updateRule: null,
            deleteRule: null,
            fields: [{ name: "title", type: "text", required: true }],
          }),
        }),
      );
      assertEquals(createColl.status, 200);
      // 4. 用 token 列 collection（验证 superuser 级）
      const listColl = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${platformToken}` },
        }),
      );
      const listBody = await listColl.json();
      const names = listBody.items?.map((c: { name: string }) => c.name) ?? listBody.data?.map((c: { name: string }) => c.name);
      assertEquals(names?.includes("tasks"), true);
      // cleanup
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_proxy_with_revoked_token_returns_401", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25200, 25300);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "revoke" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      const tokenResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appId }),
        }),
      );
      const tokenBody = await tokenResp.json();
      const platformToken = tokenBody.data.token;
      const tokenId = tokenBody.data.token_id;
      // 吊销
      await handler(
        new Request(`http://x/api/tokens/${tokenId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
      // 用已吊销的 token → 401
      const resp = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${platformToken}` },
        }),
      );
      assertEquals(resp.status, 401);
      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_proxy_with_wrong_app_token_returns_403", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25400, 25500);
      const handler = makeRouter(state);
      // app-a
      const respA = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "appa" }),
        }),
      );
      const appIdA = (await respA.json()).data.id;
      // app-b
      const respB = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "appb" }),
        }),
      );
      const appIdB = (await respB.json()).data.id;
      // 给 app-a 申请 token
      const tResp = await handler(
        new Request("http://x/api/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ app_id: appIdA }),
        }),
      );
      const tokenA = (await tResp.json()).data.token;
      // 用 app-a 的 token 访问 app-b → 403
      const resp = await handler(
        new Request(`http://x/${appIdB}/api/collections`, {
          headers: { "Authorization": `Bearer ${tokenA}` },
        }),
      );
      assertEquals(resp.status, 403);
      await handler(new Request(`http://x/api/apps/${appIdA}`, { method: "DELETE", headers: { "X-Master-Key": MASTER_KEY } }));
      await handler(new Request(`http://x/api/apps/${appIdB}`, { method: "DELETE", headers: { "X-Master-Key": MASTER_KEY } }));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_proxy_with_pb_user_token_passes_through", async () => {
  // 不是 platform token 的请求直接透传，PB 用 Rules 处理
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 25600, 25700);
      const handler = makeRouter(state);
      const createResp = await handler(
        new Request("http://x/api/apps", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Master-Key": MASTER_KEY },
          body: JSON.stringify({ name: "passthrough" }),
        }),
      );
      const appId = (await createResp.json()).data.id;
      // 用一个明显非 platform token 的 JWT（伪造）→ 透传到 PB → PB 返 401（无效 token）
      const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid_sig";
      const resp = await handler(
        new Request(`http://x/${appId}/api/collections`, {
          headers: { "Authorization": `Bearer ${fakeJwt}` },
        }),
      );
      // PB 返 401（无效凭证），Deno 透传不拦
      assertEquals(resp.status, 401);
      await handler(new Request(`http://x/api/apps/${appId}`, { method: "DELETE", headers: { "X-Master-Key": MASTER_KEY } }));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});
```

- [ ] **Step 9.2: 运行测试确认失败**

```bash
deno test --allow-all src/lib_proxy_auth_test.ts
```

Expected: FAIL — 现在的代理层直接透传 platform token 给 PB，PB 返 401

- [ ] **Step 9.3: 改 serveApiProxy 加 token 验证 + 凭证代换**

修改 `src/lib.ts`，import 区追加：

```typescript
import { verifyPlatformToken } from "./auth/master_key.ts";
```

在 `serveApiProxy` 函数里，找到 `const upstreamPath = ...` 之后、读取请求体之前的位置，插入 token 处理逻辑。

原代码（约 346-353）：

```typescript
  const upstreamPath = `/api/${path}`;

  // 读取请求体一次（后续 forward + 自愈路径都要用）
  const body = await readBodyBytes(req);
  const method = req.method;
  const headers = req.headers;
```

改成：

```typescript
  const upstreamPath = `/api/${path}`;

  // 读取请求体一次（后续 forward + 自愈路径都要用）
  const body = await readBodyBytes(req);
  const method = req.method;
  // 复制 header（避免改原 req.headers）
  const headers = new Headers(req.headers);

  // Token 验证 + 凭证代换
  // - 带 platform token：验证签名 + status + app_id 一致 → 替换为 PB superuser token
  // - 带非 platform token 或无 token：原样透传（PB 用 Rules 处理）
  await maybeReplacePlatformTokenWithPbToken(state, appId, app, headers);
```

然后在 `serveApiProxy` 函数下方追加新辅助函数：

```typescript
/**
 * 如果请求头是 platform token 且验证通过，替换为 PB superuser token（凭证代换 + 缓存）。
 *
 * 三种情况：
 * 1. 无 Authorization header → 啥都不做（透传，PB Rules 处理）
 * 2. Authorization 是 platform token：
 *    - 验证签名 + app_id 一致 + status=active → 替换为 PB superuser token
 *    - status=revoked → throw 401
 *    - app_id 不一致 → throw 403
 *    - 验证失败（非 platform token）→ 啥都不做（透传）
 */
async function maybeReplacePlatformTokenWithPbToken(
  state: AppState,
  appId: string,
  app: { superuser_email: string; superuser_password: string; port: number },
  headers: Headers,
): Promise<void> {
  const auth = headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return;
  const rawToken = auth.slice("Bearer ".length);
  const payload = await verifyPlatformToken(rawToken, state.masterKey);
  if (payload === null) {
    // 不是 platform token，透传（PB Rules 处理）
    return;
  }
  // 是 platform token
  if (payload.aid !== appId) {
    throw AppError.Forbidden("token 与 app_id 不匹配");
  }
  const tokenRecord = await state.tokenStore.get(payload.tid);
  if (!tokenRecord) {
    throw AppError.Unauthorized("token 不存在");
  }
  if (tokenRecord.status === "revoked") {
    throw AppError.Unauthorized("token 已吊销");
  }
  // 凭证代换：用 app 的凭证换 PB superuser token
  const baseUrl = `http://localhost:${app.port}`;
  let pbToken: string;
  try {
    pbToken = await state.pbTokenCache.get(
      baseUrl,
      app.superuser_email,
      app.superuser_password,
    );
  } catch (e) {
    throw AppError.ServiceUnavailable(
      `凭证代换失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 替换 header
  headers.set("Authorization", `Bearer ${pbToken}`);
}
```

- [ ] **Step 9.4: 在 PB 401 反馈时清缓存 + 重试（兜底）**

修改 `handleProxyWithRecovery` 之前的 forward 失败 catch（约 377-393），增加 PB 401 处理。原代码：

```typescript
  try {
    return await forward(
      app.port,
      upstreamPath,
      method,
      headers,
      body,
      DEFAULT_MAX_BODY_BYTES,
      appId,
    );
  } catch (e) {
    if (e instanceof AppError && isRecoverableError(e)) {
      console.warn(...);
      return await handleProxyWithRecovery(...);
    }
    throw e;
  }
```

替换为：

```typescript
  try {
    const resp = await forward(
      app.port,
      upstreamPath,
      method,
      headers,
      body,
      DEFAULT_MAX_BODY_BYTES,
      appId,
    );
    // PB 返 401 + 原本是 platform token → 清缓存重试一次
    if (resp.status === 401 && headers.get("X-Replaced-From-Platform-Token") === "1") {
      state.pbTokenCache.invalidate(`http://localhost:${app.port}`);
      return await forward(
        app.port,
        upstreamPath,
        method,
        headers,
        body,
        DEFAULT_MAX_BODY_BYTES,
        appId,
      );
    }
    return resp;
  } catch (e) {
    if (e instanceof AppError && isRecoverableError(e)) {
      console.warn(`forward 失败，触发自愈 app_id=${appId} error=${e.message}`);
      return await handleProxyWithRecovery(state, appId, app, upstreamPath, method, headers, body);
    }
    throw e;
  }
```

并在 `maybeReplacePlatformTokenWithPbToken` 末尾（替换 header 后）追加一个标记 header：

```typescript
  headers.set("Authorization", `Bearer ${pbToken}`);
  headers.set("X-Replaced-From-Platform-Token", "1");  // 用于 401 重试判断
```

- [ ] **Step 9.5: 运行测试确认通过**

```bash
deno test --allow-all src/lib_proxy_auth_test.ts
```

Expected: 4 个用例全部 PASS

- [ ] **Step 9.6: 全量测试 + 类型检查 + commit**

```bash
deno task test
deno task check
deno task lint
git add src/lib.ts src/lib_proxy_auth_test.ts
git commit -m "$(cat <<'EOF'
feat(lib): 代理层 platform token 验证 + 凭证代换 + PB token 缓存

- HMAC 试签名区分 platform token vs PB token
- platform token: 验证签名 + status + app_id 一致 → 替换为 PB superuser token
- PB 401 时清缓存重试一次（兜底）
- 非 platform token 或无 token: 原样透传（PB Rules 处理）

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 10: CLAUDE.md 文档更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 10.1: 加 AGENT_SITES_MASTER_KEY 环境变量说明**

修改 `CLAUDE.md`，找到环境变量表（约 70-80 行）：

```markdown
| 变量 | 说明 |
|------|------|
| `RUST_LOG` | 日志级别（默认 info；沿用旧名兼容 ops 习惯） |
| `RUST_LOG_FORMAT` | `"json"` 时输出 JSON 格式日志 |
| `PB_BINARY` | PocketBase 二进制路径（默认 `bin/pocketbase`） |
| `DATA_DIR` | App 数据根目录（默认 `data`） |
| `PUBLIC_DIR` | App 前端静态文件根目录（默认 `public`） |
| `PB_PORT_MIN` | PocketBase 端口范围起（默认 `9000`） |
| `PB_PORT_MAX` | PocketBase 端口范围止（默认 `11000`） |
| `MAX_APPS` | App 数量上限（默认 `50`） |
```

在末尾追加一行：

```markdown
| `AGENT_SITES_MASTER_KEY` | **必填** 平台 master key（生成方式 `openssl rand -hex 32`）；用于 `POST /api/apps` 和 `/api/tokens*` 鉴权 |
```

并在表后追加新章节"## 鉴权模型"：

```markdown
## 鉴权模型

三层鉴权（详见 `docs/superpowers/specs/2026-06-19-token-only-access-design.md`）：

1. **平台管理**：`X-Master-Key` header（值 = `AGENT_SITES_MASTER_KEY`）。所有 `/api/apps*` 和 `/api/tokens*` endpoint 强制校验。
2. **App 操作**：`Authorization: Bearer <platform_token>`。agent 用 platform token 调 `/{app_id}/api/*`，平台用 app 内部凭证代换为 PB superuser token 转发。Token 在 `POST /api/tokens { app_id }` 申请，可吊销。
3. **业务前端**：无鉴权或 PB user token。直接透传到 PB，由 PB Rules 处理。

关键不变量：PocketBase superuser 凭证永远不出现在 HTTP 响应里。
```

- [ ] **Step 10.2: 恢复 Git Attribution 段（如果被误删）**

检查 `CLAUDE.md` 末尾是否有 `## Git Attribution` 段。如果没有（之前 compact 残留删了），恢复：

```markdown
## Git Attribution

创建 git commit 时，在 commit message 末尾追加：

```
Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
```
```

- [ ] **Step 10.3: commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude): 加 AGENT_SITES_MASTER_KEY + 三层鉴权模型说明

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 11: 端到端冒烟 + 文档收尾

**Files:**
- 无新增/修改

- [ ] **Step 11.1: 清理已有 apps.json / tokens.json**

```bash
rm -f data/apps.json data/tokens.json data/apps.json.tmp data/tokens.json.tmp
```

- [ ] **Step 11.2: 起服务（带 master key）**

```bash
export AGENT_SITES_MASTER_KEY=$(openssl rand -hex 32)
echo "Master key: $AGENT_SITES_MASTER_KEY"
deno task start &
SERVER_PID=$!
```

新终端验证：

```bash
# 1. 无 master key 创建 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/apps \
  -H 'content-type: application/json' -d '{"name":"smoke"}'
# Expected: 401

# 2. 带 master key 创建 → 200
APP=$(curl -sf -X POST http://localhost:3000/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H 'content-type: application/json' -d '{"name":"smoke"}')
APP_ID=$(echo "$APP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
echo "App: $APP_ID"

# 3. 验证响应不含凭证
echo "$APP" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; assert 'superuser_email' not in d and 'superuser_password' not in d, '凭证泄漏！'; print('凭证已隔离 OK')"

# 4. 申请 token
TOKEN_RESP=$(curl -sf -X POST http://localhost:3000/api/tokens \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H 'content-type: application/json' -d "{\"app_id\":\"$APP_ID\"}")
PLATFORM_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
echo "Token: $PLATFORM_TOKEN"

# 5. 用 platform token 建 collection
curl -sf -X POST "http://localhost:3000/$APP_ID/api/collections" \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"tasks","type":"base","listRule":"","viewRule":"","createRule":"","updateRule":null,"deleteRule":null,"fields":[{"name":"title","type":"text","required":true}]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('collection:', d.get('name', d))"
# Expected: collection: tasks

# 6. 列 collection 验证 superuser 级
curl -sf "http://localhost:3000/$APP_ID/api/collections" \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);items=d.get('items',d.get('data',[]));print('collections:', [c['name'] for c in items])"
# Expected: collections: [..., 'tasks']

# 7. 吊销 token
TOKEN_ID=$(echo "$TOKEN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token_id'])")
curl -sf -X DELETE "http://localhost:3000/api/tokens/$TOKEN_ID" \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY"
# 再用旧 token → 401
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/$APP_ID/api/collections" \
  -H "Authorization: Bearer $PLATFORM_TOKEN"
# Expected: 401

# 8. 业务前端透传（无 token）
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/$APP_ID/api/health"
# Expected: 200（PB health 端点不需要鉴权）
```

- [ ] **Step 11.3: 停服务 + 清理**

```bash
kill $SERVER_PID
rm -rf data/app-*
```

- [ ] **Step 11.4: 全量回归**

```bash
deno task test
deno task check
deno task lint
deno task fmt --check
```

Expected: 全部 PASS

---

## 自查清单（plan 作者自查）

**Spec 覆盖**：

- §1 三层鉴权 → Task 4（masterKey 注入）、Task 5（中间件）、Task 9（代理层鉴权 + 透传）
- §3 API 形状 → Task 5（master key 中间件）、Task 6（AppResponse 改造）、Task 7（Token CRUD + 路由）
- §4 代理层鉴权逻辑 → Task 9（完整覆盖）
- §5 数据存储（apps.json / tokens.json / PB token 缓存）→ Task 2（TokenStore）、Task 3（PbTokenCache）、Task 4（注入 state）
- §6 Master key 安全 → Task 4（main.ts 校验）、Task 8（PM.spawn 清空 env）
- §7 撤销机制 → Task 2（revoke/revokeAllByApp）、Task 7（DELETE /api/tokens/{id}）、Task 9（代理层 status 检查）
- §8 测试 → 每个 task 都有对应测试
- §10 影响清单 → 全部 task 覆盖

**Placeholder 扫描**：所有 task 都含完整代码，无 TBD/TODO。

**类型一致性**：

- `PlatformTokenPayload = { tid, aid, iat }` 在 Task 1 定义，Task 7 / Task 9 使用 ✓
- `TokenRecord` 字段（`token_id` / `app_id` / `status` / `issued_at` / `revoked_at` / `last_used_at`）在 Task 2 定义，Task 7 / Task 9 使用 ✓
- `AppState.masterKey` / `tokenStore` / `pbTokenCache` 在 Task 4 定义，Task 5 / 7 / 9 使用 ✓
- `PbTokenCache.get(baseUrl, email, password)` / `.invalidate(baseUrl)` 在 Task 3 定义，Task 9 使用 ✓

**无遗漏的 spec 要求**：所有 §2 设计决策表的项都有对应 task。
