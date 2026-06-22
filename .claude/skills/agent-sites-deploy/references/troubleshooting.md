# 常见问题

## 401 `缺少或错误的 X-Master-Key`

调 `/api/apps*` 或 `/api/tokens*` 时没传或传错 `X-Master-Key` header。值必须是 `AGENT_SITES_MASTER_KEY` 环境变量。

```bash
echo $AGENT_SITES_MASTER_KEY    # 检查变量
curl -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" ...
```

## 401 `token 已吊销` / `token 不存在`

Platform token 已被 DELETE `/api/tokens/{id}` 吊销，或 token_id 拼写错误。重新申请 token：`POST /api/tokens {app_id}`。

## 403 `token 与 app_id 不匹配`

用了 App A 的 platform token 调 App B 的代理。每个 token 绑定单一 app_id，跨 App 调用必须为每个 App 申请独立 token。

## 404 `App 不存在: {app_id}`

1. App 已被 DELETE（DELETE 是真删，会停进程 + 删数据 + 删静态目录 + 吊销所有 token）。
2. `app_id` 拼写错误。App id 形如 `app-abcd1234`（`app-` 前缀 + 8 位 hex）。

## 404 `Admin UI 不开放`

请求了 `/{app_id}/_/` 前缀（PocketBase Admin UI）。平台不透传 Admin UI，agent 只能通过 platform token + API 操作 collections。

## 404 `路由不存在: PUT /api/apps/{id}/files/evil.txt`

URL 里含 `..` 段（如 `files/../evil.txt`）被浏览器/curl/fetch 自动折叠成 `evil.txt`（WHATWG URL 规范），命中不了 PUT 路由模式 `/api/apps/{id}/files/{*path}`。**这不是 bug**——`..` 永远到不了 handler，路径穿越无法发生。需要显式 `..` 拒绝用 bundle API（tar 解包时返 400）。

## 400 `JSON 解析失败：...`（POST /api/apps）

`Content-Type: application/json` 但 body 不是合法 JSON。检查 JSON 语法（逗号、引号、字段名 typo）。无 Content-Type 或空 body 按空对象处理（不会报错）。

## 400 `name 只允许 a-z 0-9 -，长度 1..32`

App name 校验失败。规则：trim 后允许 `a-z 0-9 -`，字符级长度 1..32。中文字符、大写字母、下划线、空格都不允许。整个 `name` 字段可省略（缺省 name=id）。

## 400 `文件后缀 .xxx 不在允许列表`

单文件 PUT 或 bundle 上传时，文件后缀不在白名单。允许的后缀：`.html .htm .css .js .json .svg .png .jpg .jpeg .webp .ico .txt .map`。

## 413 上传超限

| 场景 | 上限 | 错误消息 |
|------|------|---------|
| 单文件 PUT body | 1 MiB | `上传 body N 字节超过上限 1048576 字节` |
| Bundle 压缩前 | 10 MiB | `压缩 body N 字节超过上限 10485760 字节` |
| Bundle 解压后总字节 | 50 MiB | `解压后总字节超过上限 52428800 字节（已写入 N 个文件）` |
| Bundle 单文件 | 5 MiB | `单文件 {path} 解压后超过上限 5242880 字节` |

## 400 `tar 条目数超过上限 200`

Bundle 包含超过 200 个条目。精简前端产物或拆分多次上传。

## 409 `App 数量已达上限 N`

已创建 App 数量达到 `MAX_APPS`（默认 50）。删除不再使用的 App 释放额度。

## 503 `App {id} 后端处于 Error 状态`

PocketBase 子进程多次自愈失败，已被标记为 `status=error`。DELETE 该 App 重新创建。

## 前端 `fetch('/api/x')` 返回了 agent-sites 自己的 API 或 404

浏览器把绝对路径解析到平台根。fetch 场景平台会自动注入 shim 兜底（HTML GET 响应 monkey-patch `window.fetch`）；非 fetch 场景（`<img>` / `<a>` / `axios` / `XMLHttpRequest`）需要手动改相对路径。详见 `frontend-paths.md` 和 `shim.md`。

## PB 透传响应字段在 agent 端取不到（如 `resp.error.code`）

PocketBase 透传响应用 **PB 原生 envelope** `{data, message, status}`，**不进**平台 `{data, error, request_id}` 壳。错误处理要同时支持两种结构。详见 `proxy.md`。
