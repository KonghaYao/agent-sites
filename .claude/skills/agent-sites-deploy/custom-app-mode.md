# 自定义应用部署

上传自包含的 Deno 全栈应用。平台 spawn `deno run` 子进程并全量代理 HTTP 流量。应用自己 serve 前端 + 后端，不用 PocketBase。

**适用场景：** 全栈 Deno 应用（前后端在一起），或需要自定义路由、数据库的业务。

## 前置

### 1. 确认平台可达

```bash
curl -s $AGENT_SITES_URL/health
# → ok
```

返回 `ok` 说明平台在线，可以开始部署。如果连不上，联系平台管理员。

### 2. 设置环境变量

你会从平台管理员那里拿到两个值，先在 shell 中设置好：

```bash
export AGENT_SITES_URL=http://your-platform:3000   # 平台地址
export AGENT_SITES_MASTER_KEY=...                    # 平台 master key
```

> 后续所有命令都依赖这两个变量。如果不设置，`curl` 会发到空主机名。

### 3. 工具检查

```bash
which curl tar gzip jq   # 四个都必须有
```

---

## 1. 写 main.ts

必须用 `PORT` 环境变量绑定端口，监听 `127.0.0.1`：

```typescript
// main.ts
const port = parseInt(Deno.env.get("PORT") || "8080");

Deno.serve({ hostname: "127.0.0.1", port }, (req) => {
  const url = new URL(req.url);

  // 后端 API
  if (url.pathname.endsWith("/api/hello")) {
    return Response.json({ message: "hello" });
  }

  // 前端 HTML
  return new Response(`<!doctype html>
<html><body><h1>It works</h1></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

> **路径注意：** 代理会把完整路径 `/app-xxxx/api/hello` 传给你的应用，你可以拿 `url.pathname` 的**末尾匹配**（`endsWith`、正则）来找路由，不要用 `=== "/api/hello"` 严格相等。

前端 fetch 里直接用**相对路径**（`./api/hello` 或 `api/hello`），浏览器会基于当前页面 URL 解析为 `/{app_id}/api/hello`。

> **重要：fetch shim 只注入经典模式。** 经典模式中平台会在 HTML 里注入 `<script>` 把 `fetch('/api/x')` 自动重写为 `fetch('/{app_id}/api/x')`。自定义应用**没有 shim**——你的 fetch 不会被改写。如果写了绝对路径 `/api/x`，浏览器会请求 `http://localhost:3000/api/x`（缺少 `/{app_id}` 前缀），返回 404。**务必用相对路径。**

平台注入了 `X-Forwarded-Prefix: /{app_id}` header，如果你需要在后端拼绝对 URL，可以读取这个 header：
```typescript
const prefix = req.headers.get("x-forwarded-prefix") || "";
```

## 2. 打包

包内根目录必须有 `main.ts`（优先）或 `main.js`。所有代码和静态资源必须自包含——平台不做依赖安装。

```bash
# 把 main.ts 和其他文件放在一个目录里，然后：
tar czf app.tar.gz -C ./your-app-dir .
```

**限制：**

| 项目 | 上限 |
|------|------|
| 压缩后 | 20 MiB |
| 解压后 | 100 MiB |
| 单文件 | 10 MiB |
| 条目数 | 500 |

**允许的后缀：** `.html` `.htm` `.css` `.js` `.ts` `.mjs` `.mts` `.jsx` `.tsx` `.json` `.svg` `.png` `.jpg` `.jpeg` `.webp` `.ico` `.txt` `.map` `.wasm` `.sql` `.db` `.sqlite` `.sqlite3`

> 启动命令等效 `deno run --allow-net --allow-env=PORT --allow-read=<codeDir> --allow-read=<runtimeDir> --allow-write=<runtimeDir> main.ts`。

## 3. 创建 App

```bash
APP_ID=$(curl -s -X POST $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","type":"custom"}' \
  | jq -r '.data.id')
echo "APP_ID=$APP_ID"   # 形如 app-abcd1234
```

`type: "custom"` → 不创建 PocketBase，只分配目录。返回示例：

```json
{
  "data": {
    "id": "app-8bf36970",
    "name": "my-app",
    "type": "custom",
    "status": "running",
    "port": 0,
    "created_at": "2026-06-30T...",
    "updated_at": "2026-06-30T..."
  },
  "error": null
}
```

> Custom 类型的 app `port` 为 0、`status` 为 `running`。status 是 `running` 只表示"这个 app 没有被停止"——**此时还没有部署代码**，在此状态下访问 `/{app_id}/` 会返回 503（找不到可用的 Deno 进程）。部署完成后请求才能正常响应。

如果返回 401，说明 `$AGENT_SITES_MASTER_KEY` 不正确——检查它是否等于平台 `.env` 里的值。

## 4. 部署

```bash
curl -s -X POST $AGENT_SITES_URL/api/apps/$APP_ID/deploy \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @app.tar.gz | jq '.'
```

响应示例（成功）：

