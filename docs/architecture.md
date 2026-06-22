# Agent Sites 后端架构文档

> 2026-06-19 · 生态架构讨论产出（2026-06-19 重构：Rust → Deno/TypeScript；2026-06-20 修订：token-only-access 三层鉴权 + 立即删除语义）

## 1. 概述

Agent Sites 是一个 agent 站点托管平台。agent 产出前端应用 + 数据库 schema，平台负责部署、运行、路由分发。每个 App 拥有完全独立的后端数据引擎和前端静态资源，App 之间互不交互。

## 2. 技术选型

| 层 | 技术 | 说明 |
|---|------|------|
| 网关/路由 | Deno 2.x + TypeScript | 统一入口，路由分发，App 生命周期管理。原生 `Deno.serve`，不依赖框架 |
| 数据引擎 | PocketBase (Go) | 每个 App 独立实例，提供 CRUD API + 管理后台 |
| 前端 | ESM + 原生 HTML/CSS/JS | agent 产出 bundleless 代码，不构建 |
| SDK | pocketbase/js-sdk | 通过 unpkg CDN 加载，前端直接调用 PocketBase Client API |

**关键决策**：每个 App 一个 PocketBase 进程，Deno 服务做反向代理和进程管理。无外部数据库（App 元数据用 `data/apps.json` 单文件 JSON 持久化）。

**为什么从 Rust 迁移到 Deno**：
- 单一二进制运行时（无需 cargo build / 链接产物），冷启动快
- TypeScript 内建类型系统（取代 Rust 类型 + serde 双层维护）
- 进程管理 / HTTP 服务 / 文件 IO / CLI 参数 全部由 Deno 原生 API 提供，依赖面更窄
- 测试与源码同语言，迁移 Rust 测试用例的翻译是 1:1 对应关系

## 3. 进程模型

```
┌────────────────────────────────────────────────────┐
│                 Deno Gateway (:3000)                 │
│  ┌──────────┐  ┌──────────┐       ┌──────────┐     │
│  │ Route    │  │ App      │       │ Process  │     │
│  │ Dispatch │  │ Registry │       │ Manager  │     │
│  └──────────┘  └──────────┘       └──────────┘     │
│       │              │                   │          │
└───────┼──────────────┼───────────────────┼──────────┘
        │              │                   │
        ▼              ▼                   ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PocketBase  │ │  PocketBase  │ │  PocketBase  │  ...
│  :9001       │ │  :9002       │ │  :9003       │
│  app-a/      │ │  app-b/      │ │  app-c/      │
└──────────────┘ └──────────────┘ └──────────────┘
```

- **最大 App 数**：50
- **启动时机**：App 创建时即启动，常驻运行
- **管理方式**：Deno 直接 `Deno.Command.spawn()` 启动 PocketBase，非容器化
- **端口范围**：9000-11000，静态分配（重启不变）
- **数据目录**：每个 App 独立子文件夹
- **崩溃恢复**：检测到 PocketBase 进程僵死自动重启

## 4. 路由模型

### 4.1 统一入口 + 路径前缀

所有流量经 Deno 网关（端口 3000），按路径前缀分发：

```
https://example.com/app-a/        → App A 前端静态文件
https://example.com/app-a/api/    → App A PocketBase Client API
https://example.com/app-b/        → App B 前端静态文件
https://example.com/app-b/api/    → App B PocketBase Client API
```

### 4.2 路由规则

| 路径模式 | 目标 | 说明 |
|----------|------|------|
| `/` | 控制面板 | 静态页面 `public/_panel/index.html`，列 App + 进入（详见 §10） |
| `/health` | Deno | 健康检查 |
| `/api/apps` | Deno 管理 API | App 创建/删除/列表 |
| `/app-{id}/api/*` | PocketBase Client API | 代理到 `localhost:{port}/api/*` |
| `/app-{id}`、`/app-{id}/`、`/app-{id}/*` | 静态文件 | Deno 直接 serve `public/app-{id}/` |

