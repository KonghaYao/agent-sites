> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 阶段 3+4 合并设计：CLI/Skills + Turso 数据库

**日期**: 2026-06-13
**状态**: Draft

---

## 一、目标

将阶段 3（CLI + Skills）和阶段 4（Per-site Turso 数据库）合并为一轮实现。核心交付：

1. **部署 API** — Agent 通过 `curl` 上传 tar.gz 包，平台自动解压、创建版本、激活
2. **数据库 API** — 平台集成 Turso API，Agent 通过 HTTP API 管理数据库资源
3. **站点↔数据库绑定** — 多对多绑定，Deno 进程启动时通过环境变量注入连接信息
4. **Skill 文件** — 定义文件教 Agent 如何通过 curl 与平台交互，覆盖部署和数据库全流程

CLI 工具不予实现，Skill + curl 作为唯一交互方式。

---

## 二、架构概览

```
┌─────────────────────────────────────────────────────┐
│  Skill 文件 (.claude/skills/agent-sites-deploy.md) │
│  → 教 Agent 如何通过 curl 与平台交互               │
└──────────────────────┬──────────────────────────────┘
                       │ curl
┌──────────────────────▼──────────────────────────────┐
│  新增 API 端点                                       │
│  /api/sites/:id/deploy     — 上传部署               │
│  /api/databases            — Turso 数据库 CRUD      │
│  /api/sites/:id/bindings   — 站点↔数据库绑定管理     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Turso API Client (平台内部)                         │
│  → 创建数据库 / 生成 token / 删除                    │
└──────────────────────┬──────────────────────────────┘
                       │ 环境变量注入
┌──────────────────────▼──────────────────────────────┐
│  Deno 站点运行时                                     │
│  → 读取 TURSO_DB_<name>_URL / TOKEN 直接连库         │
└─────────────────────────────────────────────────────┘
```

Agent 完整流程：`写代码 → 打包 tar.gz → curl 上传 → 平台自动部署并注入数据库连接信息`

---

## 三、部署 API

### 3.1 上传包约定

tar.gz 内容结构（约定优于配置）：

```
site.tar.gz
├── main.ts          # Deno 入口（必需）
├── public/          # 静态文件目录（可选）
│   ├── index.html
│   └── ...
└── deps.ts          # 其他源文件（可选）
```

### 3.2 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sites/:id/deploy` | 上传 tar.gz，创建版本并激活 |

- **Body**: `multipart/form-data`，字段 `file`（.tar.gz）
- **响应**: `{ version: { id, code_dir, created_at }, activated: true }`
- **平台行为**:
  1. 校验文件扩展名 `.tar.gz`
  2. 校验文件大小 ≤ `max_upload_size_mb`（默认 50MB）
  3. 解压到 `{storage_dir}/{site_id}/versions/{version_id}/`
  4. 验证 `main.ts` 存在于根目录
  5. 创建版本记录，自动激活
  6. 如有运行中的旧 Deno 进程，停止之（下次请求触发冷启动）

### 3.3 错误响应

| 场景 | HTTP 状态 | 错误消息 |
|------|-----------|----------|
| 文件不是 tar.gz | 400 | `格式错误：仅支持 .tar.gz` |
| 包中无 main.ts | 400 | `入口文件缺失：main.ts 必须位于根目录` |
| 文件超过大小限制 | 413 | `文件过大：上限 X MB` |
| 站点不存在 | 404 | `站点不存在` |
| 解包/IO 失败 | 500 | `内部错误`（details 写 tracing） |

---

## 四、数据库 API

### 4.1 数据模型

新增两张表：

```sql
CREATE TABLE databases (
    id            TEXT PRIMARY KEY,        -- UUID
    name          TEXT NOT NULL,            -- 显示名称
    turso_db_name TEXT NOT NULL UNIQUE,     -- Turso 上的数据库名
    turso_url     TEXT NOT NULL,            -- libsql://xxx.turso.io
    turso_token   TEXT NOT NULL,            -- 访问 token
    region        TEXT DEFAULT 'auto',      -- Turso 区域
    status        TEXT DEFAULT 'active',    -- active / inactive
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE site_database_bindings (
    site_id     TEXT NOT NULL,
    database_id TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (site_id, database_id),
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (database_id) REFERENCES databases(id)
);
```

### 4.2 数据库资源管理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/databases` | 创建 Turso 数据库 |
| `GET` | `/api/databases` | 列出所有 active 数据库 |
| `GET` | `/api/databases/:id` | 获取单个数据库详情（含绑定站点列表） |
| `DELETE` | `/api/databases/:id` | 软删除数据库（标记 inactive，不删 Turso 资源） |

**创建请求体**:

```json
{ "name": "my-db", "region": "auto" }
```

**创建响应**:

