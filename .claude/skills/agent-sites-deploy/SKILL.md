---
name: agent-sites-deploy
description: Agent 站点托管平台部署与运维。当 Agent 需要在 Agent Sites 平台上创建 App、申请 platform token、上传前端文件、通过 PocketBase 代理操作 collections 时使用。
---

# agent-sites-deploy

Agent Sites 平台交互 Skill。每个 App = 一个 PocketBase 子进程 + 独立数据目录 + 前端静态文件目录。通过 HTTP API 与平台交互。

## 前置条件

- 平台 URL（环境变量 `AGENT_SITES_URL`，默认 `http://localhost:3000`）
- Master key（环境变量 `AGENT_SITES_MASTER_KEY`，由平台运维生成；`openssl rand -hex 32`）
- 本机需安装 `curl`、`jq`

## 三层鉴权

| 场景 | 凭证 | Endpoint |
|------|------|---------|
| 平台管理（创建/删除 App、申请/吊销 token） | `X-Master-Key: $AGENT_SITES_MASTER_KEY` | `/api/apps*`、`/api/tokens*`、`/api/apps/{id}/files*` |
| App 操作（CRUD collections / records） | `Authorization: Bearer <platform_token>` | `/{app_id}/api/*` |
| 业务前端（公开页面 / 用户登录态） | 无 或 PB user token | `/{app_id}/api/*`（透传给 PocketBase Rules） |

## API 响应格式

**平台路由响应**（`/api/apps*`、`/api/tokens*`、`/api/apps/{id}/files*`）统一壳：

```json
// 成功
{"data": {...}, "error": null, "request_id": "abc12345"}

// 失败
{"data": null, "error": {"code": "ERROR_CODE", "message": "..."}, "request_id": "..."}
```

错误码：`NOT_FOUND` (404)、`FORBIDDEN` (403)、`UNAUTHORIZED` (401)、`CONFLICT` (409)、`BAD_REQUEST` (400)、`PAYLOAD_TOO_LARGE` (413)、`PB_UNAVAILABLE` (503)、`INTERNAL_ERROR` (500)。

> 注意：503 的 code 是 `PB_UNAVAILABLE`（不是 `SERVICE_UNAVAILABLE`），500 的 code 是 `INTERNAL_ERROR`（不是 `INTERNAL`）。直接 grep `error.ts` 的工厂方法可见全部 8 个 code 字面量。

**PocketBase 透传响应**（`/{app_id}/api/*`）保留 PB 原生 envelope `{data, message, status}`，**不进**平台壳。详见 `references/proxy.md`。

## 任务导向导航

按当前要做的事查阅对应 reference：

| 任务场景 | Reference |
|---------|-----------|
| 创建 / 列出 / 查询 / 删除 App（含 name 规则、占位 index.html、删除联动行为） | [`references/apps.md`](references/apps.md) |
| 申请 / 列出 / 吊销 platform token（永久有效、仅展示一次、`last_used_at` 永久 null） | [`references/tokens.md`](references/tokens.md) |
| 上传前端文件：单文件 PUT（≤ 1 MiB）/ 整目录 gzip tar bundle（≤ 10 MiB 压缩 / ≤ 50 MiB 解压 / ≤ 5 MiB 单文件 / ≤ 200 条目） | [`references/files.md`](references/files.md) |
| PocketBase 代理：`/{app_id}/api/*` 凭证代换、PB 原生 envelope、Admin UI 屏蔽、自愈机制 | [`references/proxy.md`](references/proxy.md) |
| 浏览器访问入口：`GET /{app_id}/{*path}` 静态文件 + 自动注入 fetch shim | [`references/access.md`](references/access.md) |
| Fetch shim 自动兜底：`fetch('/api/x')` 重写为 `/{app_id}/api/x`，注入位置、重写规则、限制 | [`references/shim.md`](references/shim.md) |
| ⚠️ 前端相对路径陷阱：`<a>` / `<img>` / `<link>` / `axios` / `XMLHttpRequest` 不被 shim 覆盖，需要手动处理 | [`references/frontend-paths.md`](references/frontend-paths.md) |
| 排障：401/403/404/413/503 错误消息对照、PB envelope 误解 | [`references/troubleshooting.md`](references/troubleshooting.md) |

## Quick Start（copy-paste 可跑）

前置：`AGENT_SITES_URL` 和 `AGENT_SITES_MASTER_KEY` 已 export，平台已 `deno task start`，`curl`/`jq` 已装。

```bash
# 1. 创建 App（自动 spawn PocketBase + 预置 superuser + 写占位 index.html）
APP_ID=$(curl -s -X POST $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" -d '{"name":"todo"}' \
  | jq -r '.data.id')
echo "APP_ID=$APP_ID"   # 形如 app-abcd1234

# 2. 申请 platform token（仅此一次返回 token 字符串，丢了要重新申请）
TOKEN=$(curl -s -X POST $AGENT_SITES_URL/api/tokens \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$APP_ID\"}" \
  | jq -r '.data.token')

# 3. 用 token 创建 PB collection
curl -s -X POST $AGENT_SITES_URL/$APP_ID/api/collections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"todos","type":"base","schema":[{"name":"title","type":"text"}]}' \
  | jq '.status, .name'   # → 200, "todos"（PB 原生 envelope，非平台壳）

# 4. 上传前端 HTML（≤ 1 MiB；用 --data-binary，不能用 -F multipart）
echo '<!doctype html><title>todo</title><h1>It works</h1>' > /tmp/index.html
curl -s -X PUT $AGENT_SITES_URL/api/apps/$APP_ID/files/index.html \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @/tmp/index.html | jq '.data.path, .data.bytes'

# 5. 浏览器 GET /{app_id}/ 验证（响应里应含 "It works" + 注入的 fetch shim）
curl -s $AGENT_SITES_URL/$APP_ID/ | grep -o 'It works\|window.fetch'
# → It works
# → window.fetch
```

5 步全绿 = 平台就绪，可以放手干真正的活。任一步报错查 [`references/troubleshooting.md`](references/troubleshooting.md)。


## 关键不变量（必读）

- **App 响应不含凭证**：`POST /api/apps` 返回的 `AppResponse` 没有 `superuser_email` / `superuser_password`。所有 App 内部操作走 platform token 凭证代换。
- **Platform token 永久有效**，无 expiry、无 refresh。吊销靠 `DELETE /api/tokens/{id}` 把 status 标记为 `revoked`（立即生效）。`last_used_at` 永久 null，仅 schema 占位。
- **DELETE App 是真删**：停进程 + 删数据目录 + 删静态目录 + 吊销该 App 所有 token。无宽限期，不可恢复。
- **Admin UI 不开放**：`/{app_id}/_/` 返 404，agent 只能通过 platform token + API 操作 collections。
- **HTML 响应自动注入 fetch shim**：HTML GET 响应在第一个 `<head>` 后注入 JS，monkey-patch `window.fetch`，把绝对路径 `/api/x` 重写为 `/{app_id}/api/x`。非 fetch 场景（`<a>` / `<img>` / `axios`）仍需手动改相对路径。
- **PB 透传响应保留原生 envelope**：`{data, message, status}`，status code 也透传（PB 0.20+ 创建返 200 不是 201）。错误处理要同时支持平台壳和 PB 原生壳。
