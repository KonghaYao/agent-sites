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
>
> **环境变量隔离**：spawn 时 `clearEnv: true` + 白名单只透传 `PATH` / `HOME` / `LANG` / `TZ` + 注入 `PORT`。父进程的环境变量（包括 `AGENT_SITES_MASTER_KEY`、`DATABASE_URL` 等敏感凭证）**不会泄漏**到自定义应用子进程——你的 main.ts 拿不到这些变量。需要外部配置请打包进包内或写进 `runtime/` 目录的配置文件。
>
> **stdout/stderr 丢弃**：`stdin` / `stdout` / `stderr` 都设为 `"null"`，`console.log` / `console.error` 输出**平台日志里看不到**。需要日志就写入 `runtime/` 目录的文件。详见第 8 节故障排查。

## 3. 创建 App

```bash
APP_ID=$(curl -s -X POST $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","type":"custom"}' \
  | jq -r '.data.id')
echo "APP_ID=$APP_ID"   # 形如 app-abcd1234
```

`type: "custom"` → 不创建 PocketBase，只分配目录。如需 PB，传 `"enable_pb": true`（详见第 9 节「启用 PocketBase 后端」）。返回示例：

```json
{
  "data": {
    "id": "app-8bf36970",
    "name": "my-app",
    "type": "custom",
    "status": "running",
    "port": 0,
    "api_path": "/app-8bf36970",
    "created_at": "2026-06-30T..."
  },
  "error": null
}
```

字段说明：

| 字段 | 含义 |
|------|------|
| `id` | app id（`app-xxxxxxxx`） |
| `name` | 展示名（缺省时等于 id） |
| `type` | `"custom"` |
| `status` | `"running"` 仅表示"未被停止"，**不代表代码已部署** |
| `port` | 内部分配端口。custom 类型**未部署前为 0**，部署后写入实际端口 |
| `api_path` | 应用根路径（custom 恒为 `/{id}`） |
| `created_at` | 创建时间（RFC3339） |

> **注意：响应没有 `updated_at` 字段**。Custom 类型的 app 在创建后、首次 deploy 之前 `port` 为 0、`status` 为 `running`——此时访问 `/{app_id}/` 会返回 503（找不到可用的 Deno 进程）。部署完成后请求才能正常响应。

如果返回 401，说明 `$AGENT_SITES_MASTER_KEY` 不正确——检查它是否等于平台 `.env` 里的值。

## 4. 部署

```bash
curl -s -X POST $AGENT_SITES_URL/api/apps/$APP_ID/deploy \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @app.tar.gz | jq '.'
```

> **仅 custom 类型可部署**：若 app 创建时 `type` 不是 `"custom"`（默认 pocketbase），deploy 返 400 `"App {id} 不是自定义类型，无法部署"`。PocketBase 类型 app 没有部署概念，前端文件走 `PUT /api/apps/{id}/files/*`。

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
- TCP 探活（轮询 `127.0.0.1:{port}`，**10 秒超时**，每 200ms 一次）
- 原子切换路由（store 更新 `active_slot` / `port` / `entry_file` 并 flush）
- 停旧进程

整个过程零 downtime——旧进程处理完存量请求才被杀。重新部署后留意响应里的 `slot` 和 `port` 会变化。

> **探活超时返 500**：新进程 10 秒内没 listen 端口 → 部署返 500 `INTERNAL_ERROR`，message 被 sanitize 为 `"服务器内部错误"`（原始错误 `"自定义应用健康检查失败 app_id=... port=..."` 仅平台日志可见），store 不切换（旧版本继续服务）。需修代码后重新部署。

## 7. 跨部署持久数据

应用生成的持久数据（如 SQLite 文件、上传文件）应写到**当前工作目录**（cwd），而非代码目录。`Deno.cwd()` 就是 `data/app-{id}/runtime/`，跨部署保留。

代码目录 `data/app-{id}/deploy-{a|b}/` 每次部署会被整体替换，不要往里面写运行时数据。

> **请求体上限 50 MiB**：代理层（`/{app_id}/*`）单次请求 body 上限 `DEFAULT_MAX_BODY_BYTES = 50 MiB`，超限返 413。大文件上传场景要在 main.ts 里自己分块，或绕过平台代理（如直连对象存储）。

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

原因：应用进程启动失败或 TCP 探活超时。**重要**：平台 spawn `deno run` 时把子进程的 `stdin` / `stdout` / `stderr` 全部设为 `"null"`——子进程的 `console.log` / `console.error` 输出**完全丢弃**，平台日志里看不到任何 `[custom:app-xxxx]` 前缀的 stderr。这意味着：

