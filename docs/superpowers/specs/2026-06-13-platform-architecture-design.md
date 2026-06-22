> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# Agent Sites 平台架构设计

## 项目概述

Agent Sites 是一个面向 AI Agent 的 Web 应用托管平台（PaaS）。Agent 通过 CLI + Skills 与平台交互，开发前后端项目，平台负责数据库、前端与后端部署。

### 核心流程

```
Agent 用 CLI 部署代码到平台存储目录
  → 平台分配端口、启动 Deno 进程
  → 主服务器反向代理路由请求
  → 数据用 Turso 隔离存储
```

### 技术栈

| 组件 | 技术 |
|------|------|
| 平台服务器 | Rust + axum + tokio |
| 数据库 | Turso (libSQL)，平台自身和各站点各自隔离 |
| 后端运行时 | Deno 进程，随机端口，主服务器反向代理 |
| 代码存储 | 本地文件系统 |
| Agent 交互 | CLI + Skills |
| 容器化 | Docker + docker-compose |

---

## 系统分解（4 阶段）

| 阶段 | 子项目 | 核心职责 | 可独立验证 |
|------|--------|---------|-----------|
| **1** | 核心平台 + 静态站点托管 | Site CRUD、文件系统静态文件服务、路由分发、SQLite 元数据库 | 能创建站点、访问静态页面 |
| **2** | Deno 进程管理 + 动态后端 | 进程生命周期、端口分配、反向代理、版本部署/回滚 | 站点后端代码能运行并响应请求 |
| **3** | CLI + Skills | Agent 命令行工具：创建/部署/回滚/管理 | Agent 能通过 CLI 完整操作平台 |
| **4** | 每站点数据库配置 | Turso DB 自动开通、连接信息下发 | 站点后端能连接自己的数据库 |

---

## 阶段 1 详细设计：核心平台 + 静态站点托管

### 1.1 路由策略

采用**路径前缀路由**：`/sites/{site_uuid}/{file_path}` → 站点。

```
请求: GET /sites/a1b2c3d4-e5f6-7uuid/index.html
  ↓
路由层: 提取 site_uuid → 查询 sites 表
  ↓ 找到站点 (status = active)
静态服务: 直接读取 {storage_dir}/{site_uuid}/index.html
  ↓ 返回文件内容（含 Content-Type 和 Cache-Control 头）
```

错误处理：
- 站点不存在 → 404
- 文件不存在 → 404
- 站点 status 非 active → 503

### 1.2 数据模型

阶段 1 只需一张表。版本管理表（versions）留到阶段 2。

```sql
CREATE TABLE sites (
    id          TEXT PRIMARY KEY,                 -- UUID v7
    name        TEXT NOT NULL,                    -- 显示名称
    status      TEXT NOT NULL DEFAULT 'active',   -- active | inactive
    created_at  TEXT NOT NULL,                    -- ISO 8601
    updated_at  TEXT NOT NULL                     -- ISO 8601
);

CREATE INDEX idx_sites_status ON sites(status);
```

> 存储路径由 id 派生：`{storage_dir}/{id}/`，无需数据库字段。

### 1.3 静态文件服务

```
data/
├── agent-sites.db          # 平台数据库
└── sites/                  # 站点静态文件存储目录
    └── {site_uuid}/        # 每站点一个子目录
        ├── index.html
        ├── css/
        │   └── style.css
        └── assets/
            └── app.js
```

文件服务行为：
- 直接从本地文件系统读取，零网络开销，最小 CPU 消耗
- Content-Type 通过 `mime_guess` 从文件扩展名推断
- 响应头包含 `Cache-Control: public, max-age=3600`
- 部署新版本时替换目录内容（阶段 3 CLI 实现）

### 1.4 模块结构

```
crates/server/src/
├── main.rs              # 入口，CLI 参数解析，启动 HTTP 服务
├── lib.rs               # create_app()，路由构建，AppState 定义
├── config.rs            # 配置（端口、DB 路径、存储目录）
├── error.rs             # 统一错误类型 + API 响应包装
├── db/
│   ├── mod.rs           # 数据库连接池初始化、迁移执行
│   └── models.rs        # Site 结构体、CRUD 操作
├── api/
│   ├── mod.rs           # API 路由汇总
│   └── sites.rs         # POST/GET/DELETE /api/sites
└── routing/
    └── mod.rs           # 路径解析、静态文件服务
```

### 1.5 Management API

| 方法 | 路径 | 请求体 | 功能 |
|------|------|--------|------|
| `POST` | `/api/sites` | `{ name }` | 创建站点，返回 `{ id, name, ... }` |
| `GET` | `/api/sites` | — | 列出所有 active 站点 |
| `GET` | `/api/sites/:id` | — | 获取单个站点详情 |
| `DELETE` | `/api/sites/:id` | — | 软删除（status → inactive） |
| `GET` | `/health` | — | 健康检查 |

响应格式统一为 JSON：
```json
{
  "data": { ... },
  "error": null
}
```

错误响应：
```json
{
  "data": null,
  "error": { "code": "NOT_FOUND", "message": "站点不存在" }
}
```

### 1.6 新增依赖

| 依赖 | 用途 |
|------|------|
| `mime_guess` | 静态文件 Content-Type 推断 |

> **数据库策略**：阶段 1 继续使用现有的 `sqlx` + 本地 SQLite，后续阶段再迁移到 Turso。
>
> **存储策略**：阶段 1 使用本地文件系统，静态文件直接从磁盘读取，无额外存储依赖。

### 1.7 配置项

| 配置 | 环境变量 | 默认值 |
|------|---------|--------|
| 监听地址 | `HOST` | `0.0.0.0` |
| 监听端口 | `PORT` | `3000` |
| 数据库路径 | `DATABASE_URL` | `sqlite:data/agent-sites.db` |
| 站点存储目录 | `STORAGE_DIR` | `data/sites` |

### 1.8 Docker 化

项目根目录包含 `Dockerfile` 和 `docker-compose.yml`：
- `Dockerfile`：多阶段构建，生成最小镜像
- `docker-compose.yml`：声明服务定义，挂载 data 卷，后续阶段可扩展（Deno、Turso 等）

### 1.9 测试策略

- **单元测试**：Site CRUD、静态文件服务
- **集成测试**：创建站点 → 请求静态文件 → 验证响应
- 测试隔离：使用临时目录和临时数据库

---

## 后续阶段预告

### 阶段 2：Deno 进程管理 + 动态后端
- 新增 `versions` 表追踪站点版本
- Process Manager 模块：Deno 进程启停、端口分配、健康检查
- 反向代理：`/sites/{uuid}/api/*` → Deno 进程
- 版本部署/回滚逻辑

### 阶段 3：CLI + Skills
- CLI 工具（可用 Rust 或 TypeScript 实现）
- 命令：create、deploy（写入存储目录 + 通知平台）、rollback、list
- Skills 定义文件

### 阶段 4：每站点数据库配置
- Turso DB 自动开通
- 连接信息下发给 Deno 进程（环境变量）
- 站点后端通过 libSQL 客户端连接
