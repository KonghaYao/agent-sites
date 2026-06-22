> ⚠️ **已归档**（过渡期文档，2026-06-19）
>
> 本文档是 **Rust 网关 + PocketBase** 阶段的设计/实现记录，已被 **Deno + PocketBase** 实现替代。
> 当前权威参考：
> - 架构：`docs/architecture.md`
> - 控制面板：`public/_panel/index.html`（brutalist technical 风格，2026-06-20 重写）
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 控制面板 + Demo 留言板设计

> 2026-06-19
> 分支：`feat/pocketbase-pivot`（延续）
> 目标：让 agent-sites 平台「能用起来」——一个网页能看到所有 App 列表并点进去用，外加一个完整的留言板 demo 让用户直观感受「前端调 PocketBase」流程。

## 1. 背景

当前 agent-sites 只有后端 API + PocketBase 代理：

- 根路径 `/` 只返回纯文本 `"agent-sites — Vibe App 平台"`（`lib.rs:31`）
- `public/` 目录是空的
- App 创建 / 删除只能通过 `curl /api/apps` 操作
- 没有任何 Web UI 让用户「看 App 列表 + 点进去」

用户原话：「我的控制面板页面没了吗？你应该创建一个 demo 应用，包含前后端，然后注册到系统上，我在控制面板页面能列举并进入使用。」

## 2. 目标与非目标

### 目标

1. **控制面板页面**：根路径 `/` 返回一个静态 HTML 页面，列出所有 App，每个 App 一张卡片，点「打开」跳转到 `/{app_id}/`
2. **demo 留言板应用**：完整的前端 + PocketBase 后端，用户能直接体验「提交留言 → 看到列表」
3. **一键上线脚本**：`scripts/install-demo.sh`，幂等可重复执行，把 demo 应用注册到系统

### 非目标

- 控制面板不提供创建 / 删除 App 的 UI（架构文档定位：App 由 agent 创建，人类只读列举）
- 不做控制面板鉴权（localhost 自用，且 `/api/apps` 本来就公开）
- 不做 `/api/apps` 凭证脱敏（pre-existing 风险，标记为后续 plan）
- 不引入前端构建工具链（架构文档 §2「bundleless ESM」定位）
- 不做留言板用户登录、avatar、回复、点赞（YAGNI）
- 不做控制面板搜索 / 排序 / 分页（YAGNI）

## 3. 方案概览

| 决策 | 选择 | 理由 |
|------|------|------|
| 控制面板实现方式 | 静态 HTML + 原生 JS | 符合 architecture.md §2「bundleless ESM」定位；与 demo 应用同模式 |
| 控制面板路由 | 根路径 `/` 返回 `public/_panel/index.html` | 用户最自然的入口；fallback 到原纯文本 |
| demo 应用类型 | 留言板（Guestbook） | 最小完整闭环：1 个 collection + 表单 + 列表 |
| demo 上线方式 | `scripts/install-demo.sh`（shell + curl） | 显式动作、不污染服务启动流程、不依赖 Rust CLI 子命令 |
| demo 前端如何拿 app_id | `window.location.pathname.split('/')[1]` | 无需构建时注入，所有 demo 用同一份模板 |

## 4. 详细设计

### 4.1 控制面板路由（`crates/server/src/lib.rs`）

**当前**（lib.rs:31）：

```rust
.route("/", get(|| async { "agent-sites — Vibe App 平台" }))
```

**改为**：

```rust
.route("/", get(serve_panel))
```

新增 handler：

```rust
use axum::response::Html;

async fn serve_panel(State(state): State<Arc<AppState>>)
    -> Result<Html<String>, error::AppError>
{
    let panel_path = state.public_dir.join("_panel").join("index.html");
    match tokio::fs::read_to_string(&panel_path).await {
        Ok(html) => Ok(Html(html)),
        Err(_) => {
            // fallback：不视为错误（404 也不合适，因为 / 路由本身存在）
            tracing::warn!(path = %panel_path.display(), "控制面板 HTML 未安装，fallback 到纯文本");
            Ok(Html(
                "<!doctype html><meta charset=\"utf-8\"><title>agent-sites</title>\
                 agent-sites — 控制面板 HTML 未安装".to_string()
            ))
        }
    }
}
```