> 注：PocketBase Admin UI (`/{app_id}/_/`) 不通过网关暴露（返 404）。Agent 调 PB Admin API 走 platform token 凭证代换（详见 §5.2 + §7.1），不直接持有 superuser 凭证。

### 4.3 反向代理行为

- Deno 充当 transparent proxy，不修改请求/响应 body
- 透传模式：agent 的 schema 变更请求直接转发到 PocketBase Admin API
- 无需跨域处理：前端只访问同源地址
- 多值 `Set-Cookie` 用 `Headers.getSetCookie()` 显式展开再 append（Deno/JS 单值 `Headers.get` 会丢值，详见 `src/proxy/mod.ts` 注释）

## 5. App 生命周期

### 5.1 创建流程

```
agent → POST /api/apps { "name": "my-app" }  (header: X-Master-Key)
         │
         ▼
    Deno 分配 App ID + 端口 (9000-11000)
         │
         ▼
    Deno 预置 superuser + spawn pocketbase serve --dir data/app-{id} --http localhost:{port}
         │
         ▼
    Deno 返回 { id, name, port, status, api_path, created_at }
         （响应不含 superuser 凭证 —— 凭证仅存内部 store）
         │
         ▼
    agent → POST /api/tokens { app_id }  (header: X-Master-Key)
         → 返回 platform token（永久有效，仅展示一次）
         │
         ▼
    agent → POST /app-{id}/api/collections  (header: Authorization = Bearer <platform_token>)
         Deno 把 platform token 凭证代换为内部 superuser token → 透传到 PocketBase Admin API → 建表完成
         │
         ▼
    agent → PUT /api/apps/{id}/files/index.html  (header: X-Master-Key)
         │
         ▼
    App 上线
```

### 5.2 PocketBase 启动参数

```bash
pocketbase serve \
  --dir data/app-{id} \
  --http localhost:{port}
```

- `--dir` 隔离数据目录（SQLite + 文件存储）
- 绑定 `localhost`，不暴露到公网
- 注：PocketBase 0.23.x 不支持 `--cookiePath`/`--queryTimeout`（plan 原始假设有误）。App 间 auth cookie 隔离（架构 §6.1）由 proxy 层负责 —— `proxy.forward` 在转发响应时把上游 `Set-Cookie` 中的 `Path=/` 改写为 `Path=/{app_id}`

### 5.2.1 Superuser 预置（内部凭证，不外露）

PocketBase 进程 spawn **之前**，平台调用 `pocketbase superuser upsert` 子命令预置 superuser，避免任何 App 出现「首次注册」抢注窗口。

- 邮箱：`admin@{app_id}.local`（如 `admin@app-abc12345.local`）
- 密码：32 字符 hex（uuid v4 simple）
- 凭证存入 `AppStore`，与 App 元数据同级序列化到 `apps.json`（明文）
- **凭证永远不出现在 HTTP 响应里**：`POST /api/apps` 的 `AppResponse` 只有 `id / name / port / status / api_path / created_at`。Agent 调 PB Admin API 走 **platform token 凭证代换**（见 §7.1）

> Issue #2 陷阱：PocketBase 0.23.x 对非法 email 等校验错误**退出码仍为 0**（同 Issue #12 的 `--version` 子命令坑），错误信息打到 stdout 形如 `Error: ...`。仅靠 `output.success` 无法识别失败，必须额外检查 stdout 不以 `Error:` 开头。详见 `src/process/pocketbase.ts` `initSuperuser`。

### 5.3 删除流程

`DELETE /api/apps/{id}` 是**立即真删**——MVP 不实现 7 天宽限期（待后续 plan 评估是否需要回收站）。

1. agent 调用 `DELETE /api/apps/{id}`
2. Deno 同步执行清理（不可恢复）：
   - 发送 SIGTERM → 等待 10s → SIGKILL 停止 PocketBase 进程
   - 删除 `public/app-{id}/` 静态文件目录
   - 删除 `data/app-{id}/` 数据目录
   - 吊销该 App 下所有 platform token（status 标记为 `revoked`）
   - 释放端口（立即可被新 App 复用）

## 6. 数据隔离

