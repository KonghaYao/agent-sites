# Agent 视角体验审查报告（2026-06-19 R3）

**审查者身份**：外部 AI agent，目标 todo 应用。
**测试环境**：本地 `deno task start --port 3299`，临时 master key（`openssl rand -hex 32`），curl 模拟。分支 `feat/deno-pivot`。
**结论摘要**：**0 Blocker / 0 Major / 3 Minor**（R2 是 1 Blocker / 3 Major / 4 Minor）。所有 R2 修复点验证通过，无功能回归。仅剩 3 个文档/边缘行为层面的小问题。

---

## 0. 我作为 agent 能/不能从文档知道什么

只读 `CLAUDE.md` + `docs/superpowers/specs/2026-06-19-token-only-access-design.md`，agent 现在可以**完整**完成 todo 工作流：

- 三层鉴权模型清楚（master key / platform token / PB Rules），知道每个 endpoint 用哪个 header。
- 知道 `POST /api/apps` 不返凭证、`POST /api/tokens` 单独申请、token 永久但可吊销。
- 知道前端发布有**两条路径**：单文件 `PUT /api/apps/{id}/files/{*path}` + 整目录 `POST /api/apps/{id}/files/bundle`（gzip tar，magic bytes 识别，Content-Type 可有可无），含限制清单和响应 schema。
- 知道 `/{app_id}/_/` 不开放、知道 fetch shim 会自动把 `/api/x` 重写为 `/{app_id}/api/x`、知道 PB 透传保留 camelCase 且 status code 200。
- 知道 `last_used_at` 字段永久 null（不做维护）。

**结论**：从 R2 的「文档不全」到现在「文档完备」。一个全新的 agent 读完这两份文档可以独立部署一个 todo 站点。

---

## 1. R2 修复点验证

| R2 编号 | 问题 | 验证命令 | 实际结果 | 结论 |
|---|---|---|---|---|
| **B1** | fetch shim 未注入 | 上传含 `<script>fetch('/api/x')</script>` 的 HTML，GET 验证 | 响应 body 在 `<head>` 后注入 `<script>(function(){ var PREFIX=...; window.fetch = function...})()</script>`，把绝对路径前缀加 `/{app_id}` | **已修复** |
| **bundle 文档化** | spec/CLAUDE.md 未提 bundle | grep `bundle` | CLAUDE.md L104 + spec §3 完整列出 path/body 格式/上限/响应 schema（含 `total_bytes_limit: 52428800`） | **已修复** |
| **M1** | `tar -C dir .` 标准打包被拒 | `tar -C /tmp/site1 -czf b1.tar.gz .` 后 POST | 200，3 个文件全部写入（`./` 顶层目录条目自动跳过） | **已修复** |
| **M2** | 响应缺 `total_bytes_limit` | 检查 bundle 响应 | `{"data":{"files":[...],"total_files":3,"total_bytes":96,"total_bytes_limit":52428800},...}` | **已修复** |
| **M3** | malformed JSON 不返 400 | `POST /api/apps` 带 `{bad json}` + `Content-Type: application/json` | 400 `{"error":{"code":"BAD_REQUEST","message":"JSON 解析失败..."}}` | **已修复** |
| **m1** | PB 透传响应说明缺 | grep `camelCase` | CLAUDE.md L97：PB 透传响应字段保留原生 camelCase，平台层 snake_case 不影响 | **已修复** |
| **m2** | PB status code 说明缺 | grep `200` | CLAUDE.md L99：PB 0.20+ 统一返 200，提醒 agent 不要盲信 201 | **已修复** |
| **m3** | `last_used_at` 说明缺 | grep `last_used_at` | CLAUDE.md L95 + spec §9 L369：明确「永久 null，不更新」 | **已修复** |
| **m4** | bundle Content-Type 行为缺 | grep `magic bytes` | CLAUDE.md L104：通过 gzip magic bytes `1f 8b` 识别，Content-Type 可有可无 | **已修复** |
| **Admin UI 错误消息** | 错误消息不明确 | `GET /{app_id}/_/` | 404 `{"error":{"code":"NOT_FOUND","message":"Admin UI 不开放，请用 platform token + API"}}` | **已修复** |

**R2 全部修复点实测通过。**

---

## 2. 残留 / 新发现问题

### Minor

#### Mi-1：DELETE 单条记录的 PB 透传响应是裸 `{}`，不是平台 `{data,error}` 壳

