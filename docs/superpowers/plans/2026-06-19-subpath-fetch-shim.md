# 子路径前端资源自动改写 shim 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agent-sites 平台 serve 站点 HTML 时自动注入一段 inline JS shim，把前端代码里白名单外的绝对路径改写到 `/sites/{uuid}/` 下，让忘了用相对路径的前端代码也能跑起来。

**Architecture:** 前端 shim（`shim.js`）由后端 `include_str!` 编译期嵌入，serve `.html` 文件时通过 `inject_shim()` 函数字符串注入到 `<head>` 之后。开关由 `sites.inject_path_shim` 字段控制（默认 true，可通过 runtime API opt-out）。核心改写规则抽出为纯函数 `rewriteUrl`，由 Deno test 覆盖；DOM patch 逻辑靠 E2E 验证。

**Tech Stack:** Rust + axum + sqlx（已有） | 前端 shim 为纯 JS IIFE | Deno test 测纯函数 | SQLite 迁移

**Spec:** `docs/superpowers/specs/2026-06-19-subpath-fetch-shim-design.md`

---

## 文件结构

新建：
- `crates/server/src/routing/shim.js` — 前端 shim 源码（IIFE，纯 JS）
- `crates/server/src/routing/shim.rs` — Rust 端 `SHIM_JS` 常量 + `inject_shim` 函数
- `crates/server/src/routing/shim_test.rs` — `inject_shim` 的 cargo 单元测试
- `crates/server/migrations/20260619000006_add_inject_path_shim.sql` — DB 迁移
- `deno.json`（项目根） — Deno test 配置（测 shim.js）
- `tests/shim/shim_test.ts` — shim.js 的 Deno test（项目根 tests/ 目录）

修改：
- `crates/server/src/routing/mod.rs` — `serve_site_file` 加 html 检测 + 调 inject
- `crates/server/src/db/models.rs` — Site 加 `inject_path_shim` 字段 + SQL
- `crates/server/src/api/sites.rs` — `UpdateRuntimeInput` 加新字段
- `.claude/skills/agent-sites-deploy/SKILL.md` — 文档补充

---

## Task 1: 前端 shim 核心纯函数 rewriteUrl + Deno test

**Files:**
- Create: `crates/server/src/routing/shim.js`
- Create: `deno.json`
- Create: `tests/shim/shim_test.ts`

- [ ] **Step 1: 创建 deno.json（项目根，最小配置）**

```json
{
  "tasks": {
    "test:shim": "deno test --allow-read tests/shim/"
  },
  "test": {
    "include": ["tests/shim/"]
  }
}
```

- [ ] **Step 2: 写 shim.js 初版（只含纯函数 + globalThis 暴露）**

`crates/server/src/routing/shim.js`：

```js
// agent-sites 子路径前端资源自动改写 shim
// 平台在 serve *.html 时把此文件 include_str! 后注入 <head> 之后。
//
// 后端 inject_shim 会先注入 window.__SITE_SHIM_CONFIG__ = {uuid, silent}；
// 本文件读该 config 进行 patch。这是与 spec 的细微偏离：spec 用单个
// __SITE_SHIM__ 同时承载配置和 API；计划拆成两个 —— __SITE_SHIM_CONFIG__
// （运行时配置，由后端注入）+ __SITE_SHIM__（测试 API，由本文件导出）。
// 拆分理由：测试环境（Deno）无后端注入，需要直接调用 rewriteUrl 而
// 不应被 cfg.uuid 缺失阻塞。
//
// DOM patch 逻辑只在浏览器环境执行（typeof window !== "undefined"）。

var __SITE_SHIM__ = (function () {
  // 平台保留路径前缀：以这些开头的绝对路径不改写
  var WHITELIST = ["/api/", "/sites/", "/portal", "/health", "/"];

  function startsWithAny(s, prefixes) {
    for (var i = 0; i < prefixes.length; i++) {
      if (s === prefixes[i]) return true;
      if (s.indexOf(prefixes[i]) === 0) return true;
    }
    return false;
  }

  // 判断 URL 是否需要改写，返回改写后的字符串（不需要改则原样返回）
  // url: 任意 URL 字符串（绝对 / 相对 / 完整 URL）
  // uuid: 当前站点 id
  // opts: { ws: true 表示 ws/wss 协议下也算同源 }
  function rewriteUrl(url, uuid, opts) {
    opts = opts || {};
    if (!url || typeof url !== "string") return url;

    // 协议 URL：data/blob/mailto/tel 直接放过
    if (/^(data:|blob:|mailto:|tel:|javascript:)/i.test(url)) return url;

    // http(s):// 或 // 开头：跨源判断
    var match = /^([a-z]+:\/\/)?\/\/([^\/]+)(\/.*)?$/i.exec(url)
             || /^([a-z]+):\/\/([^\/]+)(\/.*)?$/i.exec(url);
    if (match) {
      var host = match[2];
      // 跨源（host 与当前页不同）→ 不改写
      if (typeof window !== "undefined" && host && window.location.host !== host) {
        return url;
      }
      // 同源：取 path 部分递归处理
      var rest = match[3] || "/";
      var rewritten = rewritePath(rest, uuid);
      if (rewritten === rest) return url;
      // 重组（保留协议和 host）
      var proto = match[1] || (opts.ws ? "ws://" : "//");
      return proto + host + rewritten;
    }

    // 绝对路径：交给 rewritePath
    if (url.charAt(0) === "/") {
      return rewritePath(url, uuid);
    }

    // 相对路径：不改写（浏览器已正确解析到子路径下）
    return url;
  }

  // 处理绝对路径（以 / 开头），返回改写后的 path（含 query/hash）
  function rewritePath(path, uuid) {
    // 拆出 query/hash
    var qIdx = path.indexOf("?");
    var hIdx = path.indexOf("#");
    var endIdx = path.length;
    if (qIdx >= 0 && qIdx < endIdx) endIdx = qIdx;
    if (hIdx >= 0 && hIdx < endIdx) endIdx = hIdx;
    var pure = path.substring(0, endIdx);
    var tail = path.substring(endIdx);

    // 白名单：不改写
    if (startsWithAny(pure, WHITELIST)) return path;

    // 改写：在前面插入 /sites/{uuid}
    return "/sites/" + uuid + pure + tail;
  }

  return {
    rewriteUrl: rewriteUrl,
    rewritePath: rewritePath,
    WHITELIST: WHITELIST,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.__SITE_SHIM__ = __SITE_SHIM__;
}
```