### 6.1 App 维度隔离

| 维度 | 隔离方式 |
|------|----------|
| 数据库 | 独立 SQLite 文件 (`data/app-{id}/data.db`) |
| 文件存储 | 独立目录 (`data/app-{id}/storage/`) |
| Auth Cookie | proxy 层把上游 `Set-Cookie` 中的 `Path=/` 改写为 `Path=/{app_id}` 限制作用域 |
| 进程 | 独立 PocketBase 进程 |
| 端口 | 独立端口 |

### 6.2 非隔离项目

| 维度 | 说明 |
|------|------|
| 域名 | 所有 App 共享同一域名（路径前缀方案） |
| localStorage / sessionStorage | 同源共享，无法隔离 |
| PocketBase 二进制 | 所有实例使用同一二进制文件 |

> **注意**：路径前缀方案的浏览器端存储隔离不足。如果未来需求要求全链路隔离，需切换到子域名方案。

## 7. Agent 交互

### 7.1 三层鉴权

平台有正交的三层鉴权，分别在不同 endpoint 生效：

| 场景 | 凭证 | Endpoint |
|------|------|---------|
| **平台管理**（创建/删除 App、申请/吊销 token、上传前端文件） | `X-Master-Key: <AGENT_SITES_MASTER_KEY>` | `/api/apps*`、`/api/tokens*`、`/api/apps/{id}/files*` |
| **App 操作**（CRUD collections / records） | `Authorization: Bearer <platform_token>` | `/{app_id}/api/*`（平台凭证代换为内部 superuser token 后转发） |
| **业务前端**（公开页面 / 用户登录态） | 无 或 PB user token | `/{app_id}/api/*`（透传给 PocketBase Rules） |

**关键不变量**：

- `POST /api/apps` 响应 `AppResponse` **不含** `superuser_email` / `superuser_password`
- **Platform token 永久有效**（无 expiry、无 refresh），吊销靠 `DELETE /api/tokens/{id}` 把 `status` 标记为 `revoked` 立即生效；`last_used_at` 字段永久 null（仅 schema 占位）
- PB superuser 凭证永远不出现在 HTTP 响应里——Agent 调 PB Admin API 时，平台代理层用 App 内部凭证做凭证代换

详见 `docs/superpowers/specs/2026-06-19-token-only-access-design.md`。

### 7.2 Schema 变更（agent 调 Admin API）

Agent 申请 platform token，用 token 调 `/{app_id}/api/*`（平台做凭证代换为 PB superuser token 后透传）：

```
# 1. 申请 platform token（仅展示一次，永久有效）
POST /api/tokens
  header: X-Master-Key = <AGENT_SITES_MASTER_KEY>
  body: { "app_id": "app-xxxxxxxx" }
→ response.data.token = "<platform_token>"

# 2. 用 token 操作 collections（平台凭证代换为 superuser 后转发给 PB）
POST   /app-{id}/api/collections            创建 collection
PATCH  /app-{id}/api/collections/:id        修改 collection
DELETE /app-{id}/api/collections/:id        删除 collection
  header: Authorization = Bearer <platform_token>
```

- Deno 网关 **不封装、不拦截业务校验**——凭证代换后透传到 PocketBase
- Agent 全权负责数据完整性
- Schema 变更导致的数据丢失由 agent 自行承担

### 7.3 前端产物部署

agent 将前端文件写入指定的 public 目录：

```
public/app-{id}/
├── index.html
├── main.js
├── style.css
└── ...
```

- ESM + 原生 HTML/CSS/JS，不构建
- Deno 通过 `src/static_files/mod.ts` serveDir 直接 serve，不做 SPA fallback
- 前端自行处理相对路径和 SPA 路由

## 8. 前端 SDK

### 8.1 引入方式

前端产物通过 unpkg CDN 加载官方 SDK：

```html
<script type="module">
import PocketBase from 'https://unpkg.com/pocketbase@latest/dist/pocketbase.es.mjs';

const pb = new PocketBase('/app-{id}/api');
// pb.collection('posts').getList(...)
</script>
```

