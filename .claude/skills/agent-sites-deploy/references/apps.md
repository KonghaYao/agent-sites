# App 管理（CRUD）

平台用「App」表示一个租户站点 = 一个 PocketBase 子进程 + 一份独立的数据目录 + 一份前端静态文件目录。所有 `/api/apps*` endpoint 强制 `X-Master-Key` 鉴权。

## 创建 App

```bash
curl -s -X POST $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "todo"}'
```

- Body 可省略整个 `name` 字段（缺省时 name=id，如 `"name":"app-xxxxx"`）。
- `name` 规则：trim 后允许 `a-z 0-9 -`，字符级长度 1..32；非法返 400 `name 只允许 a-z 0-9 -，长度 1..32`。
- `Content-Type: application/json` + 非法 JSON 返 400 `JSON 解析失败：...`；无 Content-Type 或空 body 按空对象处理。
- 已达 `MAX_APPS` 上限（默认 50）返 409 `App 数量已达上限 N`。

响应（**HTTP 200**，不是 201）：

```json
{
  "data": {
    "id": "app-abcd1234",
    "name": "todo",
    "port": 9001,
    "status": "running",
    "api_path": "/app-abcd1234/api",
    "created_at": "2026-06-20T10:00:00.000Z"
  },
  "error": null
}
```

**关键**：响应**不含任何凭证字段**。App 的 PocketBase superuser 凭证永久不出现在 HTTP 响应里——后续操作走 platform token（见 `tokens.md`）。

创建成功后会自动：
1. spawn 一个 PocketBase 子进程（端口 9000-11000 范围内分配）
2. 预置 superuser + 同步验证凭证可用（消除首次代理 503 竞态）
3. 写一个占位 `index.html` 到 `public/{id}/`，浏览器 GET `/{id}/` 拿到 200 提示页

## 列出所有 App

```bash
curl -s $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $MASTER_KEY"
```

响应：`{"data": [AppResponse, ...], "error": null}`。

## 查询单个 App

```bash
curl -s $AGENT_SITES_URL/api/apps/{app_id} \
  -H "X-Master-Key: $MASTER_KEY"
```

不存在返 404 `App 不存在: {app_id}`。

## 删除 App

```bash
curl -s -X DELETE $AGENT_SITES_URL/api/apps/{app_id} \
  -H "X-Master-Key: $MASTER_KEY"
```

删除时**联动行为**：
1. 停止 PocketBase 子进程
2. 标记 App 记录为已删除（store.remove）
3. **吊销该 App 的所有 platform token**（避免悬挂 token 仍可访问）
4. 删除数据目录 `data/{id}/`（含 SQLite 等所有 PB 数据）
5. 删除静态文件目录 `public/{id}/`

响应：`{"data": {"deleted": "{app_id}"}, "error": null}`。重复删除返 404。
