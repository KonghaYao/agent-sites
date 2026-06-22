# 三层鉴权模型：master key + platform token + PB Rules

**日期**: 2026-06-19
**状态**: Draft（覆盖同文件之前 v1，v1 已废弃）

---

## 一、目标

当前 `src/api/apps.ts` 的 `AppResponse` 直接对外返回 `superuser_email` + `superuser_password`，`POST /api/apps` 无鉴权。任何能访问平台端口的调用方都能拿凭证全权操作 PocketBase。

**本设计目标**：建立三层鉴权模型，凭证不出 Deno 平台层。

| 层 | 鉴权方式 | 谁持有 | 用途 |
|----|---------|--------|------|
| **平台管理** | master key（环境变量） | 平台管理员 | 创建/删除 app、申请/吊销 token |
| **App 操作** | platform token（Deno 自签，无过期） | agent | 建表/改 schema（superuser 级） |
| **业务前端** | PB Rules / PB user token | 终端用户（app 自己管理） | 读写记录（透传到 PB） |

**关键不变量**：

- PocketBase superuser 凭证永远只在 Deno ↔ PB 之间（短缓存），不出现在任何 HTTP 响应
- Deno 自签 token 可在平台层主动吊销（stateful：维护 `tokens.json` 的 status）
- 业务前端的请求**不经过 Deno 鉴权层**，直接透传到 PB（PB Rules 处理）

**非目标**：

- 不做 token scope / 细粒度权限（所有 platform token 都是 superuser 级；YAGNI）
- 不做 token 自动过期（用户需求：永久；可吊销足以止血）
- 不做 master key 文件输入（环境变量够用；生产可后期加 `AGENT_SITES_MASTER_KEY_FILE`）
- 不写已有 app 迁移路径（项目初始阶段）

---

## 二、设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 凭证存储 | 平台 `AppStore` 内部持有，不出 HTTP 响应 | 凭证泄漏 = PB 全权；不外泄是底线 |
| Token 签发者 | Deno 平台层（HMAC-SHA256 with master key） | 平台可主动吊销；stateless JWT 做不到 |
| Token payload | `{ token_id, app_id, iat }` | 无 exp 字段（永久） |
| Token 状态 | `tokens.json` 存 `status: active\|revoked` | 吊销靠状态查表 |
| Token 与 app 关系 | 1 app 多 token，独立吊销 | 多 agent 共用 app 时可分别吊销某 agent |
| PB token 缓存 | `Map<app_id, { token, exp }>` 内存缓存 | 避免每次请求都换 token；exp 临近或 PB 401 时刷新 |
| 代理层区分 | HMAC 试签名验证 → 通过 = platform token / 不通过 = 当 PB token 透传 | PB token 是 JWT 结构，跟 HMAC 完全不冲突 |
| 创建 app 鉴权 | 强制 master key（`X-Master-Key` header） | 不再可选；master key 是平台管理的入口 |
| Master key 配置 | 环境变量 `AGENT_SITES_MASTER_KEY` | 启动时读一次，存 `AppState.masterKey` |
| Master key 与 PB 子进程 | `PM.spawn` 清空 env（只传 PATH/HOME/LANG） | 防 PB hooks 跑外部代码时泄漏 master key |
| 业务前端鉴权 | 不做（透传 PB） | 走 PB Rules；属于 app 自己的权限设计 |

---

## 三、API 形状

### 平台管理 API（强制 `X-Master-Key` header）

```
POST   /api/apps                              创建 app（不再返回 token，不再返回凭证）
  Request body: { name?: string }  ← name 可空，空时用 id 当 name；仅展示用，不唯一、不去重
GET    /api/apps                                列 app
GET    /api/apps/{id}                           查 app
DELETE /api/apps/{id}                           删 app（同时吊销该 app 所有关联 token）

POST   /api/tokens                              申请 token
  Request body: { app_id: string }  ← 必填
  Response:      { token_id, app_id, token, status, issued_at, warning }
GET    /api/tokens                              列 token（可选 ?app_id= 过滤）
GET    /api/tokens/{id}                         查 token
DELETE /api/tokens/{id}                         吊销 token（status: active → revoked）

PUT    /api/apps/{id}/files/{*path}             上传前端静态文件到 public/{id}/{path}
  Request body: 任意（按后缀白名单校验：.html/.htm/.css/.js/.json/.svg/.png/.jpg/.jpeg/.webp/.ico/.txt/.map）
  限制：body ≤ 1MiB，路径防穿越（拒绝 .. 段、绝对路径、空路径）
  Response: { data: { path: "/{id}/{path}", bytes: N }, error: null }

POST   /api/apps/{id}/files/bundle              批量上传整目录（gzip tar 归档）
  Request body: gzip 压缩的 tar 归档（通过 magic bytes 1f 8b 识别，Content-Type 可有可无）
  限制：
    - 压缩前 body ≤ 10 MiB
    - 解压后总字节 ≤ 50 MiB (52428800)
    - 单文件 ≤ 5 MiB
    - 最多 200 个条目
    - 每条目路径复用单文件后缀白名单 + 路径防穿越（拒绝 .. 段）
    - 接受 tar -C dir . 标准打包（自动跳过 ./ 和 . 顶层目录条目）
    - 仅处理普通文件条目，目录条目跳过（依赖后续文件条目自动 mkdir 父目录）
  Response: { data: { files: [{path:"/{id}/{relPath}", bytes:N}, ...],
                      total_files: N,
                      total_bytes: N,
                      total_bytes_limit: 52428800 },
               error: null }
  失败语义：超出限制返 413（PAYLOAD_TOO_LARGE），message 含「已写入 N 个文件」
```