```json
{
  "id": "uuid",
  "name": "my-db",
  "turso_db_name": "org-my-db-xxxx",
  "turso_url": "libsql://org-my-db-xxxx.turso.io",
  "region": "auto",
  "status": "active",
  "created_at": "..."
}
```

### 4.3 站点绑定管理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sites/:id/bindings` | 绑定数据库到站点 |
| `GET` | `/api/sites/:id/bindings` | 查看站点已绑定的数据库列表 |
| `DELETE` | `/api/sites/:id/bindings/:db_id` | 解绑 |

**绑定请求体**:

```json
{ "database_id": "<db_id>" }
```

### 4.4 错误响应

| 场景 | HTTP 状态 | 错误消息 |
|------|-----------|----------|
| 数据库名重复 | 409 | `数据库名已存在` |
| 绑定已存在 | 409 | `该数据库已绑定此站点` |
| 数据库/站点不存在 | 404 | `数据库不存在` / `站点不存在` |
| Turso API 调用失败 | 500 | `数据库服务暂不可用` |

---

## 五、运行时环境变量注入

Deno 进程启动时（`ProcessManager::start`），平台查询站点绑定的所有数据库，作为环境变量注入子进程：

```
TURSO_DB_<name>_URL=libsql://xxx.turso.io
TURSO_DB_<name>_TOKEN=xxx
```

`<name>` 为数据库的 `name` 字段，大写化、非字母数字替换为 `_`。

站点代码使用示例：

```ts
import { createClient } from "@libsql/client";

const db = createClient({
    url: Deno.env.get("TURSO_DB_MY_DB_URL")!,
    authToken: Deno.env.get("TURSO_DB_MY_DB_TOKEN")!,
});
```

---

## 六、Turso API Client（平台内部模块）

新增 `crates/server/src/turso/` 模块，封装与 Turso Platform API 的交互：

```rust
// 模块概览
pub struct TursoClient {
    api_url: String,   // https://api.turso.tech
    api_token: String,
    org: String,
    client: reqwest::Client,
}

impl TursoClient {
    pub async fn create_database(&self, name: &str, region: &str) -> Result<TursoDatabase>;
    pub async fn delete_database(&self, db_name: &str) -> Result<()>;
}
```

`TursoDatabase` 返回结构包含 `Name`、`Hostname`、从 `/v1/organizations/{org}/databases/{name}/auth-tokens` 获取的 token。

---

## 七、配置扩展

`Config` 新增字段：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `turso_api_url` | Turso API 地址 | `https://api.turso.tech` |
| `turso_api_token` | Turso API Token | 环境变量 `TURSO_API_TOKEN` |
| `turso_org` | Turso 组织名 | 环境变量 `TURSO_ORG` |
| `max_upload_size_mb` | 上传文件大小上限 | `50` |

---

## 八、Skill 文件

文件路径：`.claude/skills/agent-sites-deploy/SKILL.md`

内容覆盖：

1. **部署流程** — 打包 tar.gz、curl 上传、状态验证
2. **数据库管理流程** — 创建 DB、绑定站点、解绑、删除
3. **站点代码中使用数据库** — 环境变量读取说明
4. **完整新站点创建流程** — 从创建站点到部署到绑定数据库的端到端 curl 命令序列
5. **常见问题** — 部署失败排查、数据库连接问题

---

## 九、实现任务拆分

| # | Task | 涉及模块 |
|---|------|----------|
| 1 | 数据库迁移 | `migrations/` — databases + site_database_bindings 表 |
| 2 | Turso Client | `src/turso/` — Turso API 封装 |
| 3 | 数据库 CRUD API | `src/api/databases.rs` |
| 4 | 站点绑定 API | `src/api/bindings.rs`（或合并到 sites.rs） |
| 5 | 部署 API | `src/api/deploy.rs` — tar.gz 上传/解压/验证/激活 |
| 6 | 环境变量注入 | 扩展 `src/process/mod.rs` — start() 注入 TURSO_DB_* |
| 7 | Skill 文件 | `.claude/skills/agent-sites-deploy/SKILL.md` |
| 8 | 配置扩展 | `src/config.rs` — 新增 Turso/上传相关字段 |

---

## 十、设计决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 交互方式 | Skill + curl，无 CLI | 减少维护成本，curl 足够覆盖所有需求 |
| 包格式 | tar.gz，约定目录结构 | 简单通用，无需额外配置 |
| 数据库关系 | 多对多 | 允许灵活组合（一站点多库，一库多站点） |
| DB 生命周期 | 平台通过 Turso API 自动管理 | Agent 不需要直接接触 Turso |
| 环境变量命名 | `TURSO_DB_<name>_URL/TOKEN` | 直观，与 libsql client SDK 兼容 |
| 删除策略 | 软删除（标记 inactive） | 防止误删数据，保留审计记录 |
