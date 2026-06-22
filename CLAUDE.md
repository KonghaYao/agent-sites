# CLAUDE.md

## 项目概述

Agent 站点托管平台 — 用于托管、路由和管理多个 Agent Web 站点的 Deno + TypeScript 服务。

| 模块 | 职责 |
|------|------|
| `src/` | 核心服务：HTTP 服务器、站点管理、路由分发、PocketBase 进程编排 |

## 依赖关系

单一 Deno 项目（`deno.json`）。源码全在 `src/`，无 workspace 拆分。模块按目录划分（`api/`、`app/`、`auth/`、`process/`、`proxy/`、`static_files/`），各自带 `mod.ts` 入口；测试与源码同目录命名 `<name>_test.ts`。

## 开发命令

```bash
deno task start                       # 运行服务（默认 0.0.0.0:3000）
deno task start --port 8080           # 指定端口（deno task 直接转发参数，不需要 -- 分隔符）
deno task dev                         # watch 模式开发
deno task check                       # 类型检查
deno task test                        # 全量测试（161 个用例）
deno task test --filter <name>        # 单个测试
deno task fmt                         # 格式化
deno task lint                        # lint
```

## 架构要点

### HTTP 服务

原生 `Deno.serve`（不依赖框架），路由在 `src/lib.ts` 的 `createApp()` 中装配。所有路由集中声明，无中间件链 —— 需要的能力（CORS、Trace、Body 解析）按需在 handler 内联实现。

### 进程模型

每个 App 一个独立 PocketBase 子进程，数据隔离在 `data/app-{id}/`，端口由 `PortAllocator` 在 `9000-11000` 范围内分配。App 元数据用单文件 JSON 持久化（`data/apps.json`），无外部数据库。

PocketBase 子进程由 `PocketBaseProcessManager`（`src/process/mod.ts`）管理，提供 `start`/`stop`/`restartIfNeeded`/`isAlive` 全生命周期。Deno 单线程事件循环天然原子，无锁；spawn 是同步操作不跨 await，所以「检查已启动 → 分配端口 → spawn → insert map」在一个微任务内完成 = Rust 原实现的锁内语义。

## 编码规范

- TypeScript strict mode + noImplicitAny（见 `deno.json`）
- Deno 2.x 原生 API，优先 `Deno.Command` / `Deno.readDir` / `Deno.readTextFile` 等
- 日志统一走 `src/logging.ts`，禁止 `console.log`（`console.info`/`warn`/`error` 仅限启动/停止等运维消息）
- 测试与源码同目录，命名 `<name>_test.ts`，不跨文件共享 mock
- 模块导出集中在 `mod.ts`，子目录内部细节不外泄
- 禁止 `ℹ`（U+2139）符号和 `[i]` 前缀
- **字符串截断必须用字符级操作**：`s.slice(0, n)` 在 CJK 安全（Deno/JS 按 UTF-16 code unit，中文常见字落在 BMP 内，但 emoji/扩展汉字会拆 surrogate pair）；需要严格字符级用 `Array.from(s).slice(0, n).join("")` 或 `[...s].slice(0, n).join("")`
- 终端列宽用 `unicode-width` 等价的 `String.prototype` 处理（CJK 占 2 列，必要时自实现）

## 测试编写风格

- 注释、断言消息用中文；命名 `test_<被测对象>_<场景>`（snake_case，便于按子串 filter）
- Arrange-Act-Assert，无空行分隔
- 断言优先 `assertEquals`/`assert`/`assertRejects`（来自 `jsr:@std/assert`）
- Mock 命名 `make_` 前缀（函数），`Mock` 前缀（结构体），不跨文件共享
- 最小依赖：`@std/assert` + `Deno.makeTempDir`
- **PocketBase 集成测试**：`sanitizeOps: false`/`sanitizeResources: false`/`sanitizeExit: false`（子进程 + 残留 timer 必需），见 `src/process/mod_test.ts` 的 `test()` 包装器
- **spawn 串行化**：跨用例 spawn PocketBase 必须用 `withTestSpawnLock` 包装（防 SQLite init race / macOS fork 限速）。**注意**：`withTestSpawnLock` 是 Mutex 不可重入 —— 不能在 `pm.start`/`pm.restartIfNeeded` 内部再调用（已经在生产代码移除），只能由测试代码外层包装
- **superuser 预置**：测试 spawn PocketBase 前必须 `initSuperuser` 预置凭证，避免「创建第一个 superuser」抢注页面。**注意**：平台不透传 PocketBase Admin UI（`/{app_id}/_/` 返回 404），agent 只能通过 platform token 调 API 操作 collections

