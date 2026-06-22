# 子路径前端资源自动改写 shim：平台兜底容错

**日期**: 2026-06-19
**状态**: Draft

---

## 一、目标

agent-sites 把每个站点挂在 `/sites/{uuid}/` 子路径下。前端代码如果用绝对路径（`fetch("/api/x")`、`<a href="/login">` 等），浏览器会把它解析到平台根，命中 agent-sites 自己的 API 或 404，而不是该站点的资源。

这是子路径 SPA 部署最常见的坑。`agent-sites-deploy` skill 已记录规则，但人工遵循不可靠。

**本设计目标**：平台在 serve HTML 时自动注入一段前端 shim，patch 浏览器所有出口（fetch / XHR / WebSocket / 静态资源 src/href / 导航），把白名单外的绝对路径自动改写到当前站点的 `/sites/{uuid}/` 前缀下。让忘了用相对路径的前端代码也能正常跑起来。

**非目标**：

- 不覆盖 Service Worker 内的 fetch（进阶用法，文档说明）
- 不处理 CSP 禁止 inline 的场景（用户 CSP 是用户的责任）
- 不引入 HTML 解析依赖（用字符串查找定位 `<head>`）
- 不引入打包工具集成（Vite base、webpack publicPath 等是用户侧的事）
- 不改变现有 portal.html（portal 走 `/portal` 路由，不经过 `serve_site_file`，不受影响）

---

## 二、设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 目标定位 | 平台兜底容错（保险丝） | 用户/Agent 写错时兜底；不是鼓励用法 |
| 注入方式 | 平台自动 inline 注入 | 用户零感知；后端单点改造 |
| 覆盖范围 | fetch / XHR / WebSocket / 静态资源 / 导航（全部） | 兜底要彻底，半覆盖反而留下坑 |
| 开关机制 | 默认开 + runtime 配置可 opt-out | 保险丝默认随身带 |
| 路径识别 | 白名单平台路径，其他全改写 | 平台路径是已知少数；其他都应是站点资源 |
| CSP 处理 | 不处理（用户责任） | 简化设计；CSP 禁止 inline 是用户的明确意图 |
| `<base href>` | 不支持 | YAGNI；多数站点不用 |
| Service Worker | 不覆盖 | 进阶用法，文档说明 |

---

## 三、总体架构

```
浏览器加载 /sites/abc/index.html
   ↓
后端 serve_site_file 检测：是 html + 站点开启 shim
   ↓
读文件 → inject_shim(html, "abc") 在 <head> 后插入 inline <script>
   ↓
浏览器执行 shim → patch 全局 API（fetch/XHR/WS/Location/History）
                + 注册 MutationObserver 监听 DOM 属性变化
   ↓
应用代码 fetch("/api/users")
   ↓
shim 拦截 → 白名单判断 → 改写到 /sites/abc/api/users
   ↓
浏览器发请求 → 命中 axum 反向代理 → 转发到 Deno
```

### 模块边界

| 单元 | 职责 | 接口 |
|------|------|------|
| `shim.js`（前端） | 浏览器侧 patch 逻辑，零依赖 | 自执行；读取注入的 `window.__SITE_SHIM__ = { uuid, whitelist }` |
| `inject_shim`（后端） | 把 shim 注入 HTML 字符流 | `fn(html: &str, uuid: &str) -> String` |
| `serve_site_file`（已有） | 在 serve `.html` 时调 inject_shim；其他文件不变 | 加 content-type + 配置分支 |
| `runtime` 配置 | 新增 `inject_path_shim: bool`（默认 true） | 复用 `PUT /api/sites/{id}/runtime` |

每个单元可独立测试：shim.js 用 Deno test；inject_shim 用 cargo test；serve_site_file 用 axum oneshot 集成测试。

---

## 四、路径识别规则

### 4.1 输入分类

shim 拦截到的 URL 按类型分流：

