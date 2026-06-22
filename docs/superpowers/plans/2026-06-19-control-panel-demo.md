> ⚠️ **已归档**（过渡期文档，2026-06-19）
>
> 本文档是 **Rust 网关 + PocketBase** 阶段的设计/实现记录，已被 **Deno + PocketBase** 实现替代。
> 当前权威参考：
> - 架构：`docs/architecture.md`
> - 控制面板：`public/_panel/index.html`（brutalist technical 风格，2026-06-20 重写）
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 控制面板 + Demo 留言板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent-sites 加上控制面板（根路径 `/` 列出所有 App + 进入）和一个完整的留言板 demo 应用（前端 + PocketBase 后端），用 shell 脚本一键上线。

**Architecture:** 控制面板是 `public/_panel/index.html` 静态 HTML + 原生 JS，fetch `/api/apps` 列出 App。留言板是 `demo/guestbook/index.html`，前端从 URL 解析 app_id 调 PB `posts` collection。`scripts/install-demo.sh` 幂等地创建 App + cp 前端 + 初始化 collection。

**Tech Stack:** Rust + axum（路由）；原生 HTML/CSS/JS（bundleless，无构建工具）；PocketBase（每 App 一个进程，SQLite）；bash + curl + python3（上线脚本）。

**Spec:** `docs/superpowers/specs/2026-06-19-control-panel-demo-design.md`

---

## Task 1: 控制面板后端（`serve_panel` handler）

**Files:**
- Modify: `crates/server/src/lib.rs:31`（根路由替换）
- Modify: `crates/server/src/lib.rs`（新增 `serve_panel` 函数）
- Test: `crates/server/src/lib_test.rs`（加 3 个根路径测试）
- Create: `public/_panel/index.html`（占位文件，Task 2 替换为完整版）

- [ ] **Step 1: 写 3 个失败测试**

打开 `crates/server/src/lib_test.rs`，找到现有的 `test_根路径_返回标识` 测试（第 49-67 行），把它替换为下面 3 个测试。

`make_state` 签名是 `async fn make_state(tmp: &tempfile::TempDir) -> Arc<AppState>`（**接收 TempDir 引用**）。`make_state` 内部会用 `tmp.path().join("public")` 作为 public_dir。所以「HTML 存在」测试需要在 `make_state` 之后手动写入 `_panel/index.html`。

替换 `test_根路径_返回标识` 整个函数（第 49-67 行）为下面 3 个测试：

```rust
#[tokio::test]
async fn test_根路径_控制面板HTML存在_返回HTML含核心元素() {
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    // make_state 已建好 public_dir，写入占位 _panel/index.html
    let panel = tmp.path().join("public").join("_panel").join("index.html");
    tokio::fs::create_dir_all(panel.parent().unwrap()).await.unwrap();
    tokio::fs::write(&panel, "<!doctype html><title>agent-sites</title><script>fetch('/api/apps')</script>")
        .await
        .unwrap();
    let app = create_app(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        ctype.starts_with("text/html"),
        "content-type 应为 text/html，实际: {}",
        ctype
    );
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let html = String::from_utf8_lossy(&bytes);
    assert!(html.contains("agent-sites"), "应包含标题 agent-sites");
    assert!(html.contains("/api/apps"), "JS 应 fetch /api/apps");
}

#[tokio::test]
async fn test_根路径_控制面板HTML不存在_返回fallback() {
    // make_state 默认创建空 public_dir（无 _panel）
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    let app = create_app(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), 1024).await.unwrap();
    let html = String::from_utf8_lossy(&bytes);
    assert!(
        html.contains("控制面板 HTML 未安装"),
        "fallback 应含提示文字，实际: {}",
        html
    );
}

#[tokio::test]
async fn test_根路径_始终返回200_不是404() {
    // 即使 _panel 不存在，根路径也返回 200（fallback 路径）
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    let app = create_app(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}
```

**关键**：现有 `make_state(&tmp)` 已经创建空 `public_dir`（tmp/public/），但**不**含 `_panel`。第二个测试就是测这种情况——不需要做任何额外操作。

**不需要新增 helper**：直接复用现有 `make_state(&tmp)`，仅在第一个测试里手动写入 panel HTML。

