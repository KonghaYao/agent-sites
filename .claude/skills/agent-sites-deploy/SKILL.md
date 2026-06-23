---
name: agent-sites-deploy
description: Agent Sites 平台建站部署。当需要在平台上创建 App、申请 token、配 PocketBase 后端 collection、上传前端文件并发布站点时使用。说"部署到平台"、"创建 app"、"建站"、"发布前端"、"配后端"时触发。
---

# agent-sites-deploy

在 Agent Sites 平台上建站。每个 App = 一个独立 PocketBase 后端 + 前端静态目录，通过 HTTP API 操作。

## 前置

```bash
export AGENT_SITES_URL=http://localhost:3000        # 平台地址
export AGENT_SITES_MASTER_KEY=...                    # 平台 master key
# 需要 curl + jq
```

> `$AGENT_SITES_MASTER_KEY` 必须等于**运行中平台**的 `AGENT_SITES_MASTER_KEY`（Read 项目 `.env` 取值，或向用户索取）。切勿自己 `openssl rand` 生成新的——那会和服务器不一致，第 1 步直接 401。

## Quick Start

按顺序五步。第 1、2 步产生的 `$APP_ID`、`$TOKEN` 供后续步骤复用。前三步调 API，文件读写一律用 Write/Read 工具，不要用 shell 的 `echo`/`cat`/`sed` 操作文件。

### 1. 创建 App

自动拉起独立 PocketBase 后端 + 写占位 index.html。

```bash
APP_ID=$(curl -s -X POST $AGENT_SITES_URL/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" -d '{"name":"my-app"}' \
  | jq -r '.data.id')
echo "APP_ID=$APP_ID"   # 形如 app-abcd1234
```

name 只允许 `[a-z0-9-]`、长度 1..32；中文/大写/空格/下划线会被 400 拒绝。name 也可省略，缺省时用 id 当 name。

### 2. 申请 platform token

仅展示一次，立即存起来；丢了只能重新申请、吊销旧的。同时存 `token`（调用用）和 `token_id`（吊销用）：

```bash
RESP=$(curl -s -X POST $AGENT_SITES_URL/api/tokens \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$APP_ID\"}")
TOKEN=$(echo "$RESP" | jq -r '.data.token')
TOKEN_ID=$(echo "$RESP" | jq -r '.data.token_id')
```

### 3. 配后端 collection

用 token 凭证代换为 superuser（绕过 rules）。**字段必须带 `"id"`**——省略 id 创建虽不报错，但会让 collection 多出名为 `id` 的多余 text 字段，污染 schema。rules 三态（PocketBase 0.23 语义，**与 0.22 完全相反**）：

- `""`（空串）= 允许匿名访问
- `null` = 拒绝（仅 superuser / token 绕过）
- 表达式（如 `"@request.auth.id != ''"`）= 条件放行

下例 `list/view/create` 设 `""`（公开读写）、`update/delete` 设 `null`（禁匿名改删）：

```bash
curl -s -X POST $AGENT_SITES_URL/$APP_ID/api/collections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"messages","type":"base",
    "fields":[
      {"id":"text1001","name":"author","type":"text","required":true,"min":1,"max":50,"system":false,"hidden":false,"presentable":false,"pattern":"","autogeneratePattern":""},
      {"id":"text1002","name":"body","type":"text","required":true,"min":1,"max":500,"system":false,"hidden":false,"presentable":false,"pattern":"","autogeneratePattern":""}
    ],
    "listRule":"","viewRule":"","createRule":"","updateRule":null,"deleteRule":null
  }' | jq '.name'   # → "messages"
```

> 极少数情况下，createApp 返回后立即建 collection 会返 `503 PB_UNAVAILABLE`（PB superuser 凭证仍在异步落盘）。等 1-2 秒重试同一请求即可，不要重建 app。

### 4. 写前端并上传

前端文件用 Write 工具创建（**不要用 shell 的 `echo`/`cat` 写文件**）。最小示例 `index.html`：

```html
<!doctype html>
<html><body><h1>It works</h1></body></html>
```