- [ ] **Step 3: 写 Deno test**

`tests/shim/shim_test.ts`：

```ts
// 通过 import "./shim.js" 触发顶层 IIFE 执行，把 __SITE_SHIM__ 挂到 globalThis
import "../../crates/server/src/routing/shim.js";
import { assertEquals } from "jsr:@std/assert@1";

const { rewriteUrl, rewritePath } = (globalThis as any).__SITE_SHIM;

Deno.test("rewriteUrl: 绝对路径 /dashboard 改写", () => {
  assertEquals(rewriteUrl("/dashboard", "abc"), "/sites/abc/dashboard");
});

Deno.test("rewriteUrl: 保留 query 和 hash", () => {
  assertEquals(rewriteUrl("/foo?x=1#h", "abc"), "/sites/abc/foo?x=1#h");
});

Deno.test("rewriteUrl: 白名单 /api/ 不改写", () => {
  assertEquals(rewriteUrl("/api/foo", "abc"), "/api/foo");
});

Deno.test("rewriteUrl: 白名单 /sites/ 不改写（跨站引用）", () => {
  assertEquals(rewriteUrl("/sites/xyz/foo", "abc"), "/sites/xyz/foo");
});

Deno.test("rewriteUrl: 白名单 /portal 不改写", () => {
  assertEquals(rewriteUrl("/portal", "abc"), "/portal");
});

Deno.test("rewriteUrl: 白名单 /health 不改写", () => {
  assertEquals(rewriteUrl("/health", "abc"), "/health");
});

Deno.test("rewriteUrl: 裸根 / 不改写", () => {
  assertEquals(rewriteUrl("/", "abc"), "/");
});

Deno.test("rewriteUrl: 相对路径不改写", () => {
  assertEquals(rewriteUrl("api/foo", "abc"), "api/foo");
  assertEquals(rewriteUrl("./api/foo", "abc"), "./api/foo");
  assertEquals(rewriteUrl("../foo", "abc"), "../foo");
});

Deno.test("rewriteUrl: data/blob 协议放过", () => {
  assertEquals(rewriteUrl("data:text/plain,hello", "abc"), "data:text/plain,hello");
  assertEquals(rewriteUrl("blob:https://example.com/uuid", "abc"), "blob:https://example.com/uuid");
});

Deno.test("rewriteUrl: 跨源完整 URL 放过", () => {
  // Deno 无 window.location，所以同源判断跳过、直接当跨源放过
  assertEquals(
    rewriteUrl("https://cdn.example.com/lib.js", "abc"),
    "https://cdn.example.com/lib.js"
  );
});
```

- [ ] **Step 4: 跑 test，确认通过**

Run: `deno test --allow-read tests/shim/`
Expected: 10 tests passed

- [ ] **Step 5: 提交**