- [ ] **Step 2: 跑测试确认失败**

```bash
cargo test -p agent-sites --lib test_根路径
```

预期：3 个测试编译失败或运行失败，因为：
- `/` 路由还返回纯文本 `"agent-sites — Vibe App 平台"`，不是 HTML
- `serve_panel` 函数不存在
- `make_state_with_public_dir` 可能不存在（如已加，这步会过编译但跑测试会 fail）

- [ ] **Step 3: 改 `crates/server/src/lib.rs` — 改根路由**

打开 `crates/server/src/lib.rs`，找到第 31 行：

```rust
.route("/", get(|| async { "agent-sites — Vibe App 平台" })),
```

改为：

```rust
.route("/", get(serve_panel)),
```

- [ ] **Step 4: 在 `lib.rs` 新增 `serve_panel` 函数**

在 `lib.rs` 文件中找到 `async fn serve_static(...)` 之前（约第 78 行），插入：

```rust
async fn serve_panel(State(state): State<Arc<AppState>>) -> Result<axum::response::Html<String>, error::AppError> {
    let panel_path = state.public_dir.join("_panel").join("index.html");
    match tokio::fs::read_to_string(&panel_path).await {
        Ok(html) => Ok(axum::response::Html(html)),
        Err(_) => {
            tracing::warn!(path = %panel_path.display(), "控制面板 HTML 未安装，fallback 到提示文字");
            Ok(axum::response::Html(
                "<!doctype html><meta charset=\"utf-8\"><title>agent-sites</title>\
                 agent-sites — 控制面板 HTML 未安装".to_string()
            ))
        }
    }
}
```

并确认文件顶部 `use` 块（约第 12-16 行）已经引入 `State`：

```rust
use axum::extract::{Path, State};
```

应该已经有，不需要改。

- [ ] **Step 5: 创建占位 `public/_panel/index.html`**

为了让 Step 1 第一个测试通过，先放一个占位文件（Task 2 会替换为完整版）：

```bash
mkdir -p public/_panel
```

写入 `public/_panel/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>agent-sites · 控制面板（占位）</title>
</head>
<body>
  <h1>agent-sites</h1>
  <p>占位文件，Task 2 替换为完整版。</p>
  <script>
    // 占位 fetch，让 test_根路径_控制面板HTML存在_返回HTML含核心元素 通过
    fetch('/api/apps');
  </script>
</body>
</html>
```

注意：占位必须包含 `agent-sites` 字符串和 `/api/apps` 字符串，否则 Step 1 第一个测试会失败。

- [ ] **Step 6: 跑测试确认通过**

```bash
cargo test -p agent-sites --lib test_根路径
```

预期：3 个测试全 PASS。

如果失败，检查：
- `make_state_with_public_dir` 是否定义正确（用入参而非临时目录的 public）
- `serve_panel` 是否在 `lib.rs` 注册到 `/` 路由
- 占位 HTML 是否包含 `agent-sites` + `/api/apps`

- [ ] **Step 7: 跑全量测试确认没破坏其他**

```bash
cargo test -p agent-sites
```

预期：所有现有测试仍通过（包括 superuser-init plan 的 68 个测试）。

- [ ] **Step 8: clippy + fmt**

```bash
cargo clippy -p agent-sites --all-targets -- -D warnings
cargo fmt -p agent-sites -- --check
```

预期：无 warning，无 diff。

- [ ] **Step 9: Commit**