- 你**无法**通过平台日志直接看到 `deno run` 报的 TypeScript 错误或运行时异常
- 排查方式：在 main.ts 内部用 `try/catch` 把异常写进 `runtime/` 目录下的日志文件（cwd 可写，跨部署保留），例如：

  ```typescript
  try {
    Deno.serve({ hostname: "127.0.0.1", port }, handler);
  } catch (e) {
    await Deno.writeTextFile("./crash.log", `${new Date().toISOString()} ${e}\n`, { append: true });
    throw e;
  }
  ```

  诊断时通过 deploy 上传一个查日志的小工具，或暂时往响应里回写错误信息。

平台侧能观察到的信号只有两个：

1. **部署 POST 立即返 500** + `INTERNAL_ERROR`，message sanitize 为 `"服务器内部错误"`——平台日志里能看到原始错误 `"自定义应用健康检查失败 app_id=... port=..."` → deno 进程启动后 10 秒内 TCP 探活没通（端口没 listen），可能是 main.ts 同步代码抛错 / `Deno.serve` 没绑定 `127.0.0.1` / 绑定了别的端口
2. **部署 POST 返 200 但后续访问 503** → 进程跑起来过又崩了，或惰性重启再次失败（端口冲突 / OOM / 代码 bug）

常见原因：
- main.ts 里的 TypeScript 类型错误 → 修复代码重新部署
- 缺少 import 的文件 → 确认包内自包含所有依赖（平台不跑 `deno cache`，但 `deno run` 会自动拉远程依赖；本地相对路径 import 必须打包进去）
- `Deno.serve` 的端口和 `PORT` 环境变量不匹配 → 确认代码里用了 `Deno.env.get("PORT")` 且绑定了 `127.0.0.1`（不是 `0.0.0.0`，不是固定 `8080`）
- 启动时间超过 10 秒（如冷启动拉取远程依赖）→ 探活超时，需精简依赖或预打包

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

## 9. 启用 PocketBase 后端

创建 custom app 时传 `"enable_pb": true`，平台会额外 spawn 一个 PocketBase 实例，并通过环境变量注入连接信息。

### 9a. 创建

```bash
APP_ID=$(curl -s -X POST $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","type":"custom","enable_pb":true}' \
  | jq -r '.data.id')
echo "APP_ID=$APP_ID"
```

响应会多出两个字段：

```json
{
  "data": {
    "id": "app-8bf36970",
    "name": "my-app",
    "type": "custom",
    "status": "running",
    "port": 0,
    "api_path": "/app-8bf36970",
    "enable_pb": true,
    "pb_port": 9001,
    "created_at": "2026-06-30T..."
  },
  "error": null
}
```

| 字段 | 含义 |
|------|------|
| `enable_pb` | `true` 表示已启用 PB |
| `pb_port` | PB 实例端口（127.0.0.1） |

### 9b. 环境变量

部署时平台向 custom 进程注入三个额外环境变量：

| 变量 | 值 | 用途 |
|------|---|------|
| `PB_URL` | `http://127.0.0.1:{pb_port}` | PB SDK 连接地址 |
| `PB_SUPERUSER_EMAIL` | `admin@{id}.local` | superuser 邮箱 |
| `PB_SUPERUSER_PASSWORD` | `{uuid}` | superuser 密码 |

### 9c. main.ts 示例

