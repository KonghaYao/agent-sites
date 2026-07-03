# 管理面板 PB 数据浏览 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理面板中增加 PB 数据浏览功能——点击 App 进入全屏详情页，浏览该 App 的 collections、records 和 schema。

**Architecture:** 纯前端变更，单文件 `public/_panel/index.html`。hash 路由（`#` vs `#{app_id}`）切换视图。用 master key 按需申请 platform token，走 `GET /{app_id}/api/collections*` 代理拉 PB 数据。Token 在离开详情页时吊销。

**Tech Stack:** Vanilla HTML/CSS/JS，无外部依赖。复用现有 brutalist 风格 CSS 变量。

**Spec:** `docs/superpowers/specs/2026-07-02-panel-pb-browser-design.md`

**Context file:** 现有面板 `public/_panel/index.html`（725 行）。关键结构：
- CSS: `:root` 变量 → `.banner` → `.toolbar` → `.auth` → `.stats` → `.table-wrap` → `.colophon`
- HTML: `<header class="banner">` → `<div class="toolbar">` → `<section class="auth">` → `<section class="stats">` → `<div class="table-wrap">` → `<footer class="colophon">`
- JS: IIFE，变量区（$ helper / DOM refs / polling 状态）→ 工具函数 → render → fetch → tick → start/stopPolling → events → init

---

## File Structure

| 文件 | 操作 | 说明 |
|------|------|------|
| `public/_panel/index.html` | 修改 | ~+300 行（CSS ~80 + HTML ~20 + JS ~200） |

### 插入点定位

以下行号基于**当前文件**（725 行）。修改后行号会偏移，但任务中都用**插入点周围的可搜索固定文本**来定位：

| 区域 | 定位方式 | 插入位置 |
|------|----------|----------|
| CSS 新增 | 搜索 `::selection {` | 在其**之前**插入详情页样式 |
| HTML 新增 | 搜索 `<footer class="colophon">` | 在其**之前**插入 `#detail` 容器 |
| JS: DOM refs | 搜索 `btnRefresh = $("btn-refresh");` | 在其**之后**插入详情页 DOM refs |
| JS: render 函数簇 | 搜索 `function renderStats` | 在其**之后**插入详情页 render 函数 |
| JS: tick 修改 | 搜索 `async function tick()` | 在函数体开头加详情页判断 |
| JS: row 点击 | 搜索 `data-copy` | 修改 `<td class="id-cell">` 行为 |
| JS: visibilitychange | 搜索 `document.addEventListener("visibilitychange"` | 在其附近加 `onhashchange` 监听 |
| JS: init | 搜索 `if (polling) startPolling();` | 在其**之前**加 hash 路由初始化 |

---

### Task 1: 细化需求

- [ ] **Step 1: Add detail view CSS**

搜索 `::selection {`，在其**之前**插入以下内容：