**命令**：
```bash
curl -X DELETE http://localhost:3299/app-ddfdb898/api/collections/todos/records/22r878j0kvm65g4 \
  -H "Authorization: Bearer $TOKEN"
```
**实际**：HTTP 204，body 空（正确）。但 DELETE 不存在的记录：
```bash
curl -X DELETE .../records/22r878j0kvm65g4  # again
```
返 `{"data":{},"message":"The requested resource wasn't found.","status":404}` —— 这跟平台层 `{"data":null,"error":{...}}` 壳**结构完全不同**。

**影响**：CLAUDE.md L97 已经说了「PB 透传响应字段保留原生 camelCase」，但没说**整个 response envelope 都是 PB 原生结构**（`{data, message, status}` vs 平台 `{data, error}`）。Agent 写错误处理时如果按平台层结构去 `resp.error.code` 取值，对透传响应会拿到 `undefined`。

**建议**：CLAUDE.md 「PB 透传响应字段保留原生 camelCase」这条扩成一句「**整个 response envelope 透传 PB 原生结构**（`{data, message, status}` 形如 PB 标准），平台 `{data, error, request_id}` 壳仅出现在 `/api/apps*` `/api/tokens*` `/api/apps/{id}/files*` 路由」。当前措辞只提了「字段」，没提「envelope」。

#### Mi-2：`POST /api/apps` 缺 name 时返 200（用 id 当 name），但文档没明确说「name 字段整个可省略」

**命令**：
```bash
curl -X POST http://localhost:3299/api/apps \
  -H "X-Master-Key: $KEY" -H "Content-Type: application/json" --data '{}'
```
**实际**：200，`name` 字段 = id（如 `"name":"app-xxxx"`）。spec L96-99 写了「`name` 可空」，CLAUDE.md L96 也说了，但都侧重「`name` 字段值为空」。Agent 实际可能直接 `--data '{}'` 省略整个字段 —— 这条能用，但属于「读 spec 推断」而非「文档明示」。

**影响**：轻微，agent 试一下就知道。

**建议**：CLAUDE.md 「App name 仅展示用」这条加一句「`POST /api/apps` body 整个 `name` 字段可省略，缺省时自动用 id 当 name」。

#### Mi-3：PUT 路径含 `..` 段时返 404「路由不存在」而非明确的「路径不允许」

**命令**：
```bash
curl -X PUT "http://localhost:3299/api/apps/app-ddfdb898/files/../evil.txt" \
  -H "X-Master-Key: $KEY" --data-binary @index.html
```
**实际**：404 `{"error":{"code":"NOT_FOUND","message":"路由不存在: PUT /api/apps/app-ddfdb898/evil.txt"}}`

注意：错误消息已经把 `../` 折叠成 `evil.txt`，路径穿越**实际被防住**（`evil.txt` 不会写到 `public/app-xxx/` 之外 —— 实测确认 `/tmp/evil.txt` 和仓库根 `evil.txt` 都不存在）。安全上无问题，但消息从「路由不存在」推断不出「是因为 `..` 段被吃了」。

**影响**：仅诊断体验。Agent 如果不小心写了相对路径会困惑（「我明明 PUT 到 `../x.txt`，怎么说路由不存在？」）。

**建议**：单文件 PUT path 含 `..` 段时返 400 `路径不允许 '..' 段`（跟 bundle 的消息一致：bundle 是「上传路径不允许 '..' 或 '.' 段」）。

### 未升级为 issue 的观察

- **shim 在缺 `<head>` 的 HTML 上也注入**：测试上传 `<html><body>no head</body></html>`，shim 仍注入到最前面。属合理 fallback，不算问题。
- **shim 注入到子路径 HTML**：`/sub/index.html`（通过 bundle 上传）GET 时也注入 shim。良好。
- **token 吊销立即生效**：`DELETE /api/tokens/{id}` 后再用该 token 调代理立即 401 `token 已吊销`。
- **跨 app token 用**：app2 的 token 打 app1 立即 403 `token 与 app_id 不匹配`。
- **shim 代码含 4 个 `window.fetch` 字面出现**（var orig + 重写 + instanceof 分支），grep `window.fetch` 计数 = 2 行（含赋值行）。

---

## 3. 改进优先级

所有都是 Minor，不阻塞 agent 工作。按价值排序：