```bash
git add crates/server/src/routing/shim.js deno.json tests/shim/
git commit -m "$(cat <<'EOF'
feat(shim): 前端 shim 核心纯函数 rewriteUrl + Deno test

实现白名单平台路径外的绝对路径改写到 /sites/{uuid}/ 下。
跨源 URL / data:blob: / 相对路径不改写。
patch 逻辑（fetch/XHR/WS/DOM）下一 task 补。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 2: shim.js 加入 patch 逻辑（fetch / XHR / WebSocket / DOM / 导航）

**Files:**
- Modify: `crates/server/src/routing/shim.js`

- [ ] **Step 1: 在 shim.js 的 IIFE 内、`return` 之前插入 patch 逻辑**

把 IIFE 末尾的 `return { ... }` 之前插入以下代码块：

```js
  // ── DOM patch（仅浏览器环境）─────────────────────────────
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { rewriteUrl: rewriteUrl, rewritePath: rewritePath, WHITELIST: WHITELIST };
  }

  // 注入的配置（由后端 inject 时填入 window.__SITE_SHIM__）
  var cfg = (window.__SITE_SHIM_CONFIG__ = window.__SITE_SHIM_CONFIG__ || {});
  var uuid = cfg.uuid;
  var silent = cfg.silent || false;

  function warn(from, to) {
    if (!silent && typeof console !== "undefined" && console.warn) {
      try { console.warn("[shim] 重写 %s → %s", from, to); } catch (e) {}
    }
  }

  function rewrite(url, opts) {
    var r = rewriteUrl(url, uuid, opts);
    if (r !== url) warn(url, r);
    return r;
  }

  // fetch
  if (typeof fetch !== "undefined") {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string") {
          return origFetch.call(this, rewrite(input), init);
        }
        if (input && typeof input === "object" && "url" in input) {
          var newReq = new (input.constructor || Request)(rewrite(input.url), input);
          return origFetch.call(this, newReq, init);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest !== "undefined") {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = rewrite(url);
      return origOpen.apply(this, args);
    };
  }

  // WebSocket
  if (typeof WebSocket !== "undefined") {
    var OrigWS = window.WebSocket;
    function PatchedWS(url, protocols) {
      var rewritten = rewrite(url, { ws: true });
      if (protocols !== undefined) {
        return new OrigWS(rewritten, protocols);
      }
      return new OrigWS(rewritten);
    }
    PatchedWS.prototype = OrigWS.prototype;
    PatchedWS.CONNECTING = OrigWS.CONNECTING;
    PatchedWS.OPEN = OrigWS.OPEN;
    PatchedWS.CLOSING = OrigWS.CLOSING;
    PatchedWS.CLOSED = OrigWS.CLOSED;
    window.WebSocket = PatchedWS;
  }

  // History API
  if (typeof history !== "undefined") {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function (state, title, url) {
      return origPush.call(this, state, title, url ? rewrite(url) : url);
    };
    history.replaceState = function (state, title, url) {
      return origReplace.call(this, state, title, url ? rewrite(url) : url);
    };
  }

  // window.location.href/assign/replace setter 拦截
  if (typeof Location !== "undefined") {
    var origAssign = Location.prototype.assign;
    var origReplace = Location.prototype.replace;
    Location.prototype.assign = function (url) { return origAssign.call(this, rewrite(url)); };
    Location.prototype.replace = function (url) { return origReplace.call(this, rewrite(url)); };
    try {
      var locDesc = Object.getOwnPropertyDescriptor(Location.prototype, "href");
      if (locDesc && locDesc.set) {
        Object.defineProperty(Location.prototype, "href", {
          configurable: true,
          enumerable: locDesc.enumerable,
          get: locDesc.get,
          set: function (url) { locDesc.set.call(this, rewrite(url)); },
        });
      }
    } catch (e) {}
  }

  // 静态资源（src/href）+ <a>/<form> 通过 MutationObserver
  var REACTIVE_ATTRS = ["src", "href", "action"];
  var REACTIVE_TAGS = {
    IMG: "src", LINK: "href", SCRIPT: "src", IFRAME: "src",
    AUDIO: "src", VIDEO: "src", SOURCE: "src",
    A: "href", FORM: "action", INPUT: "formaction", BUTTON: "formaction",
  };
  var isRewriting = false;

  function rewriteAttr(el, attr) {
    if (isRewriting) return;
    if (!el || !el.tagName) return;
    var val = el.getAttribute(attr);
    if (!val) return;
    var r = rewrite(val);
    if (r !== val) {
      isRewriting = true;
      try { el.setAttribute(attr, r); } catch (e) {}
      isRewriting = false;
    }
  }

  function scanNode(node) {
    if (!node || node.nodeType !== 1) return;
    var primary = REACTIVE_TAGS[node.tagName];
    if (primary) rewriteAttr(node, primary);
    // 扫描所有 reactive 属性（兜底）
    for (var i = 0; i < REACTIVE_ATTRS.length; i++) {
      if (node.hasAttribute && node.hasAttribute(REACTIVE_ATTRS[i])) {
        rewriteAttr(node, REACTIVE_ATTRS[i]);
      }
    }
    var children = node.children;
    if (children) {
      for (var j = 0; j < children.length; j++) scanNode(children[j]);
    }
  }

  function installObserver() {
    if (typeof MutationObserver === "undefined") return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "attributes") {
          rewriteAttr(m.target, m.attributeName);
        } else {
          for (var j = 0; j < m.addedNodes.length; j++) {
            scanNode(m.addedNodes[j]);
          }
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: REACTIVE_ATTRS,
    });

    // 扫描已有节点
    scanNode(document.documentElement);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installObserver);
  } else {
    installObserver();
  }
```

注意：非浏览器环境（Deno test）会走前面的早 return 分支，不执行以上 patch。

修改 IIFE 的 return 语句：

```js
  return {
    rewriteUrl: rewriteUrl,
    rewritePath: rewritePath,
    WHITELIST: WHITELIST,
  };
