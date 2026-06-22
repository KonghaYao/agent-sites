> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 阶段 2：Deno 进程管理 + 动态后端 — 设计文档

## 依赖关系

- **前置**：阶段 1（核心平台 + 静态站点托管）已完成
- 阶段 2 在阶段 1 基础上扩展，不修改已有的静态文件服务逻辑

## 目标

支持 Agent 站点的动态后端代码运行——平台管理 Deno 进程生命周期，将 `/sites/{uuid}/api/*` 请求反向代理到 Deno 进程，并支持版本部署和回滚。

---

## 1. 数据模型

### 1.1 versions 表（新增）

```sql
CREATE TABLE versions (
    id          TEXT PRIMARY KEY,     -- UUID v7
    site_id     TEXT NOT NULL,        -- 所属站点
    code_dir    TEXT NOT NULL,        -- 代码目录名 (versions/{id})
    created_at  TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id)
);
```

### 1.2 sites 表扩展

```sql
ALTER TABLE sites ADD COLUMN active_version_id TEXT;
ALTER TABLE sites ADD COLUMN deno_port INTEGER;
ALTER TABLE sites ADD COLUMN deno_status TEXT DEFAULT 'stopped';
ALTER TABLE sites ADD COLUMN keep_alive INTEGER DEFAULT 0;
ALTER TABLE sites ADD COLUMN idle_timeout_secs INTEGER DEFAULT 300;
ALTER TABLE sites ADD COLUMN last_activity_at TEXT;
```

| 字段 | 说明 |
|------|------|
| `active_version_id` | 当前激活的版本 ID，为 NULL 表示未部署后端代码 |
| `deno_port` | Deno 进程监听端口 |
| `deno_status` | `stopped` / `starting` / `running` / `error` |
| `keep_alive` | 0=超时关闭, 1=热启动常驻 |
| `idle_timeout_secs` | 空闲超时秒数，默认 300 |
| `last_activity_at` | 最后请求时间（ISO 8601），用于空闲判定 |

### 1.3 代码存储布局

```
data/sites/{site_id}/
├── index.html              # 静态文件（阶段 1）
├── versions/               # Deno 代码版本
│   ├── {version_id_1}/     # 版本 1
│   │   └── main.ts
│   └── {version_id_2}/     # 版本 2
│       └── main.ts
```

---

## 2. 进程生命周期

### 2.1 状态转换

```
   stopped ──(首次请求)──→ starting ──(健康检查通过)──→ running
     ↑                        ↓                            │
     │                      (启动失败)                      │
     └────────────────────── error ────────────────────────┤
     ↑                                                     │
     └──────(部署新版本/超时/手动停止)────────────────────────┘
      stopping ←─────┘
```

### 2.2 冷启动流程

1. 路由层接收到 `GET /sites/{uuid}/api/...`
2. 查找站点 → 检查 `deno_status`
3. 若 `stopped` 或 `error` → 触发冷启动：
   - 标记 `deno_status = "starting"`（防止重复启动）
   - 分配随机端口（4000-5000 范围）
   - 读取 `active_version_id` → 确定代码目录
   - 启动子进程：`deno run --allow-net --allow-env main.ts`（env `PORT={port}`）
   - 轮询健康检查 `GET http://localhost:{port}/api/health`（每 500ms，最多 10s）
   - 通过 → `deno_status = "running"`，记录 PID
   - 失败 → `deno_status = "error"`
4. 若 `starting` → 等待启动完成（轮询最多 10s），完成后代理请求

### 2.3 资源管理

两种模式，通过 `keep_alive` 和 `idle_timeout_secs` 配置：

| 模式 | keep_alive | 行为 |
|------|-----------|------|
| 热启动 | 1 | 进程启动后常驻，只有部署新版本或手动停止才关闭 |
| 超时关闭 | 0 | 空闲超过 `idle_timeout_secs` 秒后自动关闭 |

后台巡检任务（每 `IDLE_CHECK_INTERVAL_SECS` 秒执行一次）：
```
for each site where deno_status = "running":
    if keep_alive == 0 AND (now - last_activity_at) > idle_timeout_secs:
        stop process → deno_status = "stopped"
```

---

## 3. 反向代理

### 3.1 路由规则