1. **Mi-1 PB envelope 说明**：单点改 CLAUDE.md 一行，但能省下大量 agent 调试时间（错误处理是高频踩坑）。建议优先。
2. **Mi-3 PUT `..` 路径错误消息**：纯诊断体验。改 handler 几行代码。
3. **Mi-2 name 字段可省略说明**：文档一行字。

无 Major、无 Blocker。

---

## 4. 整体感受

R2 之后的修复**扎实且无水分**。从 agent 视角看：

- 我读两份文档就能**自洽地**完成 todo 全流程：建 app → 申请 token → 建表 → CRUD → 上传前端（单文件/整目录两条路径都验证过）→ 浏览器访问。
- shim 注入在 R2 是 Blocker，R3 实测无论是 root HTML、子路径 HTML 还是缺 `<head>` 的 HTML 都正确注入。
- bundle 在 R2 是 Major 灾区（`tar -C dir .` 被拒 / `total_bytes_limit` 缺），R3 三种打包方式（`-C dir .` / `czf f1 f2` / 无 Content-Type magic bytes）全部 200，响应 schema 完整。
- 安全回归**全绿**：zip slip → 400、`.exe` → 400、单文件 >5MB → 413、总解压 >50MB → 413、压缩 body >10MB → 413、>200 条目 → 400、非 gzip body → 400、缺 master key → 401、PUT 路径 `..` → 路由层折叠（无文件泄漏）。
- 剩下 3 个 Minor 全是「文档措辞 / 错误消息措辞」层面，agent 实际踩坑概率低。

**与 R2 对比**：1→0 Blocker、3→0 Major、4→3 Minor。开发者声称的「全部修复」经实测成立。可以放心推进后续工作。

---

## 附录：完整命令日志摘要

| 测试 | HTTP 状态 | 关键响应 |
|---|---|---|
| `GET /health` | 200 | — |
| `GET /api/apps` 无 key | 401 | `缺少或错误的 X-Master-Key` |
| `GET /api/apps` 有 key | 200 | `{"data":[],"error":null}` |
| `POST /api/apps` malformed JSON | 400 | `JSON 解析失败` |
| `POST /api/apps {"name":"todo"}` | 200 | id=`app-ddfdb898`，无凭证字段 |
| `POST /api/tokens` | 200 | 返 token + warning |
| `GET /{id}/api/collections` 立即调 | 200 | 无 503 |
| `POST .../collections` 建表 | 200 | PB 0.20+ 返 200 |
| `POST .../records` | 200 | — |
| `PATCH .../records/{id}` | 200 | — |
| `DELETE .../records/{id}` | 204 | 无 500 |
| `DELETE .../records/{id}` again | 404 | PB 原生 envelope |
| `PUT /api/apps/{id}/files/index.html` | 200 | `{path,bytes}` |
| `GET /{id}/` | 200 | body 含 `window.fetch = function` |
| bundle `tar -C dir .` | 200 | 含 `total_bytes_limit: 52428800` |
| bundle `tar czf f1 f2` | 200 | 同上 |
| bundle 无 Content-Type | 200 | magic bytes 识别 |
| bundle zip slip `../evil.txt` | 400 | `路径不允许 '..' 或 '.' 段` |
| bundle `.exe` | 400 | `文件后缀 .exe 不在允许列表` |
| bundle 单文件 >5MB | 413 | `单文件 ... 超过上限 5242880` |
| bundle 总解压 >50MB | 413 | `解压后总字节超过上限 52428800（已写入 10 个文件）` |
| bundle 压缩 body >10MB | 413 | `压缩 body 12509192 字节超过上限 10485760` |
| bundle >200 条目 | 400 | `tar 条目数超过上限 200` |
| bundle 非 gzip | 400 | `缺少 gzip magic 1f 8b` |
| PUT 单文件 >1MB | 413 | `上传 body 2000000 字节超过上限 1048576` |
| `GET /{id}/_/` | 404 | `Admin UI 不开放，请用 platform token + API` |
| `DELETE /api/tokens/{id}` 后调代理 | 401 | `token 已吊销` |
| 跨 app token 调代理 | 403 | `token 与 app_id 不匹配` |
| `POST /api/apps` name 含空格 | 400 | `name 只允许 a-z 0-9 -` |
| `POST /api/apps` name >32 字符 | 400 | 同上 |
| `POST /api/tokens {}` | 400 | `缺少 app_id` |
| `POST /api/tokens` 不存在 app | 404 | `App 不存在: app-nope` |
