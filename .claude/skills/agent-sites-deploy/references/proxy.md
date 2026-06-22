# PocketBase API 代理（`/{app_id}/api/*`）

所有 `/{app_id}/api/{*path}` 请求（GET/POST/PUT/DELETE/PATCH）都由平台转发到该 App 内部的 PocketBase 子进程。三种鉴权场景：

| 请求头 | 平台行为 |
|--------|---------|
| 无 `Authorization` | 透传给 PB，由 PB Rules 处理（公开 collection 等） |
| `Authorization: Bearer <platform_token>` | 验证签名 + status + app_id 一致 → **凭证代换**为 PB superuser token 转发 |
| 其他（PB user token / 伪造 JWT） | 透传给 PB，由 PB 处理 |

## Platform Token 验证失败的情况

- token 与 app_id 不一致 → **403** `token 与 app_id 不匹配`（如用 app2 的 token 调 app1）
- token 不存在 → **401** `token 不存在`
- token 已吊销 → **401** `token 已吊销`
- token 签名错误 / 不是 platform token → 透传（不视为错误）

## 自愈机制

- App 的 PocketBase 进程意外退出：代理层自动调 `restartIfNeeded`，成功则转发，多次失败则标记 `status=error` 返 503。
- `status=error` 的 App 直接短路返 503 `App {id} 后端处于 Error 状态，需重新创建`。
- platform token 凭证代换后 PB 返 401（缓存 token 过期）：清缓存重试一次。

## PB 透传响应特征

**整个 response envelope 来自 PocketBase**，不进平台 `{data, error, request_id}` 壳：

```json
// PB 透传响应（注意 envelope 结构）
{
  "data": {...},
  "message": "...",
  "status": 200
}

// 平台路由响应（/api/apps* /api/tokens* /api/apps/{id}/files*）
{
  "data": {...},
  "error": null,
  "request_id": "abc12345"
}
```

**Agent 写错误处理时需要同时支持两种 envelope**：平台路由用 `error.code`，PB 透传用 `message + status`。

**status code 透传**：成功创建记录返 PB 原生 **200**（PocketBase 0.20+ 统一返 200，不再返 201）。不要盲信 HTTP 201 等教科书 status，按 PB 实际返回处理。

**字段大小写**：PB 透传响应字段保留原生 camelCase（如 `collectionId` / `collectionName`），平台层 snake_case 不影响代理响应字段。

## Admin UI 屏蔽

PocketBase 自带 Admin UI（路径 `/{app_id}/_/`），但**平台不透传**：

```bash
curl $AGENT_SITES_URL/app-abcd1234/_/
# 404 {"error":{"code":"NOT_FOUND","message":"Admin UI 不开放，请用 platform token + API"}}
```

Agent 只能通过 platform token + API 操作 collections（创建表、改 schema、看记录等），不能用 PB Admin UI。

## 常见 PB API 示例

```bash
# 创建 collection
curl -s -X POST $AGENT_SITES_URL/app-abcd1234/api/collections \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"todos","type":"base","schema":[{"name":"title","type":"text"}]}'

# CRUD records
curl -s -X POST $AGENT_SITES_URL/app-abcd1234/api/collections/todos/records \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"buy milk"}'

curl -s $AGENT_SITES_URL/app-abcd1234/api/collections/todos/records \
  -H "Authorization: Bearer $PLATFORM_TOKEN"

curl -s -X DELETE $AGENT_SITES_URL/app-abcd1234/api/collections/todos/records/{record_id} \
  -H "Authorization: Bearer $PLATFORM_TOKEN"
```

参考：PocketBase 0.20+ Client API 文档。