```css
  /* ── Detail view ── */
  #detail { display: none; }
  body.detail-open #detail { display: block; }
  body.detail-open .table-wrap,
  body.detail-open .stats,
  body.detail-open .toolbar { display: none; }

  .d-header {
    border-bottom: 3px double var(--rule);
    border-top: 3px double var(--rule);
    padding: 0.9rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex-wrap: wrap;
  }
  .d-header .back {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding: 0.4rem 0.8rem;
    background: var(--ink);
    color: var(--paper);
    border: 1px solid var(--rule);
    cursor: pointer;
    white-space: nowrap;
  }
  .d-header .back:hover { background: var(--accent); border-color: var(--accent); }
  .d-header .info {
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.08em;
    display: flex;
    gap: 1.2rem;
    flex-wrap: wrap;
  }
  .d-header .info strong { color: var(--ink); font-weight: 700; }
  .d-header .info .dot {
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    margin-right: 0.3em;
  }
  .d-header .info .up .dot { background: var(--ok); }
  .d-header .info .down .dot { background: var(--err); }

  .d-body {
    display: grid;
    grid-template-columns: 260px 1fr;
    min-height: 400px;
  }
  @media (max-width: 720px) {
    .d-body { grid-template-columns: 1fr; }
  }
  .d-sidebar {
    border-right: 1px solid var(--rule);
    padding: 0.6rem 0;
    overflow-y: auto;
    max-height: calc(100vh - 160px);
  }
  @media (max-width: 720px) {
    .d-sidebar { border-right: none; border-bottom: 1px solid var(--rule); max-height: 30vh; }
  }
  .d-sidebar .col-item {
    display: block;
    padding: 0.5rem 1.2rem;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    cursor: pointer;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    transition: background 0.1s;
  }
  .d-sidebar .col-item:hover { background: var(--cell); }
  .d-sidebar .col-item.active { background: var(--cell-hot); font-weight: 700; }
  .d-sidebar .col-item .meta {
    display: block;
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.06em;
    margin-top: 0.15em;
  }

  .d-main {
    padding: 1.2rem 1.5rem;
    overflow-y: auto;
    max-height: calc(100vh - 160px);
  }
  .d-main .tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--rule);
    margin-bottom: 1rem;
  }
  .d-main .tabs button {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding: 0.5rem 1.2rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    cursor: pointer;
    margin-bottom: -2px;
  }
  .d-main .tabs button.active {
    color: var(--ink);
    border-bottom-color: var(--accent);
    font-weight: 700;
  }

  .d-main .schema-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 12px;
  }
  .d-main .schema-table th {
    text-align: left;
    padding: 0.5rem 0.6rem;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 700;
    border-bottom: 2px solid var(--rule);
    background: var(--cell);
  }
  .d-main .schema-table td {
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid rgba(10,10,10,0.08);
    vertical-align: top;
  }
  @media (prefers-color-scheme: dark) {
    .d-main .schema-table td { border-bottom-color: rgba(245,241,230,0.08); }
  }
  .d-main .rules-block {
    margin-top: 1rem;
    padding: 0.8rem;
    background: var(--cell);
    font-size: 11px;
    line-height: 1.6;
  }
  .d-main .rules-block b {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .d-main .rec-card {
    border: 1px solid var(--rule);
    margin-bottom: 0.8rem;
    padding: 0.8rem 1rem;
    font-size: 12px;
  }
  .d-main .rec-card .rec-meta {
    font-size: 10px;
    color: var(--muted);
    margin-bottom: 0.5rem;
  }
  .d-main .rec-field {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 0.4rem;
    padding: 0.25rem 0;
    border-bottom: 1px dotted rgba(10,10,10,0.08);
  }
  @media (prefers-color-scheme: dark) {
    .d-main .rec-field { border-bottom-color: rgba(245,241,230,0.08); }
  }
  .d-main .rec-field:last-child { border-bottom: none; }
  .d-main .rec-field .k {
    font-weight: 700;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .d-main .rec-field .v {
    word-break: break-all;
    white-space: pre-wrap;
    max-height: 4em;
    overflow: hidden;
    font-size: 12px;
  }

  .d-main .pager {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-top: 1rem;
    font-family: var(--mono);
    font-size: 11px;
  }
  .d-main .pager button {
    font: inherit;
    padding: 0.35rem 0.9rem;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--rule);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .d-main .pager button:hover { background: var(--ink); color: var(--paper); }
  .d-main .pager button:disabled { opacity: 0.3; cursor: default; }
  .d-main .pager span { color: var(--muted); }
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add detail view CSS for PB browser"
```

---

### Task 2: 实现步骤

- [ ] **Step 1: Add detail view HTML container**

搜索 `<footer class="colophon">`，在其**之前**插入：

```html
<div id="detail">
  <div class="d-header" id="d-header"></div>
  <div class="d-body">
    <nav class="d-sidebar" id="d-sidebar"></nav>
    <div class="d-main" id="d-main"></div>
  </div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add detail view HTML container"
```

---

### Task 3: 实现步骤

- [ ] **Step 1: Add detail view JS — DOM refs**

搜索 `btnRefresh = $("btn-refresh");`，在其**之后**插入：

```javascript
  // detail view DOM refs
  const detailEl = $("detail");
  const dHeaderEl = $("d-header");
  const dSidebarEl = $("d-sidebar");
  const dMainEl = $("d-main");
  let detailAppId = null;
  let detailApp = null;
  let detailToken = null; // { token, token_id }
  let detailCollections = [];
  let detailActiveCol = null; // 当前选中的 collection id
  let detailActiveTab = "schema"; // "schema" | "records"
  let detailRecordsPage = 1;
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add detail view JS state variables"
```

---

### Task 4: 实现步骤

- [ ] **Step 1: Add token lifecycle functions**

搜索 `function escapeHtml(s) {`，在其**之前**插入：