## 开发注意事项

- **测试隔离**：禁止写入全局配置或全局状态。测试用 `Deno.makeTempDir()` + `Deno.remove(recursive)`。
- **跨平台 spawn [TRAP]**：所有子进程 spawn 必须通过统一 wrapper（`Deno.Command`），Windows 上若需要 shell 用 `cmd /C`、Unix 用 `bash -c`。
- **路径校验**：接收用户侧路径时必须做路径穿越防护（`Deno.realPath` + prefix 检查）。
- **`Deno.ChildProcess.status` 是消费式**：只能 await 一次。`ManagedProcess` 在构造时缓存 `child.status` Promise + 用 `.then`/`.catch` 链更新 settled 标志位；该 chain 必须被 stop() 显式 await（保存在 `exitHandler` 字段），否则 Deno.test 报「Promise resolution is still pending」。
- **Deno 2.x API 重命名**：`Deno.Child` → `Deno.ChildProcess`；`Deno.run` 已废弃，统一用 `Deno.Command`。
- **AbortSignal.timeout 在 Deno.test 中会泄漏**：`fetch(url, { signal: AbortSignal.timeout(2000) })` 的内部 timer 在 fetch 提前完成时悬挂 → 触发 sanitizeOps。必须改用 `AbortController` + `setTimeout` + `finally { clearTimeout }`。

## 环境变量

| 变量 | 说明 |
|------|------|
| `AGENT_SITES_MASTER_KEY` | **必填** 平台 master key（生成方式 `openssl rand -hex 32`）；用于 `POST /api/apps*` 和 `/api/tokens*` 鉴权 |
| `HOST` | 监听地址（默认 `0.0.0.0`） |
| `PORT` | 监听端口（默认 `3000`；也可 `--port` CLI 参数） |
| `PB_BINARY` | PocketBase 二进制路径（默认 `bin/pocketbase`） |
| `DATA_DIR` | App 数据根目录（默认 `data`） |
| `PUBLIC_DIR` | App 前端静态文件根目录（默认 `public`） |
| `PB_PORT_MIN` | PocketBase 端口范围起（默认 `9000`） |
| `PB_PORT_MAX` | PocketBase 端口范围止（默认 `11000`） |
| `MAX_APPS` | App 数量上限（默认 `50`） |

> 注：`RUST_LOG` / `RUST_LOG_FORMAT` 是 Rust 时代遗留，当前 Deno 实现已不读取，设置无效。日志默认走 `console.info/warn/error` 结构化输出，无法通过环境变量调级别。

## 鉴权模型

三层鉴权（详见 `docs/superpowers/specs/2026-06-19-token-only-access-design.md`）：

1. **平台管理**：`X-Master-Key` header（值 = `AGENT_SITES_MASTER_KEY`）。所有 `/api/apps*` 和 `/api/tokens*` endpoint 强制校验。
2. **App 操作**：`Authorization: Bearer <platform_token>`。agent 用 platform token 调 `/{app_id}/api/*`，平台用 app 内部凭证代换为 PB superuser token 转发。Token 在 `POST /api/tokens { app_id }` 申请，可吊销。
3. **业务前端**：无鉴权或 PB user token。直接透传到 PB，由 PB Rules 处理。

