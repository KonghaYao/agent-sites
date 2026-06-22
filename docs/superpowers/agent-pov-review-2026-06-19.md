# Agent 视角体验审查报告（2026-06-19）

**审查者身份**：假设的外部 AI agent，目标是在 `agent-sites` 平台上从零做一个 Todo 应用（前端能增删改查）。我只读 `CLAUDE.md` 和 `docs/superpowers/specs/2026-06-19-token-only-access-design.md`，**不读 `src/`**。
**测试环境**：本地起服务，master key 用 `openssl rand -hex 32` 临时生成，全流程 curl 模拟。
**结论摘要**：2 Blocker / 3 Major / 4 Minor。最严重的两件事：(1) `DELETE /{app_id}/api/collections/.../records/{id}` 全量 500；(2) 完全没有 HTML 前端发布入口（无 API + 创建 app 不建静态目录），外部 agent 卡死在"后端跑通但前端发不出去"。

---

## 0. 我作为 agent 能/不能从文档知道什么

**能知道**：
- 平台 URL、`X-Master-Key` header 形式、`AGENT_SITES_MASTER_KEY` 必填。
- 8 个 `/api/apps*` + `/api/tokens*` endpoint 路径、请求大致形状（spec §3 列了）。
- 三层鉴权：master key → platform token（HMAC `payload.sig` 两段）→ PB Rules。
- platform token 申请方式：`POST /api/tokens { app_id }`，token 字符串只返回一次。
- 代理路径：`ANY /{app_id}/api/*`，平台代换 PB superuser token。

**不能知道**（全是 friction，下面每条都会在对应章节展开）：
- `POST /api/apps` 的 body 字段叫什么（spec 没列 body schema，只说"创建 app"）。
- `api_path` 字段是什么意思，返回的 `/app-xxx/api` 跟 `/{app_id}/api/*` 是不是同一个东西。
- 创建 app 后**等多久**才能用 token 调代理（实测首次 503，等 ~2s 后才可用——superuser 预置竞态）。
- PB collection schema 长什么样（agent 必须懂 PocketBase 才能建表；好在平台预置了 `todos` 集合让我跳过这一步）。
- HTML 前端**怎么发布**——spec/CLAUDE.md 全程没提，环境变量表里有 `PUBLIC_DIR` 但没说跟 `{app_id}` 的对应关系。
- `/{app_id}/_/`（Admin UI）实际 404，spec §3 说"不在 master key 校验之列"暗示可访问——预期与实现不符。

---

## 1. 文档可发现性

### 1.1 [Major] `POST /api/apps` body schema 缺失
**现象**：spec §3 只写了 `POST /api/apps 创建 app（不再返回 token，不再返回凭证）`，没列 body。我做第一步时只能猜 `{name:"todo"}`。
**期望**：spec 应该明确 `interface CreateAppRequest { name: string }`，并说明 name 可空（实测空 body 也建，用 id 当 name）。
**严重度**：Major（agent 第一次接触 API，没有 schema 就要试错）。

### 1.2 [Major] HTML 前端发布完全无文档
**现象**：CLAUDE.md 和 token-only spec 都没提"agent 怎么把 HTML 放上去"。`PUBLIC_DIR` 环境变量注释只说"App 前端静态文件根目录"，没说跟 `{app_id}` 的目录约定。
**期望**：spec 应有一节"前端发布"，说明：(a) 创建 app 时是否自动建 `public/{app_id}/`；(b) 有没有上传 API；(c) 浏览器访问入口是 `/{app_id}/` 还是别的。
**严重度**：Major → 实际是 Blocker（详见 §5），但作为"文档可发现性"维度评为 Major。

### 1.3 [Minor] `api_path` 字段语义未解释
**现象**：`POST /api/apps` 返回 `api_path: "/app-xxx/api"`，但 spec 又写代理是 `/{app_id}/api/*`。两者形式一致，但字段含义没明说——我以为是另一个独立 endpoint。
**期望**：spec 标注"`api_path` = 该 app 的代理 API 前缀，等价于 `/{id}/api`"。
**严重度**：Minor。

