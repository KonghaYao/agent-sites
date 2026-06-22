---
name: agent-sites-deploy
description: Agent Sites 平台建站部署。当需要在平台上创建 App、申请 token、配 PocketBase 后端 collection、上传前端文件并发布站点时使用。说"部署到平台"、"创建 app"、"建站"、"发布前端"、"配后端"时触发。
---

# agent-sites-deploy

在 Agent Sites 平台上建站。每个 App = 一个独立 PocketBase 后端 + 前端静态目录，通过 HTTP API 操作。

## 前置

```bash
export AGENT_SITES_URL=http://localhost:3000        # 平台地址
export AGENT_SITES_MASTER_KEY=<openssl rand -hex 32> # 平台 master key
# 需要 curl + jq
```

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

### 2. 申请 platform token

仅展示一次，立即存起来；丢了只能重新申请、吊销旧的。

```bash
TOKEN=$(curl -s -X POST $AGENT_SITES_URL/api/tokens \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$APP_ID\"}" | jq -r '.data.token')
```

### 3. 配后端 collection

用 token 凭证代换为 superuser。字段必须带 `"id"`；rules 设 `""` 允许匿名访问（公开读写）。

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
- 本地没有副本：先 GET 线上当前内容作参考 → 用 Write 落盘本地 → Edit 改 → PUT 上传。

查看当前线上内容（只读参考，不要用 shell 重定向存盘）：

```bash
curl -s $AGENT_SITES_URL/$APP_ID/index.html
```

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

## 实操要点

- **Platform token 只展示一次**。响应里 `.data.token` 要立即存起来；丢了只能重新申请、吊销旧的。
- **前端 fetch 自动重写**：浏览器 GET HTML 时平台会注入 shim，把 `fetch('/api/x')` 自动重写成 `fetch('/{app_id}/api/x')`。所以前端里绝对路径 `/api/...` 直接用。
- **fetch 以外的路径要手动改相对路径**：`<a href>`、`<img src>`、`<link href>`、`axios`、`XMLHttpRequest` 不被 shim 覆盖，写成相对路径（`./api/x` 或 `api/x`）。
- **后端公开访问靠 rules**：collection 创建时 `listRule`/`viewRule`/`createRule` 设为 `""` 表示允许匿名；设 `null` 表示禁用；设表达式表示条件。业务前端匿名访问就靠这个。
- **上传用 `--data-binary`**，不是 `-F`（multipart）。后缀白名单：html/htm/css/js/json/svg/png/jpg/jpeg/webp/ico/txt/map。
- **DELETE App 是真删**：停后端 + 删数据 + 删前端，不可恢复，且吊销该 App 所有 token。
- **响应取值**：平台路由（`/api/apps*`、`/api/tokens*`、文件上传）用 `jq '.data.xxx'`；后端代理（`/{app_id}/api/*`）是 PocketBase 原生格式，列表用 `jq '.items'`、总数 `.totalItems`。出错看 `.error.message` 或 `.message`。