**注意**：用 `axum::response::Html` 包装，content-type 自动设为 `text/html; charset=utf-8`，无需手动构造 `Response`。fallback 路径返回 200 + HTML 提示文字，不返回 404（根路径本身存在，只是 HTML 没装）。

### 4.2 控制面板文件（`public/_panel/index.html`）

单文件，原生 HTML + 内联 CSS + 内联 JS（不引入外部资源，bundleless）。

**结构**：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>agent-sites · 控制面板</title>
  <style>
    /* 系统字体、暗色自适应、响应式网格 */
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    .card { border: 1px solid #ccc; padding: 1rem; border-radius: 8px; }
    .card h3 { margin: 0 0 0.5rem; }
    .meta { color: #666; font-size: 0.85rem; margin: 0.25rem 0; }
    .open { display: inline-block; margin-top: 0.5rem; }
    .status-running { color: green; }
    .status-other { color: orange; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #eee; }
      .card { border-color: #444; }
      .meta { color: #999; }
    }
  </style>
</head>
<body>
  <h1>agent-sites</h1>
  <p>App 列表 <button onclick="load()">刷新</button></p>
  <div id="apps" class="grid"></div>
  <script>
    async function load() {
      const el = document.getElementById('apps');
      try {
        const r = await fetch('/api/apps');
        const j = await r.json();
        const apps = j.data || [];
        if (apps.length === 0) {
          el.innerHTML = '<p>还没有 App。运行 <code>scripts/install-demo.sh</code> 创建一个 demo 应用。</p>';
          return;
        }
        // 按 created_at 降序
        apps.sort((a, b) => b.created_at.localeCompare(a.created_at));
        el.innerHTML = apps.map(a => `
          <div class="card">
            <h3>${escapeHtml(a.name)}</h3>
            <div class="meta">${escapeHtml(a.id)}</div>
            <div class="meta">${formatTime(a.created_at)}</div>
            <div class="meta status-${a.status === 'running' ? 'running' : 'other'}">● ${escapeHtml(a.status)}</div>
            <a class="open" href="/${encodeURIComponent(a.id)}/">打开 →</a>
          </div>
        `).join('');
      } catch (e) {
        el.innerHTML = '<p>加载失败：' + escapeHtml(String(e)) + '</p>';
      }
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function formatTime(iso) {
      // ISO 8601 → YYYY-MM-DD HH:MM（本地时区）
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.getFullYear() + '-' +
             String(d.getMonth()+1).padStart(2,'0') + '-' +
             String(d.getDate()).padStart(2,'0') + ' ' +
             String(d.getHours()).padStart(2,'0') + ':' +
             String(d.getMinutes()).padStart(2,'0');
    }
    load();
  </script>
</body>
</html>
```

**关键约束**：

- **不渲染 `superuser_email` / `superuser_password`**：白名单字段（id / name / status / created_at）。虽然 `fetch('/api/apps')` 返回的 JSON 含凭证（pre-existing 风险），但前端 DOM 不暴露
- **HTML 转义**：所有从 API 拿到的字段进 DOM 前必须 `escapeHtml`，防 XSS
- **降序排列**：新建的 App 排前面（直觉性）

### 4.3 控制面板路由冲突检查

`/{app_id}/{*path}` 路由（lib.rs:45）会捕获 `/anything/...`。但根路径 `/` 是更具体的路由，不会被覆盖。

`_panel` 不以 `app-` 开头，所以即使访问 `/_panel/index.html`，`validate_app_id` 也会返回 false，落到 404。控制面板只能通过根路径 `/` 访问。

### 4.4 demo 留言板前端（`demo/guestbook/index.html`）

**位置**：仓库内 `demo/guestbook/index.html`（**不在** `public/`，避免被当 App 自动加载）。`install-demo.sh` 时 `cp` 到 `public/{app_id}/`。

**结构**：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>留言板 / Guestbook</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    form { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 2rem; }
    textarea { min-height: 4rem; }
    button { align-self: flex-end; }
    .post { border-bottom: 1px solid #eee; padding: 1rem 0; }
    .post .meta { color: #666; font-size: 0.85rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #eee; }
      .post { border-color: #333; }
      .post .meta { color: #999; }
    }
  </style>
</head>
<body>
  <h1>留言板 / Guestbook</h1>
  <p><a href="/">← 返回控制面板</a></p>

  <form id="form">
    <input name="name" placeholder="你的名字（最多 50 字）" maxlength="50" required>
    <textarea name="content" placeholder="留言（最多 500 字）" maxlength="500" required></textarea>
    <button type="submit">提交</button>
  </form>

  <h2>留言列表</h2>
  <div id="list"></div>

  <script>
    const APP_ID = window.location.pathname.split('/')[1];

    async function loadList() {
      const el = document.getElementById('list');
      try {
        const r = await fetch(`/${APP_ID}/api/collections/posts/records?sort=-created`);
        const j = await r.json();
        const items = j.items || [];
        if (items.length === 0) {
          el.innerHTML = '<p>还没有留言，做第一个吧。</p>';
          return;
        }
        el.innerHTML = items.map(p => `
          <div class="post">
            <div class="meta">${escapeHtml(p.name)} · ${formatTime(p.created)}</div>
            <div>${escapeHtml(p.content)}</div>
          </div>
        `).join('');
      } catch (e) {
        el.innerHTML = '<p>加载失败：' + escapeHtml(String(e)) + '</p>';
      }
    }

    document.getElementById('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const body = { name: fd.get('name'), content: fd.get('content') };
      const r = await fetch(`/${APP_ID}/api/collections/posts/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        ev.target.reset();
        loadList();
      } else {
        const err = await r.text();
        alert('提交失败：' + err);
      }
    });

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function formatTime(iso) {
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.getFullYear() + '-' +
             String(d.getMonth()+1).padStart(2,'0') + '-' +
             String(d.getDate()).padStart(2,'0') + ' ' +
             String(d.getHours()).padStart(2,'0') + ':' +
             String(d.getMinutes()).padStart(2,'0');
    }

    loadList();
  </script>
</body>
</html>
```

**关键点**：

- `const APP_ID = window.location.pathname.split('/')[1]`：从 URL 拿 app_id，无需构建时注入
- `?sort=-created`：PocketBase 查询语法，按 created 降序
- 表单 POST → `/{APP_ID}/api/collections/posts/records`（PocketBase 标准 records API）
- HTML 转义防 XSS

### 4.5 demo 留言板 PocketBase schema

**collection**：`posts`

**字段**：

| 字段 | 类型 | 约束 |
|------|------|------|
| `name` | text | required, min 1, max 50 |
| `content` | text | required, min 1, max 500 |
| `created` | autodate | PocketBase 内置（创建时间） |
| `updated` | autodate | PocketBase 内置 |
| `id` | text | PocketBase 内置（15 字符） |

**访问规则**（rule 是 PocketBase 的访问控制）：

| 操作 | rule | 语义 |
|------|------|------|
| `listRule` | `""` | 公开（任何人可列表） |
| `viewRule` | `""` | 公开 |
| `createRule` | `""` | 公开（任何人可提交留言） |
| `updateRule` | `null` | 禁用 |
| `deleteRule` | `null` | 禁用 |

> PocketBase 0.23 rule 语义（与 0.22 相反！）：`""` = 公开（包括匿名），`null` = 永远拒绝，`"some_condition"` = 满足条件允许。

### 4.6 `scripts/install-demo.sh`

**位置**：`scripts/install-demo.sh`（仓库根新建 `scripts/` 目录）

**依赖**：`curl`、`python3`、`bash` 4+

**幂等设计**：可重复执行。

**完整脚本**：

```bash
#!/usr/bin/env bash
# 把 demo 留言板应用注册到 agent-sites 系统。
# 幂等：可重复执行，已存在则复用 + 重做 cp 和 collection 初始化。

set -euo pipefail

SERVER="${AGENT_SITES_URL:-http://localhost:3000}"
DEMO_SOURCE="$(cd "$(dirname "$0")/.." && pwd)/demo/guestbook"
PUBLIC_DIR="$(cd "$(dirname "$0")/.." && pwd)/public"

# 颜色输出
say()  { printf '\033[32m[install-demo]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[install-demo] 错误:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# 1. 检查服务在跑
say "检查服务健康..."
curl -sf "$SERVER/health" > /dev/null || die "服务未启动（$SERVER）。先 cargo run。"

# 2. 找已存在的 demo App
say "查找已存在的 demo App..."
EXISTING=$(curl -sf "$SERVER/api/apps" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
demos = [a for a in data if a.get('name') == 'demo']
print(demos[0]['id'] if demos else '')
")

if [ -n "$EXISTING" ]; then
  APP_ID="$EXISTING"
  say "复用已存在的 demo App: $APP_ID"
  # 重新拿凭证（list 响应里也含，但显式 get 更清晰）
  RESP=$(curl -sf "$SERVER/api/apps/$APP_ID")
else
  # 3. 创建 App
  say "创建 demo App..."
  RESP=$(curl -sf -X POST "$SERVER/api/apps" \
    -H 'Content-Type: application/json' \
    -d '{"name":"demo"}') || die "创建 App 失败"
fi

APP_ID=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")
EMAIL=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_email'])")
PASSWORD=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_password'])")

say "App: $APP_ID"
say "Email: $EMAIL"

# 4. 复制前端文件
TARGET_DIR="$PUBLIC_DIR/$APP_ID"
say "复制前端文件到 $TARGET_DIR..."
mkdir -p "$TARGET_DIR"
cp "$DEMO_SOURCE/index.html" "$TARGET_DIR/index.html"

# 5. 换 token
say "用凭证换 token..."
TOKEN=$(curl -sf -X POST "$SERVER/$APP_ID/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])") \
  || die "换 token 失败"

# 6. 初始化 collection（幂等：先尝试 DELETE，再 POST）
say "初始化 posts collection..."

# 6.1 找已存在的 posts collection 的 id（如果有）
# PocketBase 列表端点是 /api/collections，需要 superuser token。
EXISTING_CID=$(curl -sf "$SERVER/$APP_ID/api/collections" \
  -H "Authorization: $TOKEN" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', data) if isinstance(data, dict) else data
for c in items:
    if c.get('name') == 'posts':
        print(c.get('id'))
        break
else:
    print('')
")

if [ -n "$EXISTING_CID" ]; then
  say "已存在 posts collection (id=$EXISTING_CID)，删除后重建..."
  curl -sf -X DELETE "$SERVER/$APP_ID/api/collections/$EXISTING_CID" \
    -H "Authorization: $TOKEN" > /dev/null
fi

# 6.2 创建 posts collection
say "创建 posts collection..."
curl -sf -X POST "$SERVER/$APP_ID/api/collections" \
  -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "posts",
    "type": "base",
    "listRule": null,
    "viewRule": null,
    "createRule": null,
    "updateRule": "",
    "deleteRule": "",
    "fields": [
      {"name": "name", "type": "text", "required": true, "min": 1, "max": 50},
      {"name": "content", "type": "text", "required": true, "min": 1, "max": 500}
    ]
  }' > /dev/null || die "创建 collection 失败"

# 7. 完成
say "完成！访问 $SERVER/$APP_ID/ 试用留言板。"
say "控制面板：$SERVER/"
```

### 4.7 文档同步

- `architecture.md` §4 路由模型补 `/` 控制面板行
- `architecture.md` 新增 §10「控制面板与 Demo」章节
- `README.md` 加「快速开始」：`cargo run` → `scripts/install-demo.sh` → 浏览器访问 `http://localhost:3000/`

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| `public/_panel/index.html` 不存在 | 根路径返回 fallback HTML，`tracing::warn!` 记录（不视为错误） |
| 控制面板 fetch `/api/apps` 失败 | 前端 DOM 显示「加载失败：xxx」 |
| `install-demo.sh` 时服务未启动 | `curl /health` 失败，脚本退出码非 0，提示「先 cargo run」 |
| `install-demo.sh` 时 demo App 已存在 | 复用 + 重做 cp 和 collection 初始化（幂等） |
| `install-demo.sh` 时 posts collection 已存在 | 先 DELETE 再 POST（幂等覆盖，可能丢失已有留言——**接受**，因为脚本是 dev 工具，重复执行期间用户预期重建） |
| `install-demo.sh` 时前端 cp 失败（源文件不存在） | `cp` 报错，脚本退出 |
| 留言板前端 fetch 失败（PB 进程挂了） | DOM 显示「加载失败：xxx」 |
| 留言板表单提交失败（字段超长等） | `alert('提交失败：xxx')` |
| 控制面板拿到 `/api/apps` 含 superuser 凭证 | **pre-existing 风险**，前端白名单渲染，DOM 不暴露；标记为后续 plan 处理 |

## 6. 安全考量

- **控制面板无鉴权**：与 `/api/apps` 当前行为一致，localhost 自用范围可接受
- **`/api/apps` 凭证泄露面**：响应含 `superuser_password` 明文，前端 fetch 后整个 JSON 在浏览器 Network 标签可见。控制面板设计**不主动渲染**凭证（白名单），但不消除传输层暴露。**已知问题，后续 plan 解决**（候选方案：`/api/apps` 默认脱敏，`?include_credentials=true` 才返回）
- **XSS 防护**：所有从 API 拿到的字段进 DOM 前必须 `escapeHtml`（留言板 name/content、控制面板 name/id/status）
- **路径穿越**：`install-demo.sh` 不接受外部输入的 APP_ID（服务端生成），不存在路径穿越
- **PocketBase rule 设计**：posts collection 的 `listRule`/`viewRule`/`createRule` 设为 `""`（公开匿名访问），`updateRule`/`deleteRule` 设为 `null`（永远拒绝），防止单条留言被覆盖 / 删除；这是留言板本身的语义

## 7. 测试改动

**新增（`crates/server/src/lib_test.rs`）**：

- `test_根路径_控制面板HTML存在_返回HTML`：在 `public/_panel/index.html` 放一个简单 HTML，GET `/` 返回 200 + content-type `text/html` + body 含 `<title>agent-sites</title>`
- `test_根路径_控制面板HTML不存在_返回fallback`：删掉 `_panel` 目录，GET `/` 返回 200 + body 含「控制面板 HTML 未安装」

**新增（手工 e2e，无单元测试）**：

- 跑 `scripts/install-demo.sh` → `curl /api/apps` 看到 demo App → `curl /{id}/` 看到 demo HTML → `curl /{id}/api/collections/posts/records` 返回空数组 → 表单 POST 一条 → list 看到该条

## 8. 验收标准

- `cargo test -p agent-sites` 全过
- `cargo clippy -- -D warnings` 全绿
- `cargo fmt --check` 全绿
- `bash scripts/install-demo.sh` 在服务跑着时执行成功，重复执行也成功（幂等）
- 浏览器访问 `http://localhost:3000/`：
  - 看到 demo App 卡片（name=demo）
  - 点「打开 →」跳转到 `/{id}/`，看到留言板 UI
  - 表单提交留言 → 列表实时刷新
- 控制面板 HTML 不存在时，根路径 fallback 到提示文字（不 500）
- 控制面板和留言板的 DOM 中都不出现 `superuser_password` 字符串

## 9. 实施步骤概览（writing-plans 详化）

1. 写 `public/_panel/index.html`（控制面板 HTML + CSS + JS）
2. 改 `lib.rs::create_app` 的 `/` 路由 + 新增 `serve_panel` handler + 加 2 个根路径测试
3. 写 `demo/guestbook/index.html`（留言板 HTML + CSS + JS）
4. 写 `scripts/install-demo.sh`（幂等注册 + collection 初始化）
5. 手动 e2e：`cargo run` + `bash scripts/install-demo.sh` + 浏览器验证
6. 文档同步（architecture.md / README.md）