#### Request body schema（接口契约）

- **POST /api/apps**: `{ name?: string }`
  - `name` 可空（缺省时用 id 当 name）
  - `name` 校验：trim 后长度 1..32，仅允许 `a-z / 0-9 / '-'`
  - **name 仅展示用，不唯一，不去重**：同 name 多次创建会产生多个 app
- **POST /api/tokens**: `{ app_id: string }`（app_id 必填，缺失 → 400，app 不存在 → 404）
- **PUT /api/apps/{id}/files/{*path}**: 任意二进制（按后缀白名单 + 大小上限校验）

**Master key 校验**：上面 8 个 endpoint 都强制 `X-Master-Key` header。缺失或不匹配 → 401。`/health` 不在此列（健康检查公开）。平台不暴露 PocketBase Admin UI：`/{app_id}/_/` 不透传到 PB，agent 用 API（platform token + 凭证代换）操作 collections。

### App 操作 + 业务前端 API（透传到 PocketBase）

```
ANY    /{app_id}/api/*          Authorization: Bearer <platform_token | pb_token | 无>
```

代理逻辑见 §4。

### AppResponse 变化（移除凭证）

```typescript
// 现在（src/api/apps.ts:68-77）—— 漏洞：
interface AppResponse {
  id, name, port, status, api_path,
  superuser_email,       // ← 移除
  superuser_password,    // ← 移除
  created_at
}

// 改后（GET/POST/DELETE /api/apps* 共用，均无凭证无 token）：
interface AppResponse {
  id, name, port, status, api_path, created_at
}
```

**字段语义**：
- `api_path` = 该 app 的代理 API 前缀，值形如 `/app-xxxxxx/api`，等价于路由 `/{id}/api/*`（业务/管理操作走这里）。
- `name` 仅展示用，不参与路由；空 body 创建时自动用 id 当 name。
- `status` 取值：`starting` / `running` / `error`。

#### 透传字段 case 说明

平台层 snake_case（`token_id` / `app_id` / `created_at`）。**PocketBase 响应字段保留 PB 原生 camelCase**（如 `collectionId` / `collectionName` / `recordId`）——代理层只做凭证代换与 cookie 路径改写，不改 PB JSON 字段名。agent 解析 `/{app_id}/api/*` 响应时需注意 PB 字段命名与平台层不一致。

注意：`POST /api/apps` **不**自动颁发 token。agent 要操作该 app，需要 master key 持有者**单独**调 `POST /api/tokens { app_id }` 申请。

### Token 响应

```typescript
// POST /api/tokens 的返回：
interface CreateTokenResponse {
  token_id: string;
  app_id: string;
  token: string;        // HMAC 签名字符串，仅此一次返回
  issued_at: string;
}

// GET /api/tokens / GET /api/tokens/{id} 的返回（不含 token 字符串）：
interface TokenResponse {
  token_id: string;
  app_id: string;
  status: "active" | "revoked";
  issued_at: string;
  revoked_at: string | null;
  last_used_at: string | null;  // 字段永久 null：不做维护（spec §9）
}
```

`token` 字符串只在 `POST /api/tokens` 返回一次，丢了得吊销重新申请。

---

## 四、代理层鉴权逻辑