```bash
git add crates/server/src/lib.rs crates/server/src/lib_test.rs public/_panel/index.html
git commit -m "$(cat <<'EOF'
feat(panel): 根路径 / 返回控制面板 HTML

serve_panel handler 读 public/_panel/index.html，文件不存在时
fallback 到提示文字（200，不是 404）。

3 个测试覆盖：HTML 存在/不存在/始终 200。
占位 HTML，Task 2 替换为完整版。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 2: 控制面板前端（完整 HTML/CSS/JS）

**Files:**
- Modify: `public/_panel/index.html`（覆盖 Task 1 的占位）

- [ ] **Step 1: 用完整版覆盖 `public/_panel/index.html`**

把 Task 1 创建的占位文件替换为下面完整版（覆盖整个文件内容）：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>agent-sites · 控制面板</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1rem;
      line-height: 1.5;
    }
    h1 { margin: 0 0 0.5rem; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    button {
      font: inherit;
      padding: 0.4rem 1rem;
      border: 1px solid #888;
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover { background: #f0f0f0; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .card {
      border: 1px solid #ccc;
      padding: 1rem;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .card h3 { margin: 0 0 0.5rem; }
    .meta { color: #666; font-size: 0.85rem; }
    .open {
      display: inline-block;
      margin-top: 0.75rem;
      text-decoration: none;
      color: #0066cc;
      font-weight: 500;
    }
    .open:hover { text-decoration: underline; }
    .status-running::before { content: "● "; color: green; }
    .status-other::before { content: "● "; color: orange; }
    code { background: #eee; padding: 0.1em 0.3em; border-radius: 3px; }
    .empty { color: #666; padding: 2rem 0; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #eee; }
      .card { border-color: #444; }
      .meta { color: #999; }
      button { border-color: #666; }
      button:hover { background: #2a2a2a; }
      .open { color: #66ccff; }
      code { background: #2a2a2a; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>agent-sites</h1>
      <div class="meta">App 列表</div>
    </div>
    <button onclick="load()">刷新</button>
  </div>
  <div id="apps" class="grid"></div>

  <script>
    async function load() {
      const el = document.getElementById('apps');
      el.innerHTML = '<div class="empty">加载中...</div>';
      try {
        const r = await fetch('/api/apps');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const apps = j.data || [];
        if (apps.length === 0) {
          el.innerHTML = '<div class="empty">还没有 App。运行 <code>scripts/install-demo.sh</code> 创建一个 demo 应用。</div>';
          return;
        }
        apps.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        el.innerHTML = apps.map(a => `
          <div class="card">
            <h3>${escapeHtml(a.name || '(未命名)')}</h3>
            <div class="meta">${escapeHtml(a.id)}</div>
            <div class="meta">${formatTime(a.created_at)}</div>
            <div class="meta status-${a.status === 'running' ? 'running' : 'other'}">${escapeHtml(a.status || 'unknown')}</div>
            <a class="open" href="/${encodeURIComponent(a.id)}/">打开 →</a>
          </div>
        `).join('');
      } catch (e) {
        el.innerHTML = '<div class="empty">加载失败：' + escapeHtml(String(e)) + '</div>';
      }
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      const pad = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
           + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    load();
  </script>
</body>
</html>
```

- [ ] **Step 2: 跑测试确认仍通过**

```bash
cargo test -p agent-sites --lib test_根路径
```

预期：3 个测试仍 PASS（HTML 包含 `agent-sites` + `/api/apps`，符合断言）。

- [ ] **Step 3: 启动服务手动验证**

```bash
cargo run &
SERVER_PID=$!
sleep 3
curl -s http://localhost:3000/ | head -10
kill $SERVER_PID
wait 2>/dev/null
```

预期：返回完整 HTML，第一行 `<!doctype html>`，含 `<h1>agent-sites</h1>`。

- [ ] **Step 4: Commit**