上传（用 `--data-binary`，不能用 `-F`；单文件 ≤ 1 MiB）：

```bash
curl -s -X PUT $AGENT_SITES_URL/api/apps/$APP_ID/files/index.html \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @index.html | jq '.data.path'
```

### 5. 访问验证

站点已上线，浏览器打开：

```
$AGENT_SITES_URL/$APP_ID/
```

### 6. 前后端联动示例（留言板）

第 3 步把 collection 的 `listRule`/`viewRule`/`createRule` 设成 `""` = **允许匿名访问**，所以业务前端不需要任何凭证，直接 fetch 就能读写后端。fetch shim 会把 `/api/...` 自动重写成 `/{app_id}/api/...`，前端代码里写绝对路径即可。

最小留言板 `index.html`（匿名读列表 + 表单提交新增 + 渲染）：

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>留言板</title></head>
<body>
  <h1>留言板</h1>
  <form id="f">
    <input name="author" placeholder="名字" required>
    <input name="body" placeholder="说点什么" required>
    <button>发送</button>
  </form>
  <ul id="list"></ul>
  <script>
    const API = '/api/collections/messages/records';
    async function load() {
      const { items } = await (await fetch(API)).json();
      list.innerHTML = items
        .map(m => `<li><b>${m.author}</b>: ${m.body}</li>`).join('');
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: fd.get('author'), body: fd.get('body') })
      });
      f.reset();
      load();
    };
    load();
  </script>
</body>
</html>
```

上传同第 4 步（`PUT /api/apps/$APP_ID/files/index.html`）。刷新 `/$APP_ID/` 即可提交留言、实时看到列表。

#### 前端能做哪些写操作：取决于 rules

业务前端是匿名身份，能力完全由 collection 的 rules 决定（第 3 步设定）：

| 操作 | 默认能否匿名 | 取决于 |
|------|--------------|--------|
| 读列表 / 读单条 | ✅ | `listRule` / `viewRule` = `""` |
| 新增 | ✅ | `createRule` = `""` |
| 修改 | ❌ | `updateRule` = `null`（禁用）|
| 删除 | ❌ | `deleteRule` = `null`（禁用）|

要让前端能**修改自己的数据**，把对应 rule 也设成 `""`（用 token 改 collection，下例放开 update）：

```bash
curl -s -X PATCH $AGENT_SITES_URL/$APP_ID/api/collections/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"updateRule":""}' | jq '.updateRule'
```

前端改数据（PATCH 指定 record id）：

```js
await fetch('/api/collections/messages/records/RECORD_ID', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body: '改过的内容' })
});
```

> ⚠️ rules 设 `""` = 任何人都能操作。生产环境要收紧：用表达式（如 `@request.auth.id != ""` 要求登录）或走 PocketBase user 认证。**永久有效的 platform token 不要放进前端代码**。

#### agent 用 token 直接操作数据（CRUD）

和前端无关——agent 拿第 2 步的 platform token 调 records 端点，就是这套后端的 superuser，**绕过所有 rules**（即使 `deleteRule:null` 也能删），增删改查全通：

```bash
BASE=$AGENT_SITES_URL/$APP_ID/api/collections/messages/records
AUTH="Authorization: Bearer $TOKEN"

# 查列表（PB 原生格式：.items 数组、.totalItems 总数）
curl -s -H "$AUTH" $BASE | jq '.items'

# 新增
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE \
  -d '{"author":"bot","body":"自动初始化数据"}'

# 修改（PATCH 指定 record id）
curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" $BASE/$RECORD_ID \
  -d '{"body":"改过的内容"}'