---

## 2. API 一致性

### 2.1 [OK] 字段命名 snake_case 全程一致
`token_id` / `app_id` / `issued_at` / `created_at` / `api_path`，snake_case 没漏。这点做得好。

### 2.2 [OK] 错误结构统一
所有错误都是 `{"data":null,"error":{"code":"...","message":"..."}}`，code 是 SCREAMING_SNAKE_CASE（`UNAUTHORIZED` / `NOT_FOUND` / `FORBIDDEN` / `PB_UNAVAILABLE` / `INTERNAL_ERROR`）。可解析、可分支。

### 2.3 [Minor] PB 返回的字段（`collectionId`/`collectionName`）是 camelCase
**现象**：`POST /{app_id}/api/collections/todos/records` 返回 `{"collectionId":"pbc_xxx","collectionName":"todos",...}`——这是 PB 自己的 schema，平台透传。agent 拿到的字段 case 不统一（平台层 snake_case，PB 层 camelCase）。
**期望**：文档提示"PB 透传字段保留 PB 原生 camelCase"，避免 agent 困惑。
**严重度**：Minor（不是 bug，是文档提示）。

---

## 3. 错误反馈质量

### 3.1 [Blocker] DELETE 返回 500，错误消息毫无线索
**现象**：
```bash
curl -X DELETE ".../api/collections/todos/records/{id}" -H "Authorization: Bearer $TOKEN"
# {"data":null,"error":{"code":"INTERNAL_ERROR","message":"服务器内部错误"}}  HTTP 500
```
平台日志里才显示 `Response with null body status cannot have body`（代理层把 PB 的 204 当成有 body 处理）。agent 视角完全无法定位——既不是 token 问题也不是路径问题，是平台 bug。
**期望**：修复代理层对 204/304 的处理（不要 set body）。错误消息至少要区分"PB 返回错误"vs"平台内部错误"。
**严重度**：Blocker（CRUD 缺一环，整个 todo app 不能用）。

### 3.2 [Major] 首次代理请求 503 "凭证代换失败"
**现象**：刚创建完 app，立刻申请 token 调 `GET /{app_id}/api/collections`：
```
{"data":null,"error":{"code":"PB_UNAVAILABLE","message":"凭证代换失败：PB auth-with-password 失败 status=400 body={\"data\":{},\"message\":\"Failed to authenticate.\",\"status\":400}"}}
```
等 ~2 秒后再调就成功。
**期望**：要么创建 app 时同步等 superuser 预置完成再返回；要么返回 503 时附带 `Retry-After` 和明确的"app 正在初始化"消息。
**严重度**：Major（agent 第一次调 API 就吃 503，会怀疑流程错了）。

### 3.3 [OK] 鉴权错误消息够用
- 缺 `X-Master-Key` → `缺少或错误的 X-Master-Key`（401）
- token 跨 app → `token 与 app_id 不匹配`（403）
- token 吊销 → `token 已吊销`（401）
- app_id 不存在 → `App 不存在: app-nope`（404）

这些都精准，agent 能直接据此修正。

---

## 4. 流程断裂点

### 4.1 [Major] 创建 app → 立即可用之间存在竞态
见 §3.2。agent 的工作流是"创建 app → 申请 token → 建表"，但如果中间无 sleep 就失败，agent 会陷入"是不是 token 错了？是不是 master key 错了？"的怀疑链。spec 没提示"创建后稍等"。

### 4.2 [Minor] `POST /api/apps` 无 body 也成功，且 name 重复不去重
**现象**：
- `POST /api/apps -d '{}'` → 成功，`name = id`。
- 连发两次 `{name:"dup"}` → 两个不同 id、name 都叫 `dup` 的 app。
**期望**：要么 name 必填校验（400 报错）；要么文档明确"name 仅展示用，不唯一"。
**严重度**：Minor（agent 容易误以为自己成功了，结果 data 里堆了一堆同名 app）。