| 输入形态 | 处理 |
|---------|------|
| `https://...` / `http://...`（完整 URL） | host 同源才进入下一步，跨源放过 |
| `//cdn.example.com/x.js`（protocol-relative） | 跨源，放过 |
| `data:` / `blob:` / `mailto:` / `tel:` | 非 http(s)，放过 |
| `api/users` / `./api/users` / `../api/users` | 相对路径，浏览器已正确解析，**不改写** |
| `/api/users`（绝对路径，**核心靶子**） | 进入白名单判断 |
| `/`（裸根） | 当作白名单，放过 |

### 4.2 白名单（不改写）

平台保留路径前缀：

```js
const WHITELIST = [
  "/api/",      // 平台 API
  "/sites/",    // 跨站点引用
  "/portal",    // 门户页
  "/health",    // 健康检查
  "/"           // 裸根
];
```

**`/api/` 在白名单的理由**：平台的 `/api/sites` 等是给 portal / 外部工具用的。站点代码如果真的访问 `/api/foo`，意图是访问**它自己的** API（应该用相对路径 `api/foo`）。保险丝层面我们按字面意图放过，让用户看到 404 而非"魔法"地命中小概率路径。

### 4.3 改写公式

对于「以 `/` 开头 + 不在白名单」的路径：

```
原始:  /foo/bar?x=1#hash
改写:  /sites/{uuid}/foo/bar?x=1#hash
```

在原 path 前插入 `/sites/{uuid}`，保留 query 和 hash。

**深层子页面的语义**：站点页面在 `/sites/abc/sub/page.html`，代码 `fetch("/api/x")`，改写目标是 `/sites/abc/api/x`（**站点根**），而不是 `/sites/abc/sub/api/x`。shim 始终从站点根算，不跟随当前子路径。

### 4.4 边界 case

| 情况 | 处理 |
|------|------|
| `fetch("/api/foo")` | 白名单 → 不改写 → 落到平台 `/api/foo`（大概率 404） |
| `fetch("/foo")` | 改写到 `/sites/{uuid}/foo` |
| `fetch("/sites/abc/foo")`（自己根资源） | 白名单 `/sites/` → 不改写 |
| `fetch("/sites/xyz/foo")`（跨站引用） | 同上不改写 |
| `<a href="/">`（回首页） | `/` 白名单 → 不改写 |
| `<a href="/about">` | 改写到 `/sites/{uuid}/about` |
| `new WebSocket("ws://host/api/ws")` | 同源 → path `/api/ws` 在白名单 → 不改写 |
| `new WebSocket("/ws")` | 改写为 `/sites/{uuid}/ws` |
| `window.location.href = "/login"` | 拦截 setter → 改写到 `/sites/{uuid}/login` |
| `history.pushState({}, "", "/dashboard")` | 同上 |

### 4.5 失败处理

- 改写后 URL 命中 404：不重试，让浏览器正常返回 404 给应用（保持透明的"就像它本来就这么写"语义）
- 改写时 console 打印 `console.warn("[shim] 重写 %s → %s", from, to)`，便于调试；可通过注入的 `silent: true` 关闭

---

## 五、shim.js 实现要点

### 5.1 加载时机

shim 必须在任何应用代码之前执行。后端注入位置是 **`<head>` 开标签之后、原 head 内容之前**（即 `<head>...` 的 `>` 之后立即插入）：

```html
<!doctype html>
<html>
<head><script>window.__SITE_SHIM__ = { uuid: "abc", silent: false }; /* SHIM */</script>
<title>原页面</title>
<link rel="stylesheet" href="...">  ← 此时 shim 已生效
```

### 5.2 各类拦截实现

**fetch**：

```js
const origFetch = window.fetch;
window.fetch = function(input, init) {
  const url = typeof input === "string" ? input : input.url;
  const rewritten = rewriteUrl(url);
  if (typeof input === "string") {
    return origFetch.call(this, rewritten, init);
  }
  // Request 对象：构造新的 Request
  return origFetch.call(this, new Request(rewritten, input), init);
};
```