```
/sites/{uuid}/*           → 静态文件服务（阶段 1，保持不变）
/sites/{uuid}/api/{*path} → 代理到 Deno 进程
```

- `/api/` 前缀完整保留（不截断），Deno 收到 `/api/users`、`/api/health` 等
- 代理 URL：`http://localhost:{deno_port}/api/{*path}`
- 请求头、请求体、响应头、响应体完整透传
- 每次代理请求更新 `last_activity_at`

### 3.2 实现方式

使用 `reqwest`（已在 workspace deps 中）作为 HTTP 代理客户端。或使用 `axum` 自身的反向代理能力。

---

## 4. Management API 新增端点

| 方法 | 路径 | 功能 | 请求体 |
|------|------|------|--------|
| `PUT` | `/api/sites/:id/runtime` | 更新运行时配置 | `{ keep_alive?, idle_timeout_secs? }` |
| `POST` | `/api/sites/:id/versions` | 创建新版本 | `{ code_dir? }`（可选，自动生成目录） |
| `PUT` | `/api/sites/:id/versions/:vid/activate` | 激活版本 | — |
| `GET` | `/api/sites/:id/versions` | 列出版本列表 | — |
| `POST` | `/api/sites/:id/deno/start` | 手动启动 Deno | — |
| `POST` | `/api/sites/:id/deno/stop` | 手动停止 Deno | — |
| `GET` | `/api/sites/:id/deno/status` | 查看 Deno 状态 | — |

`GET /api/sites/:id/deno/status` 响应示例：
```json
{
  "data": {
    "status": "running",
    "port": 41234,
    "pid": 12345,
    "uptime_secs": 360,
    "active_version_id": "abc-def"
  }
}
```

---

## 5. 命令执行安全

### SPWN_SECURITY_PRINCIPLE

所有子进程 spawn 必须通过统一 wrapper 函数，处理跨平台差异：
- Unix：使用 `bash -c` 执行命令
- Windows：使用 `cmd /C` 执行命令

Deno 启动必须显式传递可执行文件完整路径（优先从 `DENO_PATH` 配置读取）。

---

## 6. 模块结构

```
crates/server/src/
├── process/              # [新增]
│   ├── mod.rs            # ProcessManager: start/stop/status
│   └── deno.rs           # Deno 运行时：启动命令构建、健康检查
├── proxy/
│   └── mod.rs            # [新增] 反向代理 handler
├── api/
│   ├── mod.rs            # [更新] 新增版本/运行态路由
│   └── sites.rs          # [更新] 新增版本/运行态 handler
├── db/
│   ├── mod.rs            # [更新] 新增 versions 迁移
│   └── models.rs         # [更新] Version 模型 + 扩展 Site
├── routing/
│   └── mod.rs            # 不变
├── main.rs               # [更新] 启动后台巡检任务
├── lib.rs                # [更新] AppState 新增 process_manager
└── error.rs              # [更新] 新增错误变体
```

### AppState 扩展

```rust
pub struct AppState {
    pub db: SqlitePool,
    pub storage_dir: PathBuf,
    pub process_manager: ProcessManager,     // [新增]
}
```

---

## 7. 测试策略

- **单元测试**：Version CRUD、ProcessManager 状态机、端口分配逻辑
- **集成测试**：创建站点 → 部署版本 → 请求 `/api/` → 验证代理成功
- **Deno 依赖**：集成测试需系统安装 Deno。若无 Deno 运行时，通过环境变量 `SKIP_DENO_TESTS=1` 跳过相关测试。单元测试（不含 Deno 实际调用）始终运行。
- 测试隔离：临时目录 + 临时数据库

---

## 8. 关键决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 启动策略 | 按需冷启动 | 节省资源，类似 Serverless |
| 资源管理 | 可配置热启动/超时 | 灵活性：高性能场景选热启动，省钱场景选超时 |
| 版本管理 | 版本目录 + 激活指针 | 简单可靠，回滚只需改指针 |
| 代理路径 | 完整保留 /api 前缀 | 与主流框架 Router 对齐 |
| 新依赖 | 无（使用现有 reqwest） | reqwest 已在 workspace deps，无需新增 |
| Docker | deno 镜像或安装脚本 | docker-compose 中添加 deno 服务或同容器安装 |