```

放在 patch 块**之前**（非浏览器环境直接 return，不进入 patch）。

- [ ] **Step 2: 跑 Deno test 确认纯函数逻辑没被破坏**

Run: `deno test --allow-read tests/shim/`
Expected: 10 tests passed（Deno 无 window，走早 return 分支，不执行 patch）

- [ ] **Step 3: 提交**

```bash
git add crates/server/src/routing/shim.js
git commit -m "$(cat <<'EOF'
feat(shim): 加入 fetch/XHR/WebSocket/DOM/导航 patch

仅在浏览器环境执行（typeof window !== "undefined"）。
MutationObserver 监听 src/href/action 属性变化，启动时扫描已有节点。
防重入标志位避免改写触发 observer 死循环。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: Rust 端 inject_shim 函数 + 单元测试

**Files:**
- Create: `crates/server/src/routing/shim.rs`
- Create: `crates/server/src/routing/shim_test.rs`
- Modify: `crates/server/src/routing/mod.rs`（声明 shim 模块）

- [ ] **Step 1: 创建 shim.rs**

`crates/server/src/routing/shim.rs`：

```rust
//! 子路径前端资源改写 shim：HTML 注入。

/// 编译期嵌入的前端 shim 源码（同目录 shim.js）。
pub const SHIM_JS: &str = include_str!("shim.js");

/// 防重复注入标记。
const INJECTED_FLAG: &str = "__SHIM_INJECTED__";

/// 把 shim 注入 HTML 字符流，紧贴 `<head>` 开标签之后；无 `<head>` 则插到文档最前。
///
/// 注入结构：
/// ```html
/// <script>window.__SITE_SHIM_CONFIG__ = {uuid:"...",silent:false};__SHIM_INJECTED__=1;</script>
/// <script>/* SHIM_JS */</script>
/// ```
pub fn inject_shim(html: &str, uuid: &str) -> String {
    // 1. 防重复
    if html.contains(INJECTED_FLAG) {
        return html.to_string();
    }

    // 2. uuid 转义：站点 id 是 UUID v7（hex + dash），但保险起见只允许安全字符
    if !is_safe_uuid(uuid) {
        tracing::warn!(uuid = %uuid, "uuid 含非法字符，跳过 shim 注入");
        return html.to_string();
    }

    // 3. 构造注入块
    let config_script = format!(
        r#"<script>window.__SITE_SHIM_CONFIG__={{uuid:"{uuid}",silent:false}};{flag}=1;</script>"#,
        uuid = uuid,
        flag = INJECTED_FLAG,
    );
    let shim_script = format!("<script>{}</script>", SHIM_JS);
    let injection = format!("{}{}", config_script, shim_script);

    // 4. 大小写不敏感查找 <head...>，定位第一个 >
    if let Some(pos) = find_head_open_tag_end(html) {
        let mut out = String::with_capacity(html.len() + injection.len());
        out.push_str(&html[..pos]);
        out.push_str(&injection);
        out.push_str(&html[pos..]);
        out
    } else {
        // 无 <head>：插到文档最前
        let mut out = String::with_capacity(html.len() + injection.len());
        out.push_str(&injection);
        out.push_str(html);
        out
    }
}

/// 简单校验 uuid：仅允许 a-z A-Z 0-9 -
fn is_safe_uuid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 在 html 中查找 `<head...>` 标签开标签的结束位置（第一个 `>` 的下一字节索引）。
/// 大小写不敏感。找不到返回 None。
fn find_head_open_tag_end(html: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let tag_start = lower.find("<head")?;
    // 跳过 `<head`
    let after_tag_name = tag_start + 5;
    // 从此位置找第一个 `>`
    let gt = lower[after_tag_name..].find('>')?;
    Some(after_tag_name + gt + 1)
}

#[cfg(test)]
#[path = "shim_test.rs"]
mod tests;
```

- [ ] **Step 2: 写 inject_shim 单元测试**

`crates/server/src/routing/shim_test.rs`：

```rust
use super::inject_shim;

#[test]
fn test_注入_标准html_插入到head之后() {
    let html = r#"<!doctype html><html><head><title>x</title></head><body></body></html>"#;
    let out = inject_shim(html, "abc-123");
    // config script 应在 <head> 之后、<title> 之前
    let head_end = out.find("<title>").unwrap();
    let config_pos = out.find("__SITE_SHIM_CONFIG__").unwrap();
    assert!(config_pos > html.find("<head>").unwrap());
    assert!(config_pos < head_end);
    assert!(out.contains("abc-123"));
}

#[test]
fn test_注入_无head_插到最前() {
    let html = r#"<html><body><h1>hi</h1></body></html>"#;
    let out = inject_shim(html, "abc");
    assert!(out.starts_with("<script>"));
    assert!(out.contains("<html><body>"));
}

#[test]
fn test_注入_大写HEAD_也能识别() {
    let html = r#"<HTML><HEAD><TITLE>x</TITLE></HEAD></HTML>"#;
    let out = inject_shim(html, "abc");
    assert!(out.contains("__SITE_SHIM_CONFIG__"));
    // 注入位置应在 <HEAD> 之后
    let head_pos = out.to_ascii_lowercase().find("<head>").unwrap();
    let cfg_pos = out.find("__SITE_SHIM_CONFIG__").unwrap();
    assert!(cfg_pos > head_pos);
}

