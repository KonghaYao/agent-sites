# Platform Token（App 操作凭证）

Platform token 是 agent 访问 `/{app_id}/api/*`（PocketBase 代理）时使用的凭证。所有 `/api/tokens*` endpoint 强制 `X-Master-Key` 鉴权。

## 申请 Token

```bash
curl -s -X POST $AGENT_SITES_URL/api/tokens \
  -H "X-Master-Key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"app_id": "app-abcd1234"}'
```

- `app_id` 必填，缺失返 400 `缺少 app_id`。
- App 不存在返 404 `App 不存在: {app_id}`。

响应（**HTTP 200**）：

```json
{
  "data": {
    "token_id": "tok_xxxxxxxx",
    "app_id": "app-abcd1234",
    "token": "eyJhbGciOiJIUzI1NiIsInR5c...",
    "status": "active",
    "issued_at": "2026-06-20T10:00:00.000Z",
    "warning": "此 token 仅展示一次，请立即持久化；丢失需吊销重新申请"
  },
  "error": null
}
```

**关键不变量**：
- **Token 仅此一次返回**。GET endpoint 不会再次返回 token 字符串，丢失只能吊销重新申请。
- **Token 永久有效**，无 expiry、无 refresh。吊销靠 DELETE 把 `status` 改为 `revoked`（状态查表，立即生效）。
- **`last_used_at` 永久 null**——schema 占位字段，平台不维护使用时间。

## 列出 Token

```bash
curl -s $AGENT_SITES_URL/api/tokens \
  -H "X-Master-Key: $MASTER_KEY"

# 可选 ?app_id= 过滤某 App 的 token
curl -s "$AGENT_SITES_URL/api/tokens?app_id=app-abcd1234" \
  -H "X-Master-Key: $MASTER_KEY"
```

响应（不含 token 字符串）：

```json
{
  "data": [
    {
      "token_id": "tok_xxxxxxxx",
      "app_id": "app-abcd1234",
      "status": "active",
      "issued_at": "...",
      "revoked_at": null,
      "last_used_at": null
    }
  ],
  "error": null
}
```

## 查询单个 Token

```bash
curl -s $AGENT_SITES_URL/api/tokens/{token_id} \
  -H "X-Master-Key: $MASTER_KEY"
```

不存在返 404 `Token 不存在: {token_id}`。

## 吊销 Token

```bash
curl -s -X DELETE $AGENT_SITES_URL/api/tokens/{token_id} \
  -H "X-Master-Key: $MASTER_KEY"
```

响应：`{"data": {"revoked": "{token_id}"}, "error": null}`。重复吊销返 404。

吊销后立即生效：再用该 token 调代理返 401 `token 已吊销`。

## Token 用法

```bash
# 调 PocketBase API（创建 collection、CRUD records 等）
curl -s -X POST $AGENT_SITES_URL/app-abcd1234/api/collections \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5c..." \
  -H "Content-Type: application/json" \
  -d '{"name":"todos","schema":[...]}'
```

平台会验证 token 签名 + 状态 + `app_id` 一致性，通过后**凭证代换**为 PocketBase superuser token 转发到内部 PB 进程。详见 `proxy.md`。