# 删除（返回 204，无 body）
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE -H "$AUTH" $BASE/$RECORD_ID
```

> 这些是 PB 代理响应（原生 envelope），取值用 `jq '.id'` / `jq '.items'`，不是平台壳的 `jq '.data.xxx'`。初始化数据、定时同步、清理脏数据都走这条路。

---

整站批量上传用 gzip tar（压缩前 ≤ 10 MiB / 解压 ≤ 50 MiB / 单文件 ≤ 5 MiB / ≤ 200 条目）：

```bash
tar czf site.tar.gz -C ./dist .
curl -s -X POST $AGENT_SITES_URL/api/apps/$APP_ID/files/bundle \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @site.tar.gz | jq '.data.total_files'
```

### 更新已上线的前端

PUT 同路径直接覆盖（幂等）——改完重新 PUT 即更新，无需额外操作。编辑一律用 Read/Edit/Write 工具，不要用 shell 的 `echo`/`cat`/`sed`。

- 本地有副本：Read 读取 → Edit 修改 → 重新 PUT 上传。
- 本地没有副本：先 GET 线上当前内容作参考 → 用 Write 落盘本地 → **删掉平台注入的 fetch shim**（`<script>(function(){var PREFIX=` 开头那段）→ Edit 改 → PUT 上传。

查看当前线上内容（只读参考，不要用 shell 重定向存盘）：

```bash
curl -s $AGENT_SITES_URL/$APP_ID/index.html
```

> ⚠️ GET 线上 HTML 返回的是**平台已注入 fetch shim 的版本**。整段存盘再 PUT 回去会让 shim 块逐次累积（HTML 膨胀）。从首次上传起就保留本地原始副本；只能从线上恢复时，先删掉 `<script>(function(){var PREFIX=` 那段再编辑。

改好后重新上传（同路径覆盖）：

```bash
curl -s -X PUT $AGENT_SITES_URL/api/apps/$APP_ID/files/index.html \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @index.html | jq '.data.path'
```

> 无单文件删除 API。要撤下某个文件只能用同路径 PUT 覆盖成空/占位；撤下整站则 DELETE 整个 App。

## 凭证：用哪个

| 要做什么                          | 用什么                                           |
| --------------------------------- | ------------------------------------------------ |
| 管理 App / token / 上传文件       | `X-Master-Key: $AGENT_SITES_MASTER_KEY`          |
| 创建/修改后端 collection、records | `Authorization: Bearer $TOKEN`（platform token） |
| 业务前端公开访问后端              | 不带凭证，交给 collection 的 rules               |

**吊销 token**（按 `token_id`，第 2 步存的）：

```bash
curl -s -X DELETE $AGENT_SITES_URL/api/tokens/$TOKEN_ID \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY"
```

丢了 `token_id` 可反查：`curl -s "$AGENT_SITES_URL/api/tokens?app_id=$APP_ID" -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" | jq '.data[].token_id'`。

## 实操要点

- **Platform token 只展示一次**。响应里 `.data.token` 要立即存起来；丢了只能重新申请、吊销旧的。
- **前端 fetch 自动重写**：浏览器 GET HTML 时平台会注入 shim，把 `fetch('/api/x')` 自动重写成 `fetch('/{app_id}/api/x')`。所以前端里绝对路径 `/api/...` 直接用。
- **fetch 以外的路径要手动改相对路径**：`<a href>`、`<img src>`、`<link href>`、`axios`、`XMLHttpRequest` 不被 shim 覆盖，写成相对路径（`./api/x` 或 `api/x`）。
- **后端公开访问靠 rules**：collection 创建时 `listRule`/`viewRule`/`createRule` 设为 `""` 表示允许匿名；设 `null` 表示禁用；设表达式表示条件。业务前端匿名访问就靠这个。
- **上传用 `--data-binary`**，不是 `-F`（multipart）。后缀白名单：html/htm/css/js/json/svg/png/jpg/jpeg/webp/ico/txt/map。
- **DELETE App 是真删**：停后端 + 删数据 + 删前端，不可恢复，且吊销该 App 所有 token。
- **响应取值**：平台路由（`/api/apps*`、`/api/tokens*`、文件上传）用 `jq '.data.xxx'`；后端代理（`/{app_id}/api/*`）是 PocketBase 原生格式，列表用 `jq '.items'`、总数 `.totalItems`。出错看 `.error.message` 或 `.message`。