### 4.3 [Minor] 平台数据目录里能看到历史遗留 app
**现象**：服务首次起来时，`GET /api/apps` 居然返回了 3 个 app（包括一个 name 等于 id 的怪记录、两个抢端口 9000 的 app）。我清理过 `data/apps.json` 但显然有别的来源（或上一轮没清干净），PortAllocator 状态也错乱（两个 app 都拿 9000）。
**期望**：`apps.json` 是单一真相源；端口分配有持久化校验。
**严重度**：Minor（外部 agent 用纯净环境不会遇到，但平台健壮性问题）。

---

## 5. HTML 前端发布（最大摩擦点）

### 5.1 [Blocker] 无任何前端发布 API + 创建 app 不建静态目录
**现象**：
```bash
# 创建 app
curl -X POST .../api/apps -d '{"name":"todo"}'   # ok, 得到 app-xxx
# 浏览器访问
curl -o- http://localhost:3000/app-xxx/          # 404
curl -o- http://localhost:3000/app-xxx/index.html  # 404
```
排查后发现需要**手动** `mkdir public/app-xxx && echo '<html>' > public/app-xxx/index.html`，然后 200。但作为"只能 HTTP"的外部 agent，我**完全没有**文件系统访问权限——意味着外部 agent **不可能**发布前端。
**期望**：至少二选一：
- (a) 平台提供 `POST /api/apps/{id}/files` 或 `PUT /api/apps/{id}/files/{path}`（带 master key 或 app-scoped token 鉴权）支持上传 HTML；
- (b) 创建 app 时自动建 `public/{id}/index.html`（占位页），让 agent 至少能"先看到 200"再想办法替换。
**严重度**：Blocker（这是整个 todo demo 的目标——前端 CRUD，而前端这一环彻底断了）。

### 5.2 [Major] Admin UI (`/{app_id}/_/`) 返回 404
**现象**：spec §3 说"`/{app_id}/_/`（Admin UI）不在此列（需要 PB 凭证登录由 PB 自己处理）"，暗示可访问。实际：
```bash
curl -o- http://localhost:3000/app-xxx/_/  # 404
curl -o- http://localhost:3000/app-xxx/_/index.html  # 404
curl http://localhost:9000/_/  # 直连 PB 是 200
```
平台没有把 `_/` 路径透传到 PB（只透传了 `/api/*`）。
**期望**：要么实现 `_/` 透传（spec 已声明要做），要么从 spec 删掉这条声明别误导。
**严重度**：Major（agent 想用 Admin UI 调试或手工建表都做不到，必须纯 API）。

### 5.3 [Minor] 前端 fetch 相对路径的 shim 文档散落别处
本次没深测（最近 commit `feat/subpath-shim` 应该已经处理），但 CLAUDE.md 里没提"前端 fetch 用相对路径会被自动 shim"。如果 agent 写的 HTML 用绝对路径 `/api/...` 会打到平台根而不是 app 子路径。建议在主 spec 加一句"前端 HTML 必须用相对路径 `./api/...` 或 `${location.pathname}/api/...`"。
**严重度**：Minor（已有 shim 兜底，但 agent 不知道，可能写出 bug）。

---

## 6. Token / 鉴权体验

### 6.1 [OK] 申请、跨 app 拦截、吊销都符合 spec
- 申请：`POST /api/tokens {app_id}` → `{token_id, token, status, issued_at}`，结构跟 spec §3 完全一致。
- 跨 app：app1 的 token 调 app2 → 403 `token 与 app_id 不匹配`。
- 吊销：`DELETE /api/tokens/{id}` → 立即生效，后续请求 401 `token 已吊销`。

### 6.2 [Minor] token 字符串丢失不可找回，无任何提示
**现象**：spec §3 已声明"token 只在 POST 返回一次，丢了得吊销重新申请"。但 API 响应里没有 warning 字段提示 agent"请保存此 token"。agent 拿到响应如果只 log 了 `token_id` 没存 `token`，就只能吊销重来。
**期望**：响应加一个 `"warning": "此 token 仅展示一次，请立即持久化"` 字段。
**严重度**：Minor。