关键不变量：
- PocketBase superuser 凭证永远不出现在 HTTP 响应里。
- **Platform token 永久有效，无 expiry，无 refresh**。吊销靠 `DELETE /api/tokens/{id}` 把 `status` 标记为 `revoked`（立即生效，状态查表）。**last_used_at 字段不更新**（永久 null），仅 schema 占位，不做实际维护。
- **App name 仅展示用**：不唯一、不去重，空时用 id 当 name。`POST /api/apps` body 整个 `name` 字段可省略，缺省时自动用 id 当 name（如 `"name":"app-xxxxx"`）。
- **PB 透传响应字段保留原生 camelCase**（如 `collectionId` / `collectionName`）；平台层 snake_case 不影响代理响应字段。
- **PB 透传响应：整个 envelope 来自 PocketBase**（`{data, message, status}`），不进平台 `{data, error, request_id}` 壳。Agent 写错误处理时需要同时支持两种 envelope：平台路由（`/api/apps*`、`/api/tokens*`、`/api/apps/{id}/files*`）用平台壳；PB 代理（`/{app_id}/api/*`）用 PB 原生壳。
- **PB 透传保留上游 status code**：成功创建记录返 PB 原生 200（PocketBase 0.20+ 统一返 200，不再返 201）。Agent 不要盲信 HTTP 201 等教科书 status，按 PB 实际返回处理。
- **Admin UI 不开放**：`/{app_id}/_/` 前缀的请求返 404 `{"error":{"code":"NOT_FOUND","message":"Admin UI 不开放，请用 platform token + API"}}`，不透传 PocketBase Admin UI。Agent 只能通过 platform token 调 API 操作 collections。
- **前端 fetch 绝对路径自动 shim**：上传到 `public/{id}/` 的 HTML 被浏览器 GET 时，平台会在第一个 `<head>` 后注入一段 JS，monkey-patch `window.fetch`，把绝对路径 `/api/x` 重写为 `/{id}/api/x`，让 agent 上传的前端无需关心部署子路径。相对路径（`./api/x`、`api/x`）由浏览器原生解析（已正确），协议相对（`//host/`）和完整 URL（`http://...`）不重写。
- **前端发布入口**：浏览器 GET `/{id}/` 访问 `public/{id}/index.html`，创建 app 时自动写一个占位 index.html。上传方式两种（均需 X-Master-Key 鉴权）：
  - **单文件**：`PUT /api/apps/{id}/files/{*path}` —— body ≤ 1 MiB，按后缀白名单校验（`.html/.htm/.css/.js/.json/.svg/.png/.jpg/.jpeg/.webp/.ico/.txt/.map`），路径防穿越。响应 `{data:{path:"/{id}/{path}",bytes:N}, error:null}`。**注意**：URL parser（浏览器/curl/fetch 在发送前）会自动折叠 `..` 段，所以单文件 PUT 路径含 `..`（如 `files/../evil.txt`）会被折叠成 `evil.txt` 并被路由层判为「路由不存在」返 404（行为符合预期，安全无影响——`..` 段永远到不了 handler，路径穿越无法发生）。`validateUploadPath` 内的 `..` 拒绝是双层兜底，正常流量走不到。若需对单文件路径做更严格的显式校验，使用 bundle API（其 `..` 段在 tar 解包时会被明确拒绝并返 400 `路径不允许 '..' 或 '.' 段`）。
  - **整目录**：`POST /api/apps/{id}/files/bundle` —— body 为 gzip 压缩的 tar 归档。通过 gzip magic bytes (`1f 8b`) 识别格式，**`Content-Type` 可有可无**（agent 忘了设也不影响）。限制：压缩前 ≤ 10 MiB / 解压后 ≤ 50 MiB / 单文件 ≤ 5 MiB / 最多 200 条目；每条目路径复用单文件后缀白名单；接受 `tar -C dir .` 标准打包（自动跳过 `./` 顶层目录条目）。响应 `{data:{files:[{path:"/{id}/{relPath}",bytes:N}], total_files:N, total_bytes:N, total_bytes_limit:52428800}, error:null}`。失败时 body 含「已写入 N 个文件，共 N 字节」便于断点续传。

## Git Attribution

创建 git commit 时，在 commit message 末尾追加：

```
Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
```