### 8.2 SDK 职责

- 由 pocketbase/js-sdk 提供完整的 Client API
- 前端直接使用 PocketBase 的 collection/record CRUD 协议
- Deno 不提供额外 SDK

## 9. 运维

### 9.1 PocketBase 升级

**统一升级**。替换二进制文件，重启所有 PocketBase 进程。升级流程：

1. 停止所有 PocketBase 实例（SIGTERM）
2. 替换二进制
3. 按原参数重启所有实例
4. 如果启动失败，回滚二进制并告警

### 9.2 端口管理

| 范围 | 用途 |
|------|------|
| 3000 | Deno 网关 |
| 9000-11000 | PocketBase 实例池 |

- 端口静态分配，写入配置持久化
- Deno 重启后端口映射不变
- App 删除时端口立即释放回池（无宽限期）

### 9.3 进程监控与崩溃自愈

PocketBase 子进程崩溃或僵死时，由请求路径上的两道关卡触发自愈，**无后台心跳监控**（YAGNI，本地开发场景延迟可接受）：

**第一关（轻量，零开销）**：`serve_api_proxy` 转发前调 `process_manager.is_alive(app_id)`——`ManagedProcess` 用 `settled` 标志位 + `child.status.then()` 缓存 exitCode，进程已退出则触发自愈。零开销同步检测（等价 Rust `try_wait`），不跨 await。

**第二关（探测僵死）**：`proxy::forward` 返回 `AppError.Internal` 且错误信息含 `connection refused` / `timed out` 等关键字时，认为进程僵死或刚退出 → 触发自愈。

**自愈流程**（`restart_if_needed`）：
1. 限流检查：5 分钟内 ≥ 3 次 → `RateLimited`（直接 503）
2. 二次确认：同步段内再判 `isAlive`，进程还活着 → `StillHealthy`（防 race）
3. 端口冲突处理：`lsof` + `/proc/{pid}/cmdline`（Linux）/ `ps`（macOS）验证占用者含 `pocketbase serve` + 当前 `app_id`，匹配则 SIGKILL，不匹配 `GiveUp`（避免误杀无关进程）
4. 用原端口 spawn → `waitForHealth(10s)` → 超时 `GiveUp`

**status=Error 短路**：进入自愈路径前，若 `app.status == Error` 直接 503，不重试（pb 已知不可达）。

**并发安全 / 资源管理**：
- Deno 单线程事件循环天然原子，`processes` Map 无需锁。spawn 在同一微任务内完成（无 await 让出）= Rust 原实现的「锁内」语义
- `RestartCounter` 滑动窗口也是 Map，单线程无需锁
- `ManagedProcess` 实现 `Symbol.asyncDispose`（ES2025 Explicit Resource Management），`using await` 语法糖或 try/finally 触发 SIGKILL 兜底。承认 JS 无 RAII，OOM/SIGKILL 残留是不可消除差距——`main.ts` 注册 `addSignalListener('SIGTERM')` 全局 cleanup 配合调用点 try/finally
- `child.status` 是消费式 Promise（只能 await 一次），`ManagedProcess` 在构造时缓存 + `.then`/`.catch` 更新 settled 标志位，该 chain 必须被 `stop()` 显式 await（保存在 `exitHandler` 字段），否则 Deno.test 报「Promise resolution is still pending」
- **`waitForHealth` 必须用 `AbortController` + `setTimeout` + `clearTimeout`**，不能用 `AbortSignal.timeout(ms)`——后者内部 timer 在 fetch 提前完成时悬挂，触发 Deno sanitizeOps
- 测试专用 `withTestSpawnLock`（Promise 链 mutex）串行 spawn，防 SQLite init / macOS fork 限速 race。**Mutex 不可重入**：测试代码外层包装 + `pm.start`/`pm.restartIfNeeded` 内部不能再调（已从生产路径移除）

### 9.4 数据备份

（待定：由 PocketBase 内建的 `pocketbase backup` 命令实现，或定期对 `data/` 目录做文件级备份）

## 10. 目录结构