```
Deno 收到 /{app_id}/api/* 请求
   ↓
1. 取 Authorization header（Bearer xxx）
2. 如果有 token，先用 master key 做 HMAC 签名验证
   ├─ 验证通过 + payload.app_id === 当前 app_id + status=active
   │     ├─ 取 app 的内部 superuser 凭证
   │     ├─ 查 PB token 缓存 Map<app_id, { pb_token, exp_at }>
   │     │   ├─ 缓存存在且 exp_at > now + 60s → 复用
   │     │   └─ 无 / 过期 → 调 _superusers/auth-with-password 换新 → 写缓存
   │     ├─ 替换 Authorization header 为 Bearer <pb_token>
   │     ├─ （可选）更新 token 的 last_used_at
   │     └─ 转发到 localhost:{port}/api/*
   │
   ├─ 验证通过但 status=revoked
   │     └─ 401 Unauthorized（吊销后失效）
   │
   ├─ 验证通过但 payload.app_id !== 当前 app_id
   │     └─ 403 Forbidden（token 跨 app 用了）
   │
   ├─ 验证不通过（不是 platform token）
   │     ├─ 当作 PB user token / 匿名请求
   │     └─ 原样透传 Authorization header → 转发到 PB（PB Rules 处理）
   │
   └─ PB 返回 401（PB token 过期）
         └─ 如果原 Authorization 是 platform token：清缓存 + 重新换 PB token + 重试一次
         └─ 如果原 Authorization 是 PB user token：直接返回 401 给客户端
```

**HMAC 验证算法**：

```typescript
// platform token 格式：base64url(payload) + "." + base64url(hmac_sig)
// payload: { tid: string, aid: string, iat: number }

function verifyPlatformToken(token: string, masterKey: string): Payload | null {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  const expectedSig = hmacSha256(masterKey, payloadB64);
  if (!constantTimeEqual(sigB64, base64url(expectedSig))) return null;
  try {
    return JSON.parse(decodeBase64Url(payloadB64));
  } catch {
    return null;
  }
}
```

**为什么不会跟 PB token 冲突**：PB token 是标准 JWT（三段 `xxx.yyy.zzz`，中间段是 base64url 编码的 JSON payload），platform token 是两段 `payload.sig`。结构不同，HMAC 签名验证失败即认定为 PB token。

---

## 五、数据存储

### `apps.json`（不变）

```json
{
  "apps": [
    {
      "id": "app-abc123",
      "name": "todo",
      "port": 9000,
      "status": "running",
      "created_at": "...",
      "updated_at": "...",
      "superuser_email": "admin@app-abc123.local",   ← 仍存（内部用）
      "superuser_password": "..."                     ← 仍存（内部用）
    }
  ]
}
```

### `tokens.json`（新增）

```json
{
  "tokens": [
    {
      "token_id": "tok-xyz789",
      "app_id": "app-abc123",
      "status": "active",
      "issued_at": "2026-06-19T10:00:00Z",
      "revoked_at": null,
      "last_used_at": "2026-06-19T11:30:00Z"
    }
  ]
}
```

`token` 字符串本身**不存**（只存 metadata，因为 token 可以用 master key + payload 重算）。吊销靠 `status: revoked` 状态查表。

### PB token 缓存（内存，不持久化）

```typescript
// src/state.ts
interface AppState {
  // ...
  pbTokenCache: Map<string, { token: string; expAt: number }>;  // app_id → 缓存
}
```

进程重启缓存清空，下次请求自动重新换（无副作用）。

---

## 六、Master Key 安全

### 输入

环境变量 `AGENT_SITES_MASTER_KEY`。启动时校验：

- 未设 → 启动失败 + 错误日志（不开放无鉴权模式，跟之前"可选鉴权"决策不同）
- 设了但长度 < 32 字节 → 警告（建议用 `openssl rand -hex 32`）

### 不传给 PB 子进程

`PM.spawn`（`src/process/mod.ts`）当前用 `Deno.Command` 默认继承父进程 env。修改为：

```typescript
new Deno.Command(pbBinary, {
  args: [...],
  env: {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
    LANG: Deno.env.get("LANG") ?? "en_US.UTF-8",
    TZ: Deno.env.get("TZ") ?? "",
  },
  // 其他选项不变
});
```

只传 PB 必需的环境变量。`AGENT_SITES_MASTER_KEY`、`DATA_DIR`、`PUBLIC_DIR` 等都不传给 PB。

### 已知风险（写进 README）

- 同机同用户的其他进程能通过 `/proc/{pid}/environ`（Linux）或 `ps eww`（macOS）读到 master key。OS 层级无法防。
- 跨用户隔离有效。
- 生产环境推荐用 systemd / launchd 的独立用户跑 agent-sites。

---

## 七、撤销机制

Platform token 的吊销是**强保证**：

1. `DELETE /api/tokens/{id}` → 把 `tokens.json` 中该 token 的 `status` 改为 `revoked` + `revoked_at` 写时间戳 + `flush` 持久化
2. 下次该 token 来请求 → Deno 代理层查表发现 `status=revoked` → 401
3. 立即生效，无延迟

