# 前端 Fetch Shim（自动注入）

平台给 App 部署在子路径 `/app-xxxxx/` 下。如果前端代码用**绝对路径**调 API（`fetch('/api/echo')`），浏览器会解析到平台根 `/api/echo`——这是 agent-sites 自己的管理 API 路由，会命中鉴权失败或 404，而不是该 App 的 PocketBase。

## 自动兜底机制

平台在 GET 静态 HTML 响应时，**自动在第一个 `<head>` 标签后注入**一段 JS，monkey-patch `window.fetch`，把绝对路径 `/api/x` 重写为 `/{app_id}/api/x`：

```html
<!-- 平台注入 -->
<script>(function(){
  var PREFIX = "/app-abcd1234";
  var orig = window.fetch;
  window.fetch = function(input, init){
    if (typeof input === 'string') {
      if (input.charAt(0) === '/' && !input.startsWith('//') && input.indexOf(PREFIX + '/') !== 0 && input !== PREFIX) {
        input = PREFIX + input;
      }
    } else if (input instanceof Request) {
      var u = input.url;
      if (u.charAt(0) === '/' && !u.startsWith('//') && u.indexOf(PREFIX + '/') !== 0 && u !== PREFIX) {
        input = new Request(PREFIX + u, input);
      }
    }
    return orig.call(this, input, init);
  };
})();
</script>
```

## 重写规则

| 前端调用 | 浏览器解析 | shim 行为 |
|---------|----------|----------|
| `fetch('/api/echo')` | `/api/echo`（平台根） | ✅ 重写为 `/app-xxxxx/api/echo` |
| `fetch('/api/users')` | 同上 | ✅ 重写 |
| `fetch('api/echo')` | `/app-xxxxx/api/echo` | 不重写（已对） |
| `fetch('./api/echo')` | 同上 | 不重写（已对） |
| `fetch('//host/api/x')` | 协议相对，跨域 | 不重写（保留跨域语义） |
| `fetch('http://example.com/api/x')` | 完整 URL | 不重写 |
| `fetch('/app-xxxxx/api/x')` | 已经是 App 子路径 | 不重写（避免双重前缀） |

## 适用范围

- **注入位置**：HTML 响应（`Content-Type` 含 `text/html`）。其他静态资源（JS/CSS/图片/JSON）不注入。
- **HTML 结构**：有 `<head>` 标签 → 注入到第一个 `<head>` 后；无 `<head>` → 注入到文件开头。
- **子路径 HTML**：`/app-xxxxx/sub/page.html` 也注入（不影响）。
- **当前无 opt-out**：shim 总是注入。前端不需要做任何配置就能用绝对路径调 API。

## 限制

- 仅 patch `window.fetch`，**不处理 `XMLHttpRequest` / `axios` / `<a href>` / `<img src>` / `<link href>`**。如果前端用这些，需要自己处理相对路径（见 `frontend-paths.md`）。
- 仅运行时改写，**不修改源码**。返回查看页面源代码会看到注入的 script。
- Shim 是兜底，**不替代最佳实践**：前端代码主动用相对路径仍是最稳妥的方案（见 `frontend-paths.md`）。