```
agent-sites/
├── src/                     # Deno 网关服务
│   ├── api/                 # REST API handlers（/api/apps + /api/tokens + 文件上传）
│   ├── app/                 # App 模型 + JSON 持久化
│   ├── auth/                # Token store + master key + PB token 凭证代换缓存
│   ├── process/             # PocketBase 进程管理器 + 端口分配器
│   ├── proxy/               # 反向代理 handler
│   ├── static_files/        # 静态文件服务
│   ├── state.ts             # AppState
│   ├── error.ts             # 统一错误类型（AppError 工厂）
│   ├── logging.ts           # 结构化日志
│   ├── lib.ts               # createApp + 路由装配
│   └── main.ts              # 入口 + CLI 参数
├── data/                    # App 数据目录
│   ├── app-a/
│   │   ├── data.db          # PocketBase SQLite
│   │   └── storage/         # 文件存储
│   └── app-b/
│       └── ...
├── public/                  # 前端静态文件
│   ├── app-a/
│   │   ├── index.html
│   │   └── ...
│   └── app-b/
│       └── ...
├── bin/                     # PocketBase 二进制
│   └── pocketbase
└── docs/
    └── architecture.md      # 本文档
```

## 11. 待定项

| 项目 | 状态 |
|------|------|
| 数据备份策略 | 待定 |
| 实例启动冷启动优化（如预热） | 待定 |
| 日志聚合（每个 PocketBase 独立日志） | 待定 |
| 前端产物部署方式（API 上传 vs 文件系统写入） | 待定 |
| App 间资源配额限制 | 待定 |

## 12. 控制面板与 Demo

### 12.1 控制面板

根路径 `/` 返回 `public/_panel/index.html` 静态页面（brutalist technical 风格）：

- 单文件 HTML + 内联 CSS + 内联 JS（无构建工具），符合 §2 bundleless 定位
- 纯系统字体栈（serif: Iowan/Palatino/Georgia；mono: SF Mono/IBM Plex Mono/Menlo），零外部 CDN 依赖
- **AUTH bar**：浏览器端粘贴 `X-Master-Key` 存到 `sessionStorage`，每个请求带上 header（`/api/apps` 强制要求 master key）
- **STATS 四格**：Instances / Alive / Dead / Err（前端聚合算）
- **App 表格**：ID（点击复制）/ NAME / STATUS / PORT / PB HEALTH / PB LATENCY / CREATED
- **PB 健康并发探针**：`Promise.allSettled` 同时打 `/{app_id}/api/health`，`r.ok` 判健康，`performance.now()` 算延迟
- **5s 静默轮询**：master key 未 set 时停轮询避免 401 刷屏；AUTO-REFRESH 开关；tab 隐藏时暂停
- **OPEN ↗** 链接到 `/{app_id}/`（App 前端入口）

Docker 容器化时，`docker-entrypoint.sh` 会从镜像内置的 `_panel-seed` 同步到挂载的 `public/_panel`，应对 bind mount 覆盖。

文件不存在时 fallback 到提示 HTML（200，不是 404）。

### 12.2 Demo 留言板

仓库内 `demo/guestbook/index.html` 是一个最小完整 demo：

- PocketBase collection：`posts`（`name` + `content`）
- rule（PocketBase 0.23 语义）：`listRule`/`viewRule`/`createRule` = `""`（公开匿名读写），`updateRule`/`deleteRule` = `null`（永远拒绝）
- 前端从 URL pathname 解析 `app_id`（无构建时注入），调 `/{app_id}/api/collections/posts/records`
- 通过 `scripts/install-demo.sh` 一键上线（幂等）

### 12.3 install-demo.sh

```bash
deno task start &           # 先启动服务
scripts/install-demo.sh     # 一键注册 demo
```

幂等流程：
1. `curl /health` 检查服务
2. `GET /api/apps` 找 `name=demo`，没有就 `POST` 创建
3. `cp demo/guestbook/* → public/{app_id}/`
4. 凭证换 token
5. `DELETE` 已存在的 `posts` collection（如有），`POST` 重建