`DELETE /api/apps/{id}` 副作用：把该 app 的所有 token 一并标 `revoked`（避免悬挂 token）。

---

## 八、测试

新增测试覆盖：

**Master key 鉴权**：
1. 所有 `/api/*` endpoint 不带 `X-Master-Key` → 401
2. `X-Master-Key` 错 → 401
3. `X-Master-Key` 对 → 正常处理

**AppResponse**：
4. `POST /api/apps` 返回的 `data` 不含 `superuser_email` / `superuser_password` / `token`
5. `GET /api/apps` 列表项不含凭证
6. `GET /api/apps/{id}` 不含凭证

**Token CRUD**：
7. `POST /api/tokens { app_id }` → 返回 `{ token_id, token, ... }`；`token` 是 `payload.sig` 格式
8. `POST /api/tokens` 对不存在 app_id → 404
9. 同一 app_id 可多次 `POST /api/tokens`，每次返回不同 `token_id`（独立 token）
10. `DELETE /api/tokens/{id}` → status 变 `revoked`
11. `DELETE /api/apps/{id}` → 该 app 的所有 token 变 `revoked`

**代理层鉴权**：
12. 带 platform token 调 `GET /{app_id}/api/collections` → 200（凭证代换 + superuser 级）
13. 带 platform token 调 `POST /{app_id}/api/collections` 建表 → 201
14. 带已吊销的 platform token → 401
15. 带 platform token 但 payload.app_id 跟 URL app_id 不一致 → 403
16. 带 PB user token（非 platform token 格式）→ 透传（mock PB 验证 Rules）
17. 无 Authorization → 透传（匿名，PB Rules）
18. PB token 缓存：第二次请求不触发换 token（mock `_superusers/auth-with-password`，断言只调一次）
19. PB token 缓存过期：手动置 `expAt < now` → 下次请求重新换

**回归**：
- `DELETE /api/apps/{id}` 仍正确停进程 + 删数据/静态目录
- 现有 `apps_test.ts` 改造：所有 `superuser_email` / `superuser_password` 断言改成 `token` / `master key` 流程

---

## 九、边界（不做什么）

- **不做 token 过期**：永久有效，吊销靠 `status` 查表
- **不做 token scope**：所有 platform token = superuser 级（建表/改 schema/读写所有数据）。细粒度权限是 PB Rules 的事（业务前端那条路径）
- **不做平台自签 token 的细粒度权限**：YAGNI
- **不动 PB 内部 Rules**：业务前端的访问权限由 app 自己设计（PB collection rules）
- **不暴露 master key 文件输入**：环境变量够用；生产可后期加
- **不做 token 列表分页**：当前规模小；tokens.json 全量加载够用
- **不持久化 PB token 缓存**：进程重启即失效，下次请求自动重新换
- **不更新 `last_used_at`**：TokenResponse 字段永久为 null（schema 占位），代理层每次请求不写 token_store.json，避免放大写放大。审计需求未来再加专门的访问日志。

---

## 十、影响清单

**修改文件**：

- `src/api/apps.ts` —— `AppResponse` 移除凭证字段；`POST /api/apps` 移除凭证返回 + 加 master key 校验
- `src/api/tokens.ts` —— **新增**，Token CRUD handler
- `src/auth/master_key.ts` —— **新增**，`verifyPlatformToken` / `signPlatformToken` / `verifyMasterKey`
- `src/auth/token_store.ts` —— **新增**，`TokenStore` 类（参考 `AppStore` 模式，操作 `tokens.json`）
- `src/state.ts` —— `AppState` 加 `masterKey: string` + `pbTokenCache: Map<...>`
- `src/main.ts` —— 启动时校验 `AGENT_SITES_MASTER_KEY`，注入 `AppState`
- `src/lib.ts` —— `/api/*` 路由前置 master key 中间件；`/{app_id}/api/*` 代理层加 token 验证 + 凭证代换
- `src/process/mod.ts` —— `PM.spawn` 清空 env，只传 PATH/HOME/LANG/TZ
- `src/api/apps_test.ts` —— 改造现有断言
- `src/api/tokens_test.ts` —— **新增**
- `src/auth/*_test.ts` —— **新增**
- `CLAUDE.md` —— 环境变量表加 `AGENT_SITES_MASTER_KEY`

**不变文件**：

- `src/app/model.ts` —— `App` 实体类型字段不变（凭证仍存）
- `src/app/store.ts` —— `AppStore` 仍存凭证
- `src/proxy/mod.ts` —— `forward` 函数不变（代理层在调用前完成 header 替换）
