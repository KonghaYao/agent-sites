# 前端相对路径陷阱

App 部署在 `/app-xxxxx/` 子路径下。浏览器解析前端代码里的资源引用时，**绝对路径会被解析到平台根**，命中 agent-sites 自己的 API 或 404，而不是该 App 的资源。这是部署到子路径的 SPA 最常见的坑。

> 平台对 `fetch('/api/...')` 已自动注入 shim 兜底（见 `shim.md`），但 `<a>` / `<img>` / `<link>` / `<script>` / `XMLHttpRequest` / `axios` 等仍然要手动处理。

## ❌ 错（绝对路径 → 落到平台根）

```html
<link href="/style.css" />
<script src="/app.js"></script>
<img src="/logo.png" />
<a href="/about">About</a>
```

```js
axios.get("/api/users")        // 不被 shim 拦截，会落到平台根
XMLHttpRequest("/api/echo")
```

## ✅ 对（相对路径 → 落到本 App 子路径下）

```html
<link href="style.css" />
<script src="app.js"></script>
<img src="logo.png" />
<a href="about">About</a>
```

```js
fetch("api/echo")              // → /app-xxxxx/api/echo  ✓
fetch("./api/users")           // 同上  ✓
```

## 路径解析示意

浏览器当前在 `/app-xxxxx/index.html` 时：

```
浏览器 baseURI = http://localhost:3000/app-xxxxx/index.html
fetch("api/echo")      → 取目录 + "api/echo" = /app-xxxxx/api/echo  ✓
fetch("/api/echo")     → 从根开始 = /api/echo  ✗（shim 兜底改成 /app-xxxxx/api/echo）
fetch("./api/echo")    → 等价于 "api/echo"  ✓
```

## 深层子页面

如果页面位于 `/app-xxxxx/sub/page.html`，`fetch("api/x")` 会被解析成 `/app-xxxxx/sub/api/x`（错）。用 `<base>` 锁定基准，或 JS 里算 base：

```html
<head>
  <base href="./" />   <!-- 锁定相对路径基准到当前目录 -->
</head>
```

```js
// 或者在 JS 里算 base，更可靠
const base = new URL("./", document.baseURI).pathname;  // → "/app-xxxxx/"
fetch(base + "api/echo");                               // → /app-xxxxx/api/echo
```

## 部署前自查清单

```bash
# 检查打包产物里有没有绝对路径引用
grep -rn 'href="/' dist/
grep -rn 'src="/' dist/
grep -rn "fetch(['\"]/" src/ dist/
grep -rn "axios\." src/ dist/
```

构建工具配置（按需）：
- **Vite**：`base: "./"`
- **webpack**：`output.publicPath: "./"`
- **CRA（create-react-app）**：不支持相对 base，需 eject 或改用 Vite。