```bash
git add public/_panel/index.html
git commit -m "$(cat <<'EOF'
feat(panel): 控制面板完整 HTML/CSS/JS

fetch /api/apps → 卡片网格（暗色自适应），白名单渲染
id/name/status/created_at（不渲染 superuser 凭证）。
空列表引导用户跑 install-demo.sh。HTML escape 防 XSS。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: demo 留言板前端

**Files:**
- Create: `demo/guestbook/index.html`

注意：这个文件**不**在 `public/`，避免被当 App 自动加载。`install-demo.sh`（Task 4）会把它 cp 到 `public/{app_id}/`。

- [ ] **Step 1: 创建 `demo/guestbook/` 目录**

```bash
mkdir -p demo/guestbook
```

- [ ] **Step 2: 写入 `demo/guestbook/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>留言板 / Guestbook</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1rem;
      line-height: 1.5;
    }
    h1 { margin-bottom: 0.25rem; }
    .back { display: inline-block; margin-bottom: 1.5rem; color: #0066cc; }
    form {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-bottom: 2rem;
      padding: 1rem;
      border: 1px solid #ccc;
      border-radius: 8px;
    }
    input, textarea {
      font: inherit;
      padding: 0.5rem;
      border: 1px solid #aaa;
      border-radius: 4px;
    }
    textarea { min-height: 4rem; resize: vertical; }
    button {
      align-self: flex-end;
      padding: 0.5rem 1.5rem;
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: #0055aa; }
    .post { border-bottom: 1px solid #eee; padding: 1rem 0; }
    .post:last-child { border-bottom: none; }
    .post .meta { color: #666; font-size: 0.85rem; margin-bottom: 0.25rem; }
    .empty { color: #666; padding: 1rem 0; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #eee; }
      .back { color: #66ccff; }
      form { border-color: #444; }
      input, textarea { background: #2a2a2a; color: #eee; border-color: #555; }
      button { background: #0066cc; }
      button:hover { background: #0055aa; }
      .post { border-color: #333; }
      .post .meta { color: #999; }
    }
  </style>
</head>
<body>
  <a class="back" href="/">← 返回控制面板</a>
  <h1>留言板 / Guestbook</h1>

  <form id="form">
    <input name="name" placeholder="你的名字（最多 50 字）" maxlength="50" required>
    <textarea name="content" placeholder="留言（最多 500 字）" maxlength="500" required></textarea>
    <button type="submit">提交</button>
  </form>

  <h2>留言列表</h2>
  <div id="list"></div>

  <script>
    // 从 URL 解析 app_id（无需构建时注入）
    const APP_ID = window.location.pathname.split('/')[1];

    async function loadList() {
      const el = document.getElementById('list');
      el.innerHTML = '<div class="empty">加载中...</div>';
      try {
        const r = await fetch(`/${APP_ID}/api/collections/posts/records?sort=-created`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const items = j.items || [];
        if (items.length === 0) {
          el.innerHTML = '<div class="empty">还没有留言，做第一个吧。</div>';
          return;
        }
        el.innerHTML = items.map(p => `
          <div class="post">
            <div class="meta">${escapeHtml(p.name)} · ${formatTime(p.created)}</div>
            <div>${escapeHtml(p.content)}</div>
          </div>
        `).join('');
      } catch (e) {
        el.innerHTML = '<div class="empty">加载失败：' + escapeHtml(String(e)) + '</div>';
      }
    }

    document.getElementById('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const body = { name: fd.get('name'), content: fd.get('content') };
      try {
        const r = await fetch(`/${APP_ID}/api/collections/posts/records`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.text();
          alert('提交失败：' + err);
          return;
        }
        ev.target.reset();
        loadList();
      } catch (e) {
        alert('提交失败：' + e);
      }
    });

    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      const pad = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
           + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    loadList();
  </script>
</body>
</html>
```

- [ ] **Step 3: 验证文件已创建**

```bash
ls -la demo/guestbook/index.html
wc -l demo/guestbook/index.html
```

预期：文件存在，行数约 110 行。

- [ ] **Step 4: 不需要 Rust 测试**

`demo/guestbook/index.html` 不在 cargo 编译范围，不会被 Rust 加载。Task 4 的 install-demo.sh 会通过 cp + 服务端访问验证它。

- [ ] **Step 5: Commit**

```bash
git add demo/guestbook/index.html
git commit -m "$(cat <<'EOF'
feat(demo): 留言板前端 demo/guestbook/index.html

原生 HTML/JS，bundleless。从 URL pathname 解析 app_id
（无构建时注入），fetch PocketBase posts collection records。
表单 POST + 列表 GET，HTML escape 防 XSS。

install-demo.sh 会 cp 到 public/{app_id}/。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: `scripts/install-demo.sh` 上线脚本

**Files:**
- Create: `scripts/install-demo.sh`

- [ ] **Step 1: 创建 `scripts/` 目录**

```bash
mkdir -p scripts
```

- [ ] **Step 2: 写入 `scripts/install-demo.sh`**

```bash
#!/usr/bin/env bash
# 把 demo 留言板应用注册到 agent-sites 系统。
# 幂等：可重复执行，已存在则复用 + 重做 cp 和 collection 初始化。
#
# 用法：
#   cargo run &            # 先启动服务
#   scripts/install-demo.sh

set -euo pipefail

SERVER="${AGENT_SITES_URL:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_SOURCE="$REPO_ROOT/demo/guestbook"
PUBLIC_DIR="$REPO_ROOT/public"

# 颜色输出
say()  { printf '\033[32m[install-demo]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[install-demo] 错误:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# 1. 检查服务在跑
say "检查服务健康 ($SERVER/health)..."
curl -sf "$SERVER/health" > /dev/null || die "服务未启动（$SERVER）。先 cargo run。"

# 2. 找已存在的 demo App
say "查找已存在的 demo App..."
EXISTING_ID=$(curl -sf "$SERVER/api/apps" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
demos = [a for a in data if a.get('name') == 'demo']
print(demos[0]['id'] if demos else '')
")

if [ -n "$EXISTING_ID" ]; then
  APP_ID="$EXISTING_ID"
  say "复用已存在的 demo App: $APP_ID"
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

# 6. 初始化 collection（幂等：先 DELETE 已存在的，再 POST）
say "初始化 posts collection..."

# 6.1 找已存在的 posts collection id
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

# 6.2 创建 posts collection（rule: null = 公开，"" = 永远拒绝）
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
say "完成！"
echo ""
echo "  控制面板：$SERVER/"
echo "  留言板：  $SERVER/$APP_ID/"
echo ""
```

- [ ] **Step 3: 给脚本执行权限**

```bash
chmod +x scripts/install-demo.sh
```

- [ ] **Step 4: 验证脚本语法**

```bash
bash -n scripts/install-demo.sh
echo "exit=$?"
```

预期：`exit=0`（语法无误）。

- [ ] **Step 5: 启动服务 + 跑脚本验证**

```bash
cargo run > /tmp/agent-sites-install-test.log 2>&1 &
SERVER_PID=$!
sleep 4

# 跑脚本
./scripts/install-demo.sh
EXIT_CODE=$?

# 看输出
echo "脚本退出码: $EXIT_CODE"

# 验证 App 已注册
APP_ID=$(curl -s http://localhost:3000/api/apps | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
demos = [a for a in data if a.get('name') == 'demo']
print(demos[0]['id'] if demos else 'NONE')
")
echo "demo App id: $APP_ID"

# 验证前端文件已 cp
ls -la public/$APP_ID/index.html

# 验证 collection 已创建
EMAIL=$(curl -s http://localhost:3000/api/apps/$APP_ID | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_email'])")
PASSWORD=$(curl -s http://localhost:3000/api/apps/$APP_ID | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_password'])")
TOKEN=$(curl -s -X POST http://localhost:3000/$APP_ID/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])")

curl -s "http://localhost:3000/$APP_ID/api/collections/posts" \
  -H "Authorization: $TOKEN" \
  | python3 -c "import sys, json; d = json.load(sys.stdin); print('collection name:', d.get('name', 'MISSING'))"

# 清理（保留 App 用于 Task 5/6 验证，注释掉）
# curl -X DELETE http://localhost:3000/api/apps/$APP_ID

kill $SERVER_PID
wait 2>/dev/null
```

预期：
- 脚本退出码 `0`
- demo App id 是 `app-xxx` 格式
- `public/app-xxx/index.html` 存在
- collection name: `posts`

- [ ] **Step 6: 跑脚本第二次，验证幂等性**

```bash
cargo run > /tmp/agent-sites-install-test2.log 2>&1 &
SERVER_PID=$!
sleep 4

./scripts/install-demo.sh
EXIT_CODE=$?
echo "第二次退出码: $EXIT_CODE"

# 应该看到 "复用已存在的 demo App" 而不是 "创建 demo App"
grep "复用已存在" /tmp/agent-sites-install-test2.log || ./scripts/install-demo.sh 2>&1 | grep "复用已存在"

kill $SERVER_PID
wait 2>/dev/null
```

预期：第二次执行也退出码 `0`，输出含「复用已存在的 demo App」。

- [ ] **Step 7: Commit**

```bash
git add scripts/install-demo.sh
git commit -m "$(cat <<'EOF'
feat(scripts): install-demo.sh 幂等注册留言板 demo

流程：检查服务 → 查找/创建 demo App → cp 前端 → 凭证换 token
→ 创建 posts collection（rule: null 公开 + "" 拒绝改删）。

依赖 curl + python3。可重复执行（幂等：复用 App +
先 DELETE 已存在 collection 再 POST）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: 文档同步

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: 读 `docs/architecture.md` 路由表定位**

```bash
grep -n "4.1\|统一入口\|路径前缀" docs/architecture.md | head -5
```

找到 §4.1 路由表（约第 47-60 行）。

- [ ] **Step 2: 在路由表里补 `/` 控制面板行**

打开 `docs/architecture.md`，找到 §4.1 的路由表（如「| `/api/apps` | POST | 创建 App |」之类）。在表格最前/合适位置插入：

```markdown
| `/` | GET | 控制面板（列 App + 进入，`public/_panel/index.html`） |
```

具体位置：在「| `/health` | GET | 健康检查 |」之后或之前。

- [ ] **Step 3: 在 `docs/architecture.md` 末尾新增 §10 章节**

打开 `docs/architecture.md`，在文件末尾追加：

```markdown

## 10. 控制面板与 Demo

### 10.1 控制面板

根路径 `/` 返回 `public/_panel/index.html` 静态页面：

- 原生 HTML + 原生 JS（无构建工具），符合 §2 bundleless 定位
- `fetch('/api/apps')` 列出所有 App，渲染为卡片网格
- 卡片「打开」链接到 `/{app_id}/`（App 前端入口）
- **白名单渲染**：只显示 `id` / `name` / `status` / `created_at`，不渲染 `superuser_email` / `superuser_password`（虽然 `/api/apps` 响应含凭证，DOM 不暴露——传输层暴露是 pre-existing 风险，待后续 plan 处理）
- **无鉴权**：与 `/api/apps` 当前行为一致（localhost 自用）

文件不存在时 fallback 到提示 HTML（200，不是 404）。

### 10.2 Demo 留言板

仓库内 `demo/guestbook/index.html` 是一个最小完整 demo：

- PocketBase collection：`posts`（`name` + `content`）
- rule：`listRule`/`createRule` = `null`（公开匿名读写），`updateRule`/`deleteRule` = `""`（永远拒绝）
- 前端从 URL pathname 解析 `app_id`（无构建时注入），调 `/{app_id}/api/collections/posts/records`
- 通过 `scripts/install-demo.sh` 一键上线（幂等）

### 10.3 install-demo.sh

```bash
cargo run &                # 先启动服务
scripts/install-demo.sh    # 一键注册 demo
```

幂等流程：
1. `curl /health` 检查服务
2. `GET /api/apps` 找 `name=demo`，没有就 `POST` 创建
3. `cp demo/guestbook/* → public/{app_id}/`
4. 凭证换 token
5. `DELETE` 已存在的 `posts` collection（如有），`POST` 重建
```

- [ ] **Step 4: 读 `README.md` 看现状**

```bash
cat README.md
```

- [ ] **Step 5: 在 `README.md` 加「快速开始」章节**

如果 `README.md` 还没有「快速开始」/「Quick Start」章节，在合适位置（通常在介绍之后）插入：

```markdown
## 快速开始

```bash
# 1. 启动服务
cargo run

# 2. 另开终端，注册 demo 留言板
scripts/install-demo.sh

# 3. 浏览器访问
#    http://localhost:3000/         控制面板（列 App + 进入）
#    http://localhost:3000/{app_id}/ 留言板（提交 + 列表）
```

服务监听 `0.0.0.0:3000`，需要 `bin/pocketbase`（PocketBase 二进制）。
```

如果 `README.md` 已有「快速开始」章节，把上面内容并入（不要重复标题）。

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "$(cat <<'EOF'
docs: 控制面板与 demo 留言板使用说明

- architecture.md §4.1 路由表补 / 控制面板行
- architecture.md 新增 §10 控制面板与 demo 章节
- README.md 加快速开始（cargo run → install-demo.sh → 浏览器）

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: 全套 e2e 验证

**Files:** 无文件修改

**目的：** 跑完整流程，确认 spec §8 验收标准全过。

- [ ] **Step 1: 跑全量测试**

```bash
cargo test -p agent-sites
```

预期：71 个测试通过（原 68 + Task 1 的 3 个新测试）。

- [ ] **Step 2: clippy + fmt**

```bash
cargo clippy -p agent-sites --all-targets -- -D warnings
cargo fmt -p agent-sites -- --check
```

预期：无 warning，无 diff。

- [ ] **Step 3: 完整端到端流程**

```bash
# 启动服务
cargo run > /tmp/agent-sites-e2e-final.log 2>&1 &
SERVER_PID=$!
sleep 4

# 跑上线脚本（如果是首次：创建 + cp + collection；如果已存在：复用）
./scripts/install-demo.sh

# 拿 demo App id
APP_ID=$(curl -s http://localhost:3000/api/apps | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
demos = [a for a in data if a.get('name') == 'demo']
print(demos[0]['id'] if demos else 'NONE')
")
echo "App: $APP_ID"

# 1. 验证控制面板能访问
echo "--- 控制面板 ---"
curl -s -o /dev/null -w "Status: %{http_code}\n" http://localhost:3000/
curl -s http://localhost:3000/ | grep -o '<h1>[^<]*</h1>'

# 2. 验证控制面板能看到 demo App（fetch /api/apps）
echo "--- /api/apps 含 demo ---"
curl -s http://localhost:3000/api/apps | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
print('App 数量:', len(data))
for a in data:
    print(' -', a['name'], a['id'])
"

# 3. 验证留言板能访问
echo "--- 留言板 ---"
curl -s -o /dev/null -w "Status: %{http_code}\n" "http://localhost:3000/$APP_ID/"
curl -s "http://localhost:3000/$APP_ID/" | grep -o '<h1>[^<]*</h1>'

# 4. 验证表单提交（直接调 API，模拟前端 JS 行为）
echo "--- 提交一条留言 ---"
SUBMIT_RESP=$(curl -s -X POST "http://localhost:3000/$APP_ID/api/collections/posts/records" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","content":"这个留言板好酷！"}')
echo "$SUBMIT_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('提交成功，id:', d.get('id', 'MISSING'))
print('name:', d.get('name'))
print('content:', d.get('content'))
"

# 5. 验证列表能拿到这条
echo "--- 留言列表 ---"
curl -s "http://localhost:3000/$APP_ID/api/collections/posts/records?sort=-created" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('items', [])
print('共', len(items), '条')
for p in items[:3]:
    print(' -', p.get('name'), '·', p.get('content'))
"

# 6. 验证控制面板 HTML 不暴露 superuser 凭证
echo "--- 控制面板 HTML 安全 ---"
PANEL_HTML=$(curl -s http://localhost:3000/)
if echo "$PANEL_HTML" | grep -q "superuser_password"; then
  echo "❌ 控制面板 HTML 含 superuser_password 字符串"
else
  echo "✓ 控制面板 HTML 不含 superuser_password"
fi

# 7. 验证 /_/ 屏蔽（demo App 也有 _ 路由屏蔽）
echo "--- /_/ 屏蔽 ---"
curl -s -o /dev/null -w "Status: %{http_code} (期望 404)\n" "http://localhost:3000/$APP_ID/_/"

# 清理
kill $SERVER_PID
wait 2>/dev/null
echo "--- 完成 ---"
```

预期：
- 控制面板 200 + `<h1>agent-sites</h1>`
- `/api/apps` 含 demo App（数量 ≥ 1）
- 留言板 200 + `<h1>留言板 / Guestbook</h1>`
- 表单提交成功，返回 id
- 列表至少 1 条（含刚提交的）
- 控制面板 HTML 不含 `superuser_password` 字符串
- `/$APP_ID/_/` 返回 404

- [ ] **Step 4: 最终 git log 检查**

```bash
git log --oneline -10
```

预期：看到本 plan 5-6 个提交（Task 1-5 各一个 + Task 6 无文件改动）。

- [ ] **Step 5: 更新 memory**

更新 `/Users/konghayao/.claude/projects/-Users-konghayao-code-ai-agent-sites/memory/project_pocketbase_pivot.md`，在「后续修复（2026-06-19 superuser-init plan）」之后追加：

```markdown
**2026-06-19 控制面板 + demo plan**：plan 文档 `docs/superpowers/plans/2026-06-19-control-panel-demo.md`，spec 文档 `docs/superpowers/specs/2026-06-19-control-panel-demo-design.md`。

1. ✅ 控制面板：根路径 / 返回 `public/_panel/index.html`，fetch /api/apps 列卡片
2. ✅ Demo 留言板：`demo/guestbook/index.html` + PocketBase posts collection
3. ✅ `scripts/install-demo.sh` 幂等上线脚本
4. ⚠️ 已知 pre-existing：`/api/apps` 响应含 superuser_password 明文，控制面板前端白名单渲染避开（不解决传输层暴露），标记为后续 plan

控制面板 + demo 应用关键技术决策：
- bundleless（无构建工具），原生 JS
- 前端从 `window.location.pathname.split('/')[1]` 解析 app_id（无构建时注入）
- PocketBase rule：`null` = 公开，`""` = 永远拒绝（防止单条留言被改删）
- escapeHtml 防 XSS（所有 API 字段进 DOM 前）
```

memory 文件不在 git 仓库内，无需 git 提交。

---

## Self-Review

### Spec 覆盖性

| Spec 章节 | 对应任务 | 状态 |
|---|---|---|
| §4.1 控制面板路由（serve_panel） | Task 1 | ✅ |
| §4.2 控制面板 HTML | Task 2 | ✅ |
| §4.3 路由冲突检查（_panel 不被 /{app_id} 覆盖） | Task 1 Step 7（跑全量测试验证） | ✅ |
| §4.4 demo 留言板前端 | Task 3 | ✅ |
| §4.5 posts collection schema | Task 4 Step 2（install-demo.sh 含 fields 定义）+ Step 5 验证 | ✅ |
| §4.6 install-demo.sh | Task 4 | ✅ |
| §4.7 文档同步 | Task 5 | ✅ |
| §5 错误处理 | Task 1（serve_panel fallback）+ Task 4（脚本检查） | ✅ |
| §6 安全考量 | Task 6 Step 3 验证（HTML 不含 superuser_password） | ✅ |
| §7 测试改动 | Task 1 Step 1（3 个测试） | ✅ |
| §8 验收标准 | Task 6 | ✅ |

### Type 一致性检查

- `serve_panel` 函数签名（Task 1 Step 4）：`async fn serve_panel(State(state): State<Arc<AppState>>) -> Result<axum::response::Html<String>, error::AppError>` — 与 lib.rs 现有 handler 风格一致 ✅
- `make_state_with_public_dir` helper（Task 1 Step 1）：返回 `Arc<AppState>`，与 `make_state` 一致 ✅
- 测试名命名（snake_case 中文）：与现有测试风格一致 ✅
- `escapeHtml` / `formatTime` JS 函数：控制面板和留言板都使用同名同实现 ✅
- install-demo.sh 变量命名：`APP_ID` / `EMAIL` / `PASSWORD` / `TOKEN` / `EXISTING_ID` / `EXISTING_CID` 全程一致 ✅

### Placeholder 扫描

无 TBD/TODO/FIXME。所有 Step 都有完整代码或具体命令。

### 范围检查

6 个 task，每个独立可测试，单个 plan 可完成。无需分解。

---

## 执行说明

按 Task 1 → 6 顺序执行。Task 1 必须最先（其他都依赖控制面板后端）。

**风险点**：
- Task 1 Step 1 需要 `make_state_with_public_dir` helper。如果 `make_state` 实现复杂，复制时注意保留 PB 进程管理初始化逻辑。
- Task 4 install-demo.sh 依赖 PocketBase 0.23.x 的 rule 语义（`null` = 公开）。如 PB 版本不同，rule 表现可能不同。
- Task 4 install-demo.sh 用 `#!/usr/bin/env bash` + `set -euo pipefail`。脚本只用普通变量、命令替换、heredoc JSON，**不**用关联数组，macOS 默认 bash 3.2 也能跑。如执行者环境有问题，再单独排查。