```javascript
  // ---------- token lifecycle ----------
  async function acquireToken(appId) {
    const mk = getMK();
    if (!mk) return null;
    try {
      const r = await fetch("/api/tokens", {
        method: "POST",
        headers: { "X-Master-Key": mk, "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.data ? { token: j.data.token, token_id: j.data.token_id } : null;
    } catch { return null; }
  }

  async function releaseToken() {
    if (!detailToken) return;
    const mk = getMK();
    if (!mk) return;
    try {
      await fetch(`/api/tokens/${encodeURIComponent(detailToken.token_id)}`, {
        method: "DELETE",
        headers: { "X-Master-Key": mk },
      });
    } catch {}
    detailToken = null;
  }
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add token lifecycle functions"
```

---

### Task 5: 实现步骤

- [ ] **Step 1: Add detail view data fetching functions**

搜索 `function fetchPbHealth(app) {`，在其**之前**插入：

```javascript
  async function fetchCollections(appId, token) {
    try {
      const r = await fetch(
        `/${encodeURIComponent(appId)}/api/collections`,
        { headers: { "Authorization": "Bearer " + token }, cache: "no-store" },
      );
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.items) ? j.items : [];
    } catch { return null; }
  }

  async function fetchCollectionSchema(appId, token, colId) {
    try {
      const r = await fetch(
        `/${encodeURIComponent(appId)}/api/collections/${encodeURIComponent(colId)}`,
        { headers: { "Authorization": "Bearer " + token }, cache: "no-store" },
      );
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function fetchCollectionRecords(appId, token, colId, page, perPage) {
    try {
      const qs = `?page=${page}&perPage=${perPage}`;
      const r = await fetch(
        `/${encodeURIComponent(appId)}/api/collections/${encodeURIComponent(colId)}/records${qs}`,
        { headers: { "Authorization": "Bearer " + token }, cache: "no-store" },
      );
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add detail view data fetching functions"
```

---

### Task 6: 实现步骤

- [ ] **Step 1: Add detail view rendering functions**

搜索 `function renderStats(apps, healthMap) {`，在其**之前**插入：