### 6.3 [Minor] 没有续期机制
**现象**：永久 token、无 expiry。这是 spec 有意决策（YAGNI）。但对 agent 来说"无 expiry"反而**难以理解**——习惯上 token 都有 TTL，agent 可能会去找 refresh endpoint。
**期望**：CLAUDE.md 鉴权模型表加一行"platform token 永久有效，无 refresh，吊销靠 DELETE"。
**严重度**：Minor（文档提示问题）。

---

## 7. SDK / 自动化友好度

### 7.1 [OK] HTTP 语义清晰，curl/fetch 都顺畅
所有 endpoint 是标准 REST，状态码语义正确（除了 §3.1 的 DELETE 500 bug）。agent 用 `fetch` 写自动化脚本没有障碍。

### 7.2 [Minor] 缺 OpenAPI / JSON Schema
**现象**：没有 `/openapi.json` 或类似 schema endpoint。agent 想自动生成 client（python/typescript）做不到，只能手抄 spec。
**期望**：导出 OpenAPI 3.0 schema（agent-sites API 数量少，手写成本不高）。
**严重度**：Minor。

### 7.3 [Minor] 错误响应缺 `request_id` 字段
**现象**：平台日志里有 `request_id`，但 HTTP 错误响应里没有。agent 报 bug 给平台管理员时，无法关联日志。
**期望**：错误 body 加 `"request_id": "06b926de"`。
**严重度**：Minor。

---

## 8. 建议改进的优先级排序

| 优先级 | 项 | 章节 | 类型 |
|--------|----|------|------|
| **P0 必修** | DELETE 代理 500（204 处理） | §3.1 | 实现 bug |
| **P0 必修** | HTML 前端发布 API（或至少自动建占位 index.html） | §5.1 | 设计缺口 |
| **P1 强烈建议** | 创建 app 后的"初始化竞态"：等 superuser 预置完成再返回 200，或 503 + Retry-After | §3.2 / §4.1 | 实现 bug |
| **P1 强烈建议** | Admin UI `/{app_id}/_/` 透传，或从 spec 删掉这条声明 | §5.2 | spec/实现 gap |
| **P2 应做** | spec 补 `POST /api/apps` body schema + 前端发布章节 | §1.1 / §1.2 | 文档 |
| **P2 应做** | name 重复校验或文档明示不去重 | §4.2 | 行为澄清 |
| **P3 nice to have** | `api_path` 语义注释 | §1.3 | 文档 |
| **P3 nice to have** | PB camelCase 字段提示 | §2.3 | 文档 |
| **P3 nice to have** | token 响应加"仅展示一次"warning | §6.2 | 体验 |
| **P3 nice to have** | CLAUDE.md 说明 token 永久无 refresh | §6.3 | 文档 |
| **P3 nice to have** | OpenAPI schema 导出 | §7.2 | 自动化 |
| **P3 nice to have** | 错误响应带 `request_id` | §7.3 | 可观测性 |

---

## 9. 整体感受

后端 API（创建 app / 申请 token / CRUD records）的核心流程**设计是干净的**：三层鉴权清晰、错误结构统一、跨 app 隔离到位。这部分给我（agent）的体验是"我能 trust 这个平台"。

但两个 P0 让"todo demo"这个最基本的目标直接卡死：
1. **DELETE 全量 500**——CRUD 缺一环，agent 没法绕。
2. **前端发布零入口**——agent 跑通了后端，但前端 HTML 没法上架，整个 demo 没法交付。这是平台定位（"托管 Agent Web 站点"）跟实现之间最大的 gap。

修掉这两个 P0 + 补上 §1.2 的前端发布文档后，agent-sites 就能从"agent 能创建 app + 操作 PB"升级到"agent 能完整交付一个 web app"。后者才是这个平台的卖点。

---

**审查结束**。平台服务已 kill，data/public 已清理（保留平台自带的 `_panel`）。