```json
{
  "data": {
    "files": 1,
    "total_bytes": 1738,
    "entry_file": "main.ts",
    "slot": "a",
    "port": 9003
  },
  "error": null
}
```

字段说明：

| 字段 | 含义 |
|------|------|
| `files` | 解压出来的文件数 |
| `total_bytes` | 解压后总字节数 |
| `entry_file` | 检测到的入口文件（优先 `main.ts`，其次 `main.js`） |
| `slot` | 当前激活的槽位（`a` 或 `b`，首次部署为 `a`） |
| `port` | 应用进程的内部端口（在 9000-11000 范围内，**不需要**你自己指定——平台自动分配并注入 `PORT` 环境变量） |

> `Content-Type` 不是必须的——平台通过 gzip magic bytes (`1f 8b`) 自动识别，即使忘了设也能正常解压。

## 5. 验证

```bash
# 前端
curl -s $AGENT_SITES_URL/$APP_ID/

# 后端 API
curl -s $AGENT_SITES_URL/$APP_ID/api/hello
```

## 6. 更新（双槽位热切换）

改完代码 → 重新打包 → 再次 `POST /api/apps/$APP_ID/deploy`。平台自动：

- 解压到另一个槽位（a↔b）
- 新端口 spawn 新进程
- TCP 探活
- 原子切换路由
- 停旧进程

整个过程零 downtime——旧进程处理完存量请求才被杀。重新部署后留意响应里的 `slot` 和 `port` 会变化。

## 7. 跨部署持久数据

应用生成的持久数据（如 SQLite 文件、上传文件）应写到**当前工作目录**（cwd），而非代码目录。`Deno.cwd()` 就是 `data/app-{id}/runtime/`，跨部署保留。

代码目录 `data/app-{id}/deploy-{a|b}/` 每次部署会被整体替换，不要往里面写运行时数据。

## 8. 故障排查

### 创建 App 返回 401

```bash
# 检查变量是否已设置
echo $AGENT_SITES_MASTER_KEY
```

大概率是 `AGENT_SITES_MASTER_KEY` 没 export 或者和平台 `.env` 里的值不一致。用 `curl $AGENT_SITES_URL/health` 先确认平台在运行（返回 `ok`）。

### 部署返回 "入口文件未找到"

gzip 包内根目录必须有 `main.ts`（优先）或 `main.js`。检查一下打包方式：

```bash
# ❌ 错误：把目录本身也打包进去了
tar czf app.tar.gz ./my-app
# 解压后的结构是 my-app/main.ts，而不是 main.ts

# ✅ 正确：用 -C 切换到目录内部再打包
tar czf app.tar.gz -C ./my-app .
# 解压后的结构是 main.ts（无额外顶层目录）
```

### 部署后访问返回 503

部署成功但 curl 返回 503：

```
过程：部署 POST 返回 200 → 但 GET /{app_id}/ 返回 503
```

原因：应用进程启动失败（虽然解压/入口检测成功，但 `deno run` 报错了）。检查方法：联系平台管理员查看服务端日志，找 `[custom:app-xxxx]` 前缀的 stderr 输出。

常见原因：
- main.ts 里的 TypeScript 类型错误 → 修复代码重新部署
- 缺少 import 的文件 → 确认包内自包含所有依赖
- `Deno.serve` 的端口和 `PORT` 环境变量不匹配 → 确认代码里用了 `Deno.env.get("PORT")`

### 前端 fetch 返回 404

浏览器页面正常显示，但 API 调用返回 404。基本确定是 fetch 路径写法问题：

```js
// ❌ 错误：绝对路径 → 浏览器请求 http://host/api/counter → 缺少 app id 前缀
fetch("/api/counter")

// ✅ 正确：相对路径 → 浏览器基于当前 URL 补全为 /app-xxx/api/counter
fetch("./api/counter")
// 或
fetch("api/counter")
```

### jq: command not found

```bash
apt install jq -y
```

## 实操要点

- **路径用 endsWith 匹配**。代理透传完整 pathname（含 `/{app_id}` 前缀），`url.pathname === "/api/hello"` 会匹配不上，改用 `url.pathname.endsWith("/api/hello")`。
- **前端 fetch 用相对路径，无 shim**。自定义模式没有 fetch 注入，`fetch("./api/x")` 靠浏览器自动补全，`fetch("/api/x")` 会 404。见第 1 节内的重要提示。
- **PORT 是平台注入的，不要自己定**。代码里 `parseInt(Deno.env.get("PORT") || "8080")` 可以，但 fallback `8080` 仅在本地测试有效；部署时平台分配 9000-11000 范围的端口并通过 `PORT` 环境变量注入。
- **没有 token**。自定义模式没有 PB、没有 superuser、没有 platform token 这回事。鉴权自己做（比如在 main.ts 里校验 header）。
- **惰性重启**。平台启动时不自动恢复你的进程。首次请求来了发现连不上才会 spawn。如果启动后很久没人访问，app 其实没在跑——第一个访问者会多等 2-3 秒。
- **DELETE App 会全清**：停进程 + 删 deploy-a/deploy-b/runtime + 删记录。不可恢复。