```javascript
  // ---------- detail view rendering ----------
  function renderDetailHeader(app) {
    dHeaderEl.innerHTML = `
      <button class="back" onclick="window.location.hash=''">← BACK</button>
      <div>
        <strong>${escapeHtml(app.name || app.id)}</strong>
        <span style="color:var(--muted);margin-left:0.5em">(${escapeHtml(app.id)})</span>
      </div>
      <div class="info">
        <span>type: <strong>${escapeHtml(app.type || "—")}</strong></span>
        <span>port: <strong>${app.port || "—"}</strong></span>
        <span id="d-pb-state">PB: …</span>
      </div>`;
  }

  function updateDetailPbState(up) {
    const el = document.getElementById("d-pb-state");
    if (!el) return;
    el.innerHTML = up
      ? `<span class="up"><span class="dot"></span>PB: up</span>`
      : `<span class="down"><span class="dot"></span>PB: down</span>`;
  }

  function renderCollectionsSidebar(collections) {
    dSidebarEl.innerHTML = collections.map((c) => {
      const active = detailActiveCol === c.id ? " active" : "";
      const type = c.type || "base";
      const fieldCount = Array.isArray(c.fields) ? c.fields.length : "—";
      return `<button class="col-item${active}" data-col-id="${escapeHtml(c.id)}">
        <span>${escapeHtml(c.name || c.id)}</span>
        <span class="meta">${escapeHtml(type)} · ${fieldCount} fields</span>
      </button>`;
    }).join("");
    if (collections.length === 0) {
      dSidebarEl.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:11px">No collections</div>`;
    }
    dSidebarEl.querySelectorAll(".col-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const colId = btn.getAttribute("data-col-id");
        selectCollection(colId);
      });
    });
  }

  function renderDetailTabs() {
    dMainEl.innerHTML = `
      <div class="tabs">
        <button id="tab-schema" class="${detailActiveTab === "schema" ? "active" : ""}" onclick="window._panelSwitchTab('schema')">Schema</button>
        <button id="tab-records" class="${detailActiveTab === "records" ? "active" : ""}" onclick="window._panelSwitchTab('records')">Records</button>
      </div>
      <div id="tab-content">Loading…</div>`;
  }

  function renderSchemaTab(schema) {
    const fields = Array.isArray(schema.fields) ? schema.fields : [];
    const rows = fields.map((f) => {
      const req = f.required ? "✓" : "—";
      const minmax = f.min != null || f.max != null ? `${f.min || 0}/${f.max || "∞"}` : "—";
      return `<tr>
        <td>${escapeHtml(f.name)}</td>
        <td>${escapeHtml(f.type)}</td>
        <td>${req}</td>
        <td>${minmax}</td>
        <td>${escapeHtml(String(f.required ?? "—"))}</td>
      </tr>`;
    }).join("");

    const rules = [
      { k: "listRule", v: schema.listRule },
      { k: "viewRule", v: schema.viewRule },
      { k: "createRule", v: schema.createRule },
      { k: "updateRule", v: schema.updateRule },
      { k: "deleteRule", v: schema.deleteRule },
    ];
    const rulesHtml = rules.map(({ k, v }) =>
      `<div>${escapeHtml(k)}: <code>${v === "" ? "(allow all)" : v === null ? "(deny)" : escapeHtml(String(v))}</code></div>`
    ).join("");

    const tabContent = document.getElementById("tab-content");
    if (!tabContent) return;
    tabContent.innerHTML = `
      <table class="schema-table">
        <thead><tr><th>Name</th><th>Type</th><th>Req</th><th>Min/Max</th><th>Rules</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="color:var(--muted)">No fields</td></tr>'}</tbody>
      </table>
      <div class="rules-block">
        <b>Collection Rules</b>
        ${rulesHtml}
      </div>`;
  }

  function renderRecordsTab(result) {
    const items = Array.isArray(result.items) ? result.items : [];
    const page = result.page || 1;
    const totalItems = result.totalItems || 0;
    const totalPages = result.totalPages || 1;
    const perPage = result.perPage || 20;

    if (items.length === 0) {
      const tabContent = document.getElementById("tab-content");
      if (tabContent) tabContent.innerHTML = `<div style="color:var(--muted);padding:2rem;text-align:center">No records</div>`;
      return;
    }

    const cards = items.map((rec) => {
      const metaHtml = rec.created
        ? `<div class="rec-meta">id: ${escapeHtml(rec.id)} · created: ${escapeHtml(rec.created)}${rec.updated ? " · updated: " + escapeHtml(rec.updated) : ""}</div>`
        : "";
      const fields = Object.entries(rec)
        .filter(([k]) => !["id", "collectionId", "collectionName", "created", "updated"].includes(k))
        .map(([k, v]) => {
          let display = v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
          if (display.length > 500) display = display.slice(0, 500) + "…";
          return `<div class="rec-field"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(display)}</span></div>`;
        }).join("");
      return `<div class="rec-card">${metaHtml}${fields}</div>`;
    }).join("");

    const prevDisabled = page <= 1 ? " disabled" : "";
    const nextDisabled = page >= totalPages ? " disabled" : "";
    const from = (page - 1) * perPage + 1;
    const to = Math.min(page * perPage, totalItems);

    const tabContent = document.getElementById("tab-content");
    if (!tabContent) return;
    tabContent.innerHTML = `
      ${cards}
      <div class="pager">
        <button${prevDisabled} onclick="window._panelPageRecords(${page - 1})">◀ Prev</button>
        <span>${from}–${to} of ${totalItems}</span>
        <button${nextDisabled} onclick="window._panelPageRecords(${page + 1})">Next ▶</button>
      </div>`;
  }

  function renderDetailError(msg) {
    dMainEl.innerHTML = `<div style="padding:2rem;color:var(--err);font-family:var(--mono)">${escapeHtml(msg)}</div>`;
  }
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add detail view rendering functions"
```

---

### Task 7: 实现步骤

- [ ] **Step 1: Add detail view lifecycle functions**

搜索 `function renderStats(apps, healthMap) {` 的**结束 `}`**，在其**之后（即 renderStats 和 setLive 之间）** 插入：

```javascript
  // ---------- detail view lifecycle ----------
  async function enterDetail(appId) {
    if (detailAppId === appId && detailToken) return; // already open

    // pause global polling
    stopPolling();
    setLive(false);

    detailAppId = appId;
    detailApp = lastApps.find((a) => a.id === appId) || null;
    detailCollections = [];
    detailActiveCol = null;
    detailActiveTab = "schema";
    detailRecordsPage = 1;

    document.body.classList.add("detail-open");

    if (!detailApp) {
      renderDetailError("App not found in cached list");
      return;
    }
    renderDetailHeader(detailApp);

    // acquire token
    if (!detailToken) {
      detailToken = await acquireToken(appId);
    }
    if (!detailToken) {
      renderDetailError("Failed to acquire platform token — check Master Key");
      return;
    }

    // check PB health
    const h = await fetchPbHealth(detailApp);
    updateDetailPbState(h.state === "up");

    // fetch collections
    const cols = await fetchCollections(appId, detailToken.token);
    if (cols === null) {
      renderDetailError("Failed to load collections — PB may be down");
      return;
    }
    detailCollections = cols;
    renderCollectionsSidebar(cols);
    dMainEl.innerHTML = `<div style="padding:2rem;color:var(--muted)">Select a collection from the sidebar</div>`;
  }

  async function leaveDetail() {
    await releaseToken();
    detailAppId = null;
    detailApp = null;
    detailCollections = [];
    detailActiveCol = null;
    detailToken = null;
    document.body.classList.remove("detail-open");
    // resume polling
    tick();
    if (polling) startPolling();
  }

  async function selectCollection(colId) {
    if (!detailToken || !detailAppId) return;
    detailActiveCol = colId;
    detailActiveTab = "schema";
    detailRecordsPage = 1;
    renderCollectionsSidebar(detailCollections);
    renderDetailTabs();

    // fetch schema
    const schema = await fetchCollectionSchema(detailAppId, detailToken.token, colId);
    if (!schema) {
      renderDetailError("Failed to load collection schema");
      return;
    }
    renderSchemaTab(schema);
  }

  async function switchTab(tab) {
    detailActiveTab = tab;
    const tabSchema = document.getElementById("tab-schema");
    const tabRecords = document.getElementById("tab-records");
    if (tabSchema) tabSchema.classList.toggle("active", tab === "schema");
    if (tabRecords) tabRecords.classList.toggle("active", tab === "records");

    if (!detailToken || !detailAppId || !detailActiveCol) return;
    if (tab === "schema") {
      const schema = await fetchCollectionSchema(detailAppId, detailToken.token, detailActiveCol);
      if (schema) renderSchemaTab(schema);
      else renderDetailError("Failed to load schema");
    } else {
      const result = await fetchCollectionRecords(detailAppId, detailToken.token, detailActiveCol, detailRecordsPage, 20);
      if (result) renderRecordsTab(result);
      else renderDetailError("Failed to load records");
    }
  }

  async function pageRecords(page) {
    detailRecordsPage = page;
    if (!detailToken || !detailAppId || !detailActiveCol) return;
    const result = await fetchCollectionRecords(detailAppId, detailToken.token, detailActiveCol, page, 20);
    if (result) renderRecordsTab(result);
    else renderDetailError("Failed to load records");
  }

  // expose for onclick handlers in HTML fragments
  window._panelSwitchTab = switchTab;
  window._panelPageRecords = pageRecords;
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add detail view lifecycle functions"
```

---

### Task 8: 实现步骤

- [ ] **Step 1: Modify tick() to skip when detail view is active**

搜索 `async function tick() {`，在其函数体第一行（`if (inflight) return;` 之前）插入：

```javascript
    if (detailAppId) return;
```

修改后的函数开头：

```javascript
  async function tick() {
    if (detailAppId) return;
    if (inflight) return;
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): skip global polling when detail view is active"
```

---

### Task 9: 实现步骤

- [ ] **Step 1: Modify App row click to navigate to detail view**

找到 `renderRows` 函数中 `<td class="id-cell" data-copy="...">` 这一行：

```html
        <td class="id-cell" data-copy="${escapeHtml(a.id)}">
          ${escapeHtml(a.id)}
          <span class="copied">copied</span>
        </td>
```

替换为：

```html
        <td class="id-cell" data-copy="${escapeHtml(a.id)}">
          <a href="#${escapeHtml(a.id)}" style="color:inherit;text-decoration:none;display:block">${escapeHtml(a.id)}</a>
          <span class="copied">copied</span>
        </td>
```

并将 ID 列 `<th>ID</th>` 改为 `<th style="width:140px">ID</th>` 保证列宽稳定。

**同时修改** renderRows 末尾的 click handler（`rowsEl.querySelectorAll(".id-cell")` 循环），确保 `<a>` 标签的默认行为（hash 导航）不被 `preventDefault` 阻止——实际上 `<a>` 的外层 `.id-cell` 的 click 事件中 `navigator.clipboard.writeText` 不会阻止 `<a>` 的默认行为，所以不影响。无需修改。

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): make App row clickable for detail view navigation"
```

---

### Task 10: 实现步骤

- [ ] **Step 1: Add hashchange event listener**

搜索 `document.addEventListener("visibilitychange"`，在其**之前**插入：

```javascript
  // hash routing for detail view
  function handleHash() {
    const hash = location.hash.replace(/^#/, "");
    if (hash) {
      // entered detail view
      enterDetail(hash);
    } else if (detailAppId) {
      // returned from detail view
      leaveDetail();
    }
  }
  window.addEventListener("hashchange", handleHash);
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): add hash routing handler"
```

---

### Task 11: 实现步骤

- [ ] **Step 1: Initialize hash routing on page load**

搜索 `if (polling) startPolling();`，在其**之前**插入：

```javascript
  // initialize detail view on page load (if hash present)
  handleHash();
```

- [ ] **Step 2: Commit**

```bash
git add public/_panel/index.html
git commit -m "feat(panel): initialize hash routing on page load"
```

---

### Task 12: 实现步骤

- [ ] **Step 1: End-to-end verification**

手动验证以下场景：

```bash
# 确保平台在运行
curl -s http://localhost:3456/health

# 创建两个 App（一个 pocketbase，一个 custom+enable_pb）
APP1=$(curl -s -X POST http://localhost:3456/api/apps \
  -H "X-Master-Key: 11111" -H "Content-Type: application/json" \
  -d '{"name":"panel-test-1"}' | jq -r '.data.id')

APP2=$(curl -s -X POST http://localhost:3456/api/apps \
  -H "X-Master-Key: 11111" -H "Content-Type: application/json" \
  -d '{"name":"panel-test-2","type":"custom","enable_pb":true}' | jq -r '.data.id')

# 为 APP1 创建 collection + 插入 records（通过 token）
TOKEN1=$(curl -s -X POST http://localhost:3456/api/tokens \
  -H "X-Master-Key: 11111" -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$APP1\"}" | jq -r '.data.token')

curl -s -X POST "http://localhost:3456/$APP1/api/collections" \
  -H "Authorization: Bearer $TOKEN1" -H "Content-Type: application/json" \
  -d '{"name":"notes","type":"base","fields":[{"name":"title","type":"text","required":true},{"name":"body","type":"text","required":false}],"listRule":"","viewRule":"","createRule":null,"updateRule":null,"deleteRule":null}'

curl -s -X POST "http://localhost:3456/$APP1/api/collections/notes/records" \
  -H "Authorization: Bearer $TOKEN1" -H "Content-Type: application/json" \
  -d '{"title":"hello","body":"world"}'
```

然后浏览器打开 `http://localhost:3456/`：

1. 输入 Master Key (`11111`) → SAVE
2. 确认两个 App 都出现在列表中
3. 点击 APP1 的 ID → 进入详情页
4. 验证：
   - Header 显示 App 名称、ID、type、port、PB up/down
   - 左侧 sidebar 列出 collections（应该看到 `notes` + 系统 tables）
   - 点击 `notes` → Schema 标签页显示 title/text 字段
   - 切换到 Records 标签页 → 看到 "hello/world" 记录
5. 点击 ← BACK → 确认回到 App 列表
6. 再次点击 APP1 → 确认 token 缓存工作（不重复创建）
7. 点击 APP2（custom+enable_pb）→ 确认 PB 状态显示
8. 在详情页中按浏览器后退键 → 确认 hashchange 事件触发返回列表

- [ ] **Step 2: Commit (if any fixes)**

```bash
git add public/_panel/index.html
git commit -m "fix(panel): e2e verification fixes"
```

---

## Spec Coverage Check

| Spec Section | Covered By |
|--------------|------------|
| 4.1 路由结构 | Tasks 10-11 (hashchange + init) |
| 4.2 详情页 UI | Tasks 1 (CSS) + 2 (HTML) + 6 (render) + 7 (lifecycle) |
| 4.3 数据流 | Tasks 4 (token) + 5 (fetch) + 7 (lifecycle) |
| 4.4 Token 缓存 | Tasks 4 (acquireToken/releaseToken) + 7 (enterDetail/leaveDetail) |
| 6. 错误处理 | Tasks 6 (renderDetailError) + 7 (enterDetail error paths) |
| 7. 测试策略 | Task 12 (e2e verification) |

## Placeholder Self-Review

- [x] No TBD/TODO in code blocks
- [x] All CSS selectors reference classes used in HTML
- [x] All DOM IDs referenced in JS exist in HTML
- [x] All function signatures are consistent across tasks
- [x] `switchTab` and `pageRecords` exposed on `window._panel*` for onclick handlers
- [x] `detailToken` lifecycle: created in `enterDetail` → cached → released in `leaveDetail`
- [x] Hash routing: `handleHash()` called on `hashchange` + on init
