# App 访问入口

App 创建后，浏览器或 curl 通过两种入口访问：静态文件服务（前端）和 PocketBase 代理（API）。

## 静态文件（前端）

```
GET http://localhost:3000/{app_id}/{*path}
```

直接返回 `public/{app_id}/` 下的静态文件。空 path 或尾部 `/` 默认走 `index.html`。

```bash
curl $AGENT_SITES_URL/app-abcd1234/                  # → public/app-abcd1234/index.html
curl $AGENT_SITES_URL/app-abcd1234/style.css
curl $AGENT_SITES_URL/app-abcd1234/sub/page.html
```

- HTML 响应自动注入 fetch shim（见 `shim.md`）。
- 路径穿越防护：`realPath` 后必须在 `public/{app_id}/` 下。
- Cache-Control: `public, max-age=60`。

## PocketBase API 代理

```
GET/POST/PUT/DELETE/PATCH http://localhost:3000/{app_id}/api/{*path}
```

所有请求转发到该 App 内部的 PocketBase 子进程。鉴权方式见 `proxy.md`。

```bash
curl $AGENT_SITES_URL/app-abcd1234/api/collections/todos/records \
  -H "Authorization: Bearer $PLATFORM_TOKEN"
```

## Admin UI 屏蔽

`/{app_id}/_/` 前缀请求**不透传** PocketBase Admin UI：

```bash
curl $AGENT_SITES_URL/app-abcd1234/_/
# 404 Admin UI 不开放，请用 platform token + API
```

详见 `proxy.md` 的 Admin UI 屏蔽章节。