#[test]
fn test_注入_含属性的head标签() {
    let html = r#"<html><head data-x="y"><title>x</title></head></html>"#;
    let out = inject_shim(html, "abc");
    let cfg_pos = out.find("__SITE_SHIM_CONFIG__").unwrap();
    let title_pos = out.find("<title>").unwrap();
    assert!(cfg_pos < title_pos);
    assert!(out.contains(r#"data-x="y""#));
}

#[test]
fn test_注入_已注入_不重复() {
    let html = r#"<html><head>__SHIM_INJECTED__</head></html>"#;
    let out = inject_shim(html, "abc");
    assert_eq!(out, html, "已含 INJECTED_FLAG 应原样返回");
}

#[test]
fn test_注入_非法uuid_跳过注入() {
    let html = r#"<html><head><title>x</title></head></html>"#;
    let out = inject_shim(html, r#"abc"; evil="#);
    assert_eq!(out, html, "uuid 含非法字符应跳过注入");
}

#[test]
fn test_注入_包含shim源码() {
    let html = r#"<html><head></head></html>"#;
    let out = inject_shim(html, "abc");
    // 应包含 shim.js 里的核心函数
    assert!(out.contains("rewriteUrl"));
    assert!(out.contains("WHITELIST"));
}
```

- [ ] **Step 3: 在 routing/mod.rs 声明 shim 子模块**

修改 `crates/server/src/routing/mod.rs`，在文件顶部模块声明区域添加：

```rust
pub mod shim;
```

（放在 `use ...` 之前）

- [ ] **Step 4: 编译并跑测试**

Run: `cargo test -p agent-sites --lib routing::shim`
Expected: 7 tests passed

- [ ] **Step 5: 提交**

```bash
git add crates/server/src/routing/shim.rs crates/server/src/routing/shim_test.rs crates/server/src/routing/mod.rs
git commit -m "$(cat <<'EOF'
feat(routing): inject_shim HTML 注入函数 + 单元测试

把 shim.js 编译期嵌入 (include_str!)，inject_shim 函数在 <head>
开标签之后插入 config + shim 两个 script。支持大小写不敏感、防重复
注入、uuid 安全校验。无 <head> 时降级插到文档最前。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: DB 迁移 + Site 结构加 inject_path_shim 字段

**Files:**
- Create: `crates/server/migrations/20260619000006_add_inject_path_shim.sql`
- Modify: `crates/server/src/db/models.rs`

- [ ] **Step 1: 创建迁移文件**

`crates/server/migrations/20260619000006_add_inject_path_shim.sql`：

```sql
-- 为 sites 表添加 inject_path_shim 字段，控制是否在 HTML 中注入子路径改写 shim
-- 默认 1（开启），可通过 PUT /api/sites/{id}/runtime 关闭
ALTER TABLE sites ADD COLUMN inject_path_shim INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 2: 修改 Site 结构体**

修改 `crates/server/src/db/models.rs` 中 `Site` 结构体（约第 10 行），在 `last_activity_at` 后添加：

```rust
    pub last_activity_at: Option<String>,
    pub inject_path_shim: bool,
```

- [ ] **Step 3: 修改 get_site / list_sites 的 SQL 查询**

在 `crates/server/src/db/models.rs` 找到 `get_site` 函数的 SQL（约 52-58 行），把字段列表改成：

```rust
    let row = sqlx::query_as::<_, SiteRow>(
        "SELECT id, name, status, created_at, updated_at, \
         active_version_id, deno_port, deno_status, \
         keep_alive, idle_timeout_secs, last_activity_at, \
         inject_path_shim \
         FROM sites WHERE id = ? AND status != 'inactive'",
    )
```

同样修改 `list_sites`（约 67-73 行）：

```rust
    let rows = sqlx::query_as::<_, SiteRow>(
        "SELECT id, name, status, created_at, updated_at, \
         active_version_id, deno_port, deno_status, \
         keep_alive, idle_timeout_secs, last_activity_at, \
         inject_path_shim \
         FROM sites WHERE status = 'active' ORDER BY created_at DESC",
    )
```

- [ ] **Step 4: 修改 SiteRow 结构体 + From impl**

在 `crates/server/src/db/models.rs` 文件末尾找到 `struct SiteRow` 和 `impl From<SiteRow> for Site`（约 530 行附近），加新字段：

SiteRow：

```rust
struct SiteRow {
    id: String,
    name: String,
    status: String,
    created_at: String,
    updated_at: String,
    active_version_id: Option<String>,
    deno_port: Option<i64>,
    deno_status: String,
    keep_alive: bool,
    idle_timeout_secs: i64,
    last_activity_at: Option<String>,
    inject_path_shim: bool,
}
```

From impl：

```rust
impl From<SiteRow> for Site {
    fn from(r: SiteRow) -> Site {
        Site {
            id: r.id,
            name: r.name,
            status: r.status,
            created_at: r.created_at,
            updated_at: r.updated_at,
            active_version_id: r.active_version_id,
            deno_port: r.deno_port,
            deno_status: r.deno_status,
            keep_alive: r.keep_alive,
            idle_timeout_secs: r.idle_timeout_secs,
            last_activity_at: r.last_activity_at,
            inject_path_shim: r.inject_path_shim,
        }
    }
}
```

- [ ] **Step 5: 编译 + 跑全量测试，确认现有测试不破坏**

Run: `cargo test -p agent-sites`
Expected: 62+ tests passed（新字段默认 true 不影响现有断言；如果有测试用 `Site { ... }` 字面构造需要补字段）

如果有编译错误（如测试代码里手工构造 `Site` 字面量），按错误信息补 `inject_path_shim: true` 字段。

- [ ] **Step 6: 提交**

```bash
git add crates/server/migrations/20260619000006_add_inject_path_shim.sql crates/server/src/db/models.rs
git commit -m "$(cat <<'EOF'
feat(db): sites 表加 inject_path_shim 字段

控制平台是否在该站点 HTML 中注入子路径前端 shim。默认 true，
后续可通过 PUT /api/sites/{id}/runtime 关闭。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: serve_site_file 集成注入

**Files:**
- Modify: `crates/server/src/routing/mod.rs`
- Modify: `crates/server/src/routing/mod_test.rs`

- [ ] **Step 1: 修改 serve_site_file 加入注入逻辑**

修改 `crates/server/src/routing/mod.rs` 的 `serve_site_file` 函数尾部，把：

```rust
    // 读取文件
    let data = tokio::fs::read(&canonical)
        .await
        .map_err(|_| AppError::NotFound)?;

    let content_type = mime_guess::from_path(&canonical)
        .first_or_octet_stream()
        .to_string();

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=3600".to_string()),
        ],
        data,
    ))
```

替换为：

```rust
    // 读取文件
    let data = tokio::fs::read(&canonical)
        .await
        .map_err(|_| AppError::NotFound)?;

    let content_type = mime_guess::from_path(&canonical)
        .first_or_octet_stream()
        .to_string();

    // HTML 文件：注入子路径改写 shim（仅当站点开启 inject_path_shim 时）
    let final_data = if content_type.contains("text/html") && site.inject_path_shim {
        let html = String::from_utf8_lossy(&data);
        shim::inject_shim(&html, &site_id).into_bytes()
    } else {
        data
    };

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=3600".to_string()),
        ],
        final_data,
    ))
```

- [ ] **Step 2: 写集成测试**

在 `crates/server/src/routing/mod_test.rs` 文件末尾追加：

```rust
/// HTML 文件应被注入 shim
#[tokio::test]
async fn test_静态服务_html文件被注入shim() {
    let (_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    let file_path = state.storage_dir.join(&site.id).join("index.html");
    tokio::fs::create_dir_all(file_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&file_path, b"<html><head></head><body>hi</body></html>")
        .await
        .unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sites/{}/index.html", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body_data = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_data.to_vec()).unwrap();
    assert!(body_str.contains("__SITE_SHIM_CONFIG__"), "应注入 config");
    assert!(body_str.contains(&site.id), "config 应含 uuid");
    assert!(body_str.contains("rewriteUrl"), "应含 shim 源码");
}

/// 非 HTML 文件（如 CSS）不应注入
#[tokio::test]
async fn test_静态服务_非html文件不注入shim() {
    let (_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    let file_path = state.storage_dir.join(&site.id).join("style.css");
    tokio::fs::create_dir_all(file_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&file_path, b"body{}")
        .await
        .unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sites/{}/style.css", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let body_data = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_data.to_vec()).unwrap();
    assert!(!body_str.contains("__SITE_SHIM_CONFIG__"), "CSS 不应注入");
}
```

- [ ] **Step 3: 跑测试**

Run: `cargo test -p agent-sites --lib routing::mod_test`
Expected: 12 tests passed（原 10 + 新增 2）

- [ ] **Step 4: 提交**

```bash
git add crates/server/src/routing/mod.rs crates/server/src/routing/mod_test.rs
git commit -m "$(cat <<'EOF'
feat(routing): serve_site_file 集成 shim 注入

HTML 文件 (text/html) 且站点 inject_path_shim=true 时调用
shim::inject_shim 注入子路径改写 shim。非 HTML 文件不动。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: update_runtime API 接受 inject_path_shim

**Files:**
- Modify: `crates/server/src/api/sites.rs`
- Modify: `crates/server/src/db/models.rs`

> 现有代码：`db::models::update_site_runtime` 用 `if let (Some, Some) / else if let Some` 链按字段分别构造 UPDATE；`api/sites.rs::update_runtime` handler 返回 `{"updated": bool}` 而非 site 对象。本 task 把函数签名扩展为支持 `inject_path_shim`，并把 SQL 改写为 COALESCE 形式以简化分支。

- [ ] **Step 1: 修改 UpdateRuntimeInput 结构体**

在 `crates/server/src/api/sites.rs:106` 找到 `UpdateRuntimeInput`，加新字段：

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateRuntimeInput {
    pub keep_alive: Option<bool>,
    pub idle_timeout_secs: Option<i64>,
    pub inject_path_shim: Option<bool>,
}
```

- [ ] **Step 2: 重写 db::models::update_site_runtime，用 COALESCE + 加 inject_path_shim 参数**

在 `crates/server/src/db/models.rs:147` 把整个 `update_site_runtime` 函数替换为：

```rust
pub async fn update_site_runtime(
    pool: &SqlitePool,
    site_id: &str,
    keep_alive: Option<bool>,
    idle_timeout_secs: Option<i64>,
    inject_path_shim: Option<bool>,
) -> Result<bool, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let keep = keep_alive.map(|v| v as i64);
    let shim = inject_path_shim.map(|v| v as i64);
    let result = sqlx::query(
        "UPDATE sites SET \
         keep_alive = COALESCE(?, keep_alive), \
         idle_timeout_secs = COALESCE(?, idle_timeout_secs), \
         inject_path_shim = COALESCE(?, inject_path_shim), \
         updated_at = ? \
         WHERE id = ? AND status != 'inactive'",
    )
    .bind(keep)
    .bind(idle_timeout_secs)
    .bind(shim)
    .bind(&now)
    .bind(site_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
```

注意：原代码用 `if let` 链在所有字段都 None 时返回 `Ok(false)` 不执行 SQL。改用 COALESCE 后所有字段 None 时 SQL 仍会执行（UPDATE 一行但所有字段都 = 原值），返回 `rows_affected() > 0`（站点存在时为 true）。这个语义差异由 handler 层的"至少一个字段"检查兜底（Step 3）。

- [ ] **Step 3: 修改 api/sites.rs::update_runtime handler**

在 `crates/server/src/api/sites.rs:112` 把整个 `update_runtime` 函数替换为：

```rust
/// PUT /api/sites/:id/runtime
pub async fn update_runtime(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
    Json(input): Json<UpdateRuntimeInput>,
) -> Result<impl IntoResponse, AppError> {
    // 确认站点存在且未删除
    db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;

    // 至少需要一个字段
    if input.keep_alive.is_none()
        && input.idle_timeout_secs.is_none()
        && input.inject_path_shim.is_none()
    {
        return Ok(Json(ApiResponse::ok(serde_json::json!({"updated": false}))));
    }

    db::models::update_site_runtime(
        &state.db,
        &site_id,
        input.keep_alive,
        input.idle_timeout_secs,
        input.inject_path_shim,
    )
    .await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({"updated": true}))))
}
```

- [ ] **Step 4: 编译并跑全量测试**

Run: `cargo test -p agent-sites`
Expected: 全部通过。若现有 update_runtime 测试用 2 参数调用 db::models::update_site_runtime，需补 None 占位参数。

- [ ] **Step 5: 提交**

```bash
git add crates/server/src/api/sites.rs crates/server/src/db/models.rs
git commit -m "$(cat <<'EOF'
feat(api): update_runtime 接受 inject_path_shim

PUT /api/sites/{id}/runtime 现可关闭/开启 shim 注入：
{ "inject_path_shim": false }

update_site_runtime 改用 COALESCE 简化字段分支。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 7: serve_site_file 关闭开关后不注入（集成测试）

**Files:**
- Modify: `crates/server/src/routing/mod_test.rs`

- [ ] **Step 1: 写测试**

在 `crates/server/src/routing/mod_test.rs` 末尾追加：

```rust
/// inject_path_shim=false 的站点不应被注入
#[tokio::test]
async fn test_静态服务_关闭shim后不注入() {
    let (_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    // 关闭 shim
    db::models::update_site_runtime(
        &state.db,
        &site.id,
        None,
        None,
        Some(false),
    )
    .await
    .unwrap();

    let file_path = state.storage_dir.join(&site.id).join("index.html");
    tokio::fs::create_dir_all(file_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&file_path, b"<html><head></head></html>")
        .await
        .unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sites/{}/index.html", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let body_data = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_data.to_vec()).unwrap();
    assert!(!body_str.contains("__SITE_SHIM_CONFIG__"), "关闭后不应注入");
}
```

- [ ] **Step 2: 跑测试**

Run: `cargo test -p agent-sites --lib routing::mod_test::test_静态服务_关闭shim后不注入`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add crates/server/src/routing/mod_test.rs
git commit -m "$(cat <<'EOF'
test(routing): inject_path_shim=false 时不注入 shim

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 8: skill 文档补充 opt-out + 限制说明

**Files:**
- Modify: `.claude/skills/agent-sites-deploy/SKILL.md`

- [ ] **Step 1: 在「四、访问站点 → 前端资源引用必须用相对路径」章节末尾追加一段说明**

定位到该章节的「构建工具配置」段之后，追加：

```markdown
### 平台 shim（自动兜底）

平台默认会在站点的 HTML 文件中自动注入一段 inline JS shim，把白名单外的绝对路径改写到 `/sites/{uuid}/` 下，所以**即使前端代码忘了用相对路径，站点通常也能跑起来**。

**默认开启**。如果想关闭（如站点需要严格的原路径语义）：

```bash
curl -X PUT $AGENT_SITES_URL/api/sites/{id}/runtime \
  -H 'Content-Type: application/json' \
  -d '{"inject_path_shim": false}'
```

**shim 的行为**：

- 改写规则：`/foo` → `/sites/{uuid}/foo`（白名单 `/api/` `/sites/` `/portal` `/health` `/` 不改写）
- 覆盖：`fetch` / `XMLHttpRequest` / `WebSocket` / `<img/link/script/iframe/audio/video/source/a/form>` 的 src/href/action / `history.pushState`/`replaceState` / `window.location.href`
- 相对路径（`api/x`）不改写 —— 这才是推荐写法
- 跨源 URL（`https://cdn.example.com/x.js`）不改写

**已知限制**（不覆盖）：

- Service Worker 内的 `fetch` —— 进阶用法，需自行处理
- 站点原页面 CSP 禁止 `unsafe-inline` 时，shim 会被 CSP 拦截（用户责任）
- `<base href>` 改变相对路径基准的情况（罕见，YAGNI）

调试：浏览器 DevTools 控制台会看到 `[shim] 重写 %s → %s` 警告。
```

- [ ] **Step 2: 在「常见问题」追加一条**

```markdown
### 站点 fetch 返回了奇怪结果（如 agent-sites 自己的 API 响应）

确认是否关闭了 shim（默认开启会兜底）。如果开启了仍出错，说明站点代码用了**跨源绝对 URL**（shim 不改写跨源），或用了 Service Worker。检查 DevTools Network 面板看实际请求 URL。
```

- [ ] **Step 3: 提交**

```bash
git add .claude/skills/agent-sites-deploy/SKILL.md
git commit -m "$(cat <<'EOF'
docs(skill): 补充平台 shim 自动兜底说明 + opt-out 方法

shim 默认开启，PUT /api/sites/{id}/runtime {inject_path_shim:false} 可关。
列出覆盖范围和已知限制（SW / CSP / <base> 不处理）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 9: E2E 验证

**Files:** 无（手动验证 + 可选 demo 脚本扩展）

- [ ] **Step 1: cargo build**

Run: `cargo build -p agent-sites`
Expected: 编译通过

- [ ] **Step 2: 启动 server + 部署一个用绝对路径的 demo 站点**

```bash
# Terminal 1
cargo run -- --port 13920

# Terminal 2
mkdir -p /tmp/abs-pkg
echo 'Deno.serve(req => new Response("hi"));' > /tmp/abs-pkg/main.ts
cat > /tmp/abs-pkg/index.html <<'HTML'
<!doctype html>
<html><head><title>abs demo</title></head>
<body>
<h1>Abs Path Demo</h1>
<script>
  // 故意用绝对路径 —— 看 shim 是否兜底
  fetch("/api/echo").then(r => r.json()).then(d => {
    document.body.innerHTML += "<pre>" + JSON.stringify(d) + "</pre>";
  }).catch(e => {
    document.body.innerHTML += "<pre>FAIL: " + e + "</pre>";
  });
  fetch("/api/health").then(r => r.text()).then(t => {
    document.body.innerHTML += "<pre>health: " + t + "</pre>";
  });
</script>
</body></html>
HTML
tar -czf /tmp/abs.tar.gz -C /tmp/abs-pkg .

# 创建站点 + 部署
SITE_ID=$(curl -s -X POST http://localhost:13920/api/sites \
  -H 'Content-Type: application/json' \
  -d '{"name":"Abs Path Demo"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
curl -s -X POST "http://localhost:13920/api/sites/$SITE_ID/deploy" -F "file=@/tmp/abs.tar.gz" > /dev/null
echo "site: $SITE_ID"
echo "url:  http://localhost:13920/sites/$SITE_ID"
```

- [ ] **Step 3: 浏览器打开 URL，验证**

打开 `http://localhost:13920/sites/{SITE_ID}` —— 应该看到：

- 页面正常加载
- DevTools Console 出现 `[shim] 重写 /api/echo → /sites/{uuid}/api/echo`
- 页面显示 `{"method":"GET","echoed":"(empty)","counter":1,...}` （站点 Deno 的 echo 响应）
- 注意：`/api/health` 在白名单不改写，应该返回 agent-sites 平台的 `"ok"` —— 验证白名单工作

- [ ] **Step 4: 验证 opt-out**

```bash
curl -X PUT http://localhost:13920/api/sites/$SITE_ID/runtime \
  -H 'Content-Type: application/json' \
  -d '{"inject_path_shim": false}'
```

刷新浏览器 —— shim 不再注入，DevTools Console 不出现 `[shim]` 警告，`fetch("/api/echo")` 落到平台 `/api/echo`（404）。

- [ ] **Step 5: 清理**

```bash
kill %1
rm -rf /tmp/abs-pkg /tmp/abs.tar.gz
```

- [ ] **Step 6: 如果 E2E 通过，提交一个验证记录（可选）**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
test(e2e): subpath fetch shim 端到端验证通过

部署用绝对路径的 demo 站点 → shim 自动改写 /api/echo 到
/sites/{uuid}/api/echo → 命中站点 Deno；opt-out 关闭后改写失效。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## 完成标准

- [ ] `cargo test -p agent-sites`：全部通过
- [ ] `deno test --allow-read tests/shim/`：10+ tests 通过
- [ ] `cargo clippy -p agent-sites --all-targets -- -D warnings`：本次新增代码无新增 warning（pre-existing 警告不算）
- [ ] E2E：用绝对路径的 demo 站点能正常 fetch 站点 API
- [ ] skill 文档已更新