**XMLHttpRequest**：

```js
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  return origOpen.call(this, method, rewriteUrl(url), ...rest);
};
```

**WebSocket**：

```js
const OrigWS = window.WebSocket;
class PatchedWS extends OrigWS {
  constructor(url, protocols) {
    super(rewriteUrl(url, { ws: true }), protocols);
  }
}
window.WebSocket = PatchedWS;
```

**静态资源（img/link/script/iframe/audio/video/source/a/form）**：

两层机制叠加：

1. **MutationObserver**：监听整个 document 的 childList + attributes 变化
2. **启动扫描**：`DOMContentLoaded` 后扫已有节点

```js
const REACTIVE_ATTRS = ["src", "href"];
const REACTIVE_TAGS = new Set([
  "IMG","LINK","SCRIPT","IFRAME","AUDIO","VIDEO","SOURCE","A","FORM"
]);

let isRewriting = false;  // 防重入标志

function rewriteAttr(el, attr) {
  if (isRewriting) return;
  const val = el.getAttribute(attr);
  if (!val) return;
  const rewritten = rewriteUrl(val);
  if (rewritten !== val) {
    isRewriting = true;
    el.setAttribute(attr, rewritten);
    isRewriting = false;
  }
}

new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "attributes") {
      rewriteAttr(m.target, m.attributeName);
    } else {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) scanNode(n);
      }
    }
  }
}).observe(document.documentElement, {
  subtree: true, childList: true, attributes: true,
  attributeFilter: REACTIVE_ATTRS
});
```

**导航：`window.location` 与 `history`**：

```js
const origPush = history.pushState;
history.pushState = function(state, title, url) {
  return origPush.call(this, state, title, url && rewriteUrl(url));
};
// 同理 patch replaceState

// window.location.href/assign/replace 的 patch 略
```

### 5.3 关键陷阱

| 陷阱 | 应对 |
|------|------|
| shim 执行时 DOM 还在解析中 | patch 全局 API（同步）；DOM 扫描等 DOMContentLoaded |
| 改写 attr 触发 observer 死循环 | `isRewriting` 标志位防重入 |
| `<base href>` 存在会改变相对路径基准 | 不支持（YAGNI），文档说明 |
| Service Worker fetch 不受影响 | 不覆盖，文档说明 |
| CSP `script-src` 禁止 inline | 不处理，用户责任 |

### 5.4 体积目标

- 源码 < 5KB（未压缩）
- minified + gzipped < 2KB
- 零依赖

---

## 六、后端注入实现

### 6.1 新增模块 `crates/server/src/routing/shim.rs`

```rust
pub const SHIM_JS: &str = include_str!("shim.js");  // 编译期嵌入

/// 把 shim 注入 HTML 字符流，紧贴 <head> 开标签之后；无 <head> 则插到文档最前
pub fn inject_shim(html: &str, uuid: &str) -> String {
    // 1. 检查是否已注入（防重复）
    if html.contains("__SHIM_INJECTED__") {
        return html.to_string();
    }
    // 2. 把 uuid 填入模板（替换占位符 __SITE_UUID__）
    let script = format!(
        "<script>window.__SITE_SHIM__={{uuid:\"{}\",silent:false}}__SHIM_INJECTED__=1;</script>",
        uuid
    );
    // 3. 大小写不敏感找 <head...>，定位第一个 >
    // 4. 紧贴 > 后插入 script
    // 5. 找不到 <head> 则插到文档最前
}
```

关键约束：
- **不引入 HTML 解析器**（避免新依赖）
- **大小写不敏感**匹配 `<head` / `<HEAD` / `<Head`
- **避免重复注入**：检查 `__SHIM_INJECTED__` 标记

### 6.2 `serve_site_file` 改造