```typescript
// main.ts —— 带 PB 后端的自定义应用
import PocketBase from "jsr:@pocketbase/pocketbase";

const port = parseInt(Deno.env.get("PORT") || "8080");
const pbUrl = Deno.env.get("PB_URL"); // 平台注入，仅 enable_pb 时存在

let pb: PocketBase | undefined;
if (pbUrl) {
  pb = new PocketBase(pbUrl);
  // 用 superuser 凭证认证（永久有效，不建议放进前端代码）
  await pb.collection("_superusers").authWithPassword(
    Deno.env.get("PB_SUPERUSER_EMAIL")!,
    Deno.env.get("PB_SUPERUSER_PASSWORD")!,
  );

  // 首次部署时初始化 collection（幂等）
  try {
    await pb.collections.create({
      name: "posts",
      type: "base",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "body", type: "text", required: true },
      ],
      listRule: "",    // 公开可读
      viewRule: "",
      createRule: "",  // 公开可写
      updateRule: null,
      deleteRule: null,
    });
  } catch (_) {
    // collection 已存在，跳过
  }
}

Deno.serve({ hostname: "127.0.0.1", port }, async (req) => {
  const url = new URL(req.url);

  // API：读 posts 列表
  if (url.pathname.endsWith("/api/posts") && req.method === "GET") {
    const records = await pb!.collection("posts").getFullList();
    return Response.json(records);
  }

  // API：创建 post
  if (url.pathname.endsWith("/api/posts") && req.method === "POST") {
    const body = await req.json();
    const record = await pb!.collection("posts").create(body);
    return Response.json(record);
  }

  // 前端 HTML
  return new Response(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Blog</title></head>
<body>
  <h1>Posts</h1>
  <form id="f">
    <input name="title" placeholder="Title" required>
    <input name="body" placeholder="Body" required>
    <button>Create</button>
  </form>
  <ul id="list"></ul>
  <script>
    async function load() {
      const items = await (await fetch("./api/posts")).json();
      list.innerHTML = items.map(p => \`<li><b>\${p.title}</b>: \${p.body}</li>\`).join('');
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      await fetch("./api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: fd.get("title"), body: fd.get("body") })
      });
      f.reset();
      load();
    };
    load();
  </script>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
```

**关键约定：**

- **PB SDK 是 `jsr:@pocketbase/pocketbase`**（Deno native import）
- **PB 只监听 127.0.0.1**，外部不可达。custom 进程以 superuser 身份直连
- **superuser 密码只在子进程环境变量中出现**，不出 HTTP 响应
- **前端 API 调用走 custom 进程中转**（不走 platform token）。前端 `fetch("./api/posts")` → custom 进程 → PB SDK
- **数据目录隔离**：PB 数据在 `data/{id}/pb_data/`，custom 运行时数据在 `data/{id}/runtime/`，代码在 `data/{id}/deploy-{a|b}/`
- **PB SDK 认证按需**：可以在进程启动时全局认证一次，也可以在每个请求里重新认证
- **re-deploy 不重建 PB**：重新部署只更新 custom Deno 代码 + 双槽位切换，PB 实例和数据保留不动

## 实操要点

- **路径用 endsWith 匹配**。代理透传完整 pathname（含 `/{app_id}` 前缀），`url.pathname === "/api/hello"` 会匹配不上，改用 `url.pathname.endsWith("/api/hello")`。
- **前端 fetch 用相对路径，无 shim**。自定义模式没有 fetch 注入，`fetch("./api/x")` 靠浏览器自动补全，`fetch("/api/x")` 会 404。见第 1 节内的重要提示。
- **PORT 是平台注入的，不要自己定**。代码里 `parseInt(Deno.env.get("PORT") || "8080")` 可以，但 fallback `8080` 仅在本地测试有效；部署时平台分配 9000-11000 范围的端口并通过 `PORT` 环境变量注入。
- **必须绑定 `127.0.0.1`**。`Deno.serve({ hostname: "127.0.0.1", port })`。绑 `0.0.0.0` 也能跑但平台探活走 `127.0.0.1`，绑别的 host 会探活失败。
- **没有 token / 没有 PB**。自定义模式没有 PocketBase、没有 superuser、没有 platform token 这回事。鉴权自己做（比如在 main.ts 里校验 header）。环境变量也只拿到 `PATH` / `HOME` / `LANG` / `TZ` / `PORT`——父进程敏感凭证（master key 等）不透传。
- **enable_pb=true 时**：平台创建 PB 实例并注入 `PB_URL` / `PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD` 环境变量，custom 进程可以用 `jsr:@pocketbase/pocketbase` SDK 直连。详见「启用 PocketBase 后端」章节。
- **stdout / stderr 被丢弃**。`console.log` / `console.error` 输出平台日志看不到。需要日志就写进 `runtime/` 目录的文件。
- **惰性重启 + 10 秒探活**。平台启动时不自动恢复你的进程；首次请求来了发现连不上才会 spawn，TCP 探活 10 秒超时（每 200ms 轮询一次）。如果启动后很久没人访问，app 其实没在跑——第一个访问者会多等最多 10 秒。探活失败返 503 `"App {id} 启动失败"`。
- **DELETE App 会全清**：停进程 + 删 `data/app-{id}/deploy-a`、`deploy-b`、`runtime` + 删 `public/app-{id}/`（custom 类型通常没前端文件） + 删记录 + 吊销该 app 的所有 token。不可恢复。