```rust
let data = tokio::fs::read(&canonical).await.map_err(|_| AppError::NotFound)?;
let content_type = mime_guess::from_path(&canonical).first_or_octet_stream().to_string();

let final_data = if content_type.contains("text/html") && site.inject_path_shim {
    let html = String::from_utf8_lossy(&data);
    shim::inject_shim(&html, &site_id).into_bytes()
} else {
    data
};

Ok(([...], final_data))
```

### 6.3 性能与缓存

- HTML 注入是字符串操作，对 100KB 页面耗时 < 1ms；每次 serve 都做
- 短期：直接做（YAGNI）
- 长期：如果性能成问题，加内存 LRU 缓存（key = `(site_id, version_id, 文件 mtime)`）
- **Cache-Control / ETag**：注入后内容变了，不能用原文件的 ETag。**HTML 文件不发 ETag**（简化）

### 6.4 runtime 配置

DB 迁移：

```sql
ALTER TABLE sites ADD COLUMN inject_path_shim INTEGER NOT NULL DEFAULT 1;
```

- `Site` 结构体加字段 `pub inject_path_shim: bool`
- `get_site` / `list_sites` SQL 加列
- `PUT /api/sites/{id}/runtime` 接受 `{ inject_path_shim: bool }`
- skill 文档补一条

---

## 七、测试策略

| 层级 | 测试内容 | 工具 |
|------|---------|------|
| 单元：`inject_shim` | 各种 HTML 形态（标准 / 无 head / 大小写 / 已注入） | `cargo test` |
| 单元：`shim.js` 逻辑 | 路径识别、白名单、各类拦截 | Deno test（项目已装 deno） |
| 集成：`serve_site_file` | html 被注入 / 非 html 不动 / opt-out 后不注入 | `cargo test`（axum oneshot） |
| E2E：真实浏览器 | 部署用绝对路径的 demo 站点，浏览器打开验证改写 | 手动 + 可选 Playwright |

shim 的 Deno test 例子：

```ts
// shim_test.ts
import { rewriteUrl } from "./shim.ts";
Deno.test("/api/foo 在白名单 → 不改写", () => {
  assertEquals(rewriteUrl("/api/foo", "abc"), "/api/foo");
});
Deno.test("/dashboard 不在白名单 → 改写", () => {
  assertEquals(rewriteUrl("/dashboard", "abc"), "/sites/abc/dashboard");
});
```

---

## 八、部署清单

- [ ] 新增 `crates/server/src/routing/shim.js`（前端 shim 源码 + Deno test）
- [ ] 新增 `crates/server/src/routing/shim.rs`（`SHIM_JS` 常量 + `inject_shim` 函数 + 单元测试）
- [ ] 改 `routing/mod.rs::serve_site_file`（分支判断 + 调 inject）
- [ ] DB 迁移加 `inject_path_shim` 列（`crates/server/migrations/`）
- [ ] `db/models.rs` Site 结构 + get/list SQL + update_runtime
- [ ] `api/sites.rs::update_runtime` 接受新字段
- [ ] skill 文档补一节（如何 opt-out、限制说明）
- [ ] cargo test + deno test 全绿

---

## 九、Alternatives Considered

| 方案 | 为何不选 |
|------|---------|
| **用户提供 shim + 打包工具注入** | 依赖人工，都会忘；与"平台兜底"目标矛盾 |
| **黑名单只改写 `/api/` 等** | 遗漏面大；静态资源、导航都漏 |
| **平台默认关 + opt-in** | 保险丝默认不带，违背"兜底"语义 |
| **CSP 降级外链 `/__shim__/{uuid}.js`** | 多一条路由、多一份文件、复杂度增加；用户禁止 inline 是明确意图 |
| **支持 `<base href>`** | YAGNI；多数站点不用 |
| **覆盖 Service Worker** | 进阶用法；不影响主流场景 |
| **后端反向代理层 Referer 重写** | 依赖 Referer 不可靠；平台 `/api/sites` 会被错误重写 |
