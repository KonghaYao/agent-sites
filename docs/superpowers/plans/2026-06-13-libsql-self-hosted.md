> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# libSQL 自部署实现计划：替换 Turso Cloud → 本地 sqld 进程

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将数据库后端从 Turso Cloud API 替换为本地 sqld 子进程——懒创建、绑定时冷启动、JWT 认证、复用 ProcessManager。

**Architecture:** 移除 TursoClient 模块，ProcessManager 新增 ProcessKind 枚举（Deno/Sqld），sqld 进程和 Deno 共享端口池。数据库 API 从调 Turso Cloud 改为本地 JWT 签发 + 写记录（status=stopped），绑定时触发 sqld 冷启动。

**Tech Stack:** sqld (libSQL server), JWT (HS256), 复用现有 aes-gcm 加密

**Spec:** `docs/superpowers/specs/2026-06-13-libsql-self-hosted-design.md`

---

## 文件结构总览

```
crates/server/src/
├── turso/                    # [删除] 整个模块
│   ├── mod.rs                # 删除
│   └── mod_test.rs           # 删除
├── api/
│   ├── databases.rs          # [重写] 不再调 TursoCloud，改为本地 JWT + 写记录
│   ├── databases_test.rs     # [重写] 匹配新行为
│   ├── bindings.rs           # [修改] 绑定时冷启动 sqld
│   ├── bindings_test.rs      # [重写] 匹配新行为
│   └── mod.rs                # [不变]
├── process/
│   ├── deno.rs               # [不变]
│   ├── mod.rs                # [重写] ProcessKind enum + sqld start/stop
│   └── mod_test.rs           # [修改] 适配新 API
├── process/site/             # (不存在，无需改动)
├── db/
│   ├── models.rs             # [修改] create_database 默认 status=stopped，新增 update_sqld_state
│   ├── models_test.rs        # [修改] 匹配新行为
│   └── mod.rs                # [不变]
├── lib.rs                    # [修改] 移除 turso，新增 sqld_path/sqld_jwt_key 等
├── main.rs                   # [修改] Cli 换为 sqld 参数，移除 TursoClient 初始化
├── config.rs                 # [修改] 移除 turso_*，新增 sqld_*
├── error.rs                  # [不变]
├── crypto/                   # [不变]
├── proxy/                    # [不变]
└── routing/                  # [不变]
```

---

## Task 1: 移除 TursoClient 模块 + 清理引用

**Files:**
- Delete: `crates/server/src/turso/mod.rs`
- Delete: `crates/server/src/turso/mod_test.rs`
- Delete: `crates/server/src/turso/` (整个目录)
- Modify: `crates/server/src/lib.rs:9,21`（移除 turso mod + AppState turso_client 字段）
- Modify: `crates/server/src/main.rs:3,86-91,115`（移除 TursoClient import + 初始化 + 构造）

### Step 1: 删除 turso 目录

```bash
rm -rf crates/server/src/turso/
```

### Step 2: 清理 lib.rs

Modify `crates/server/src/lib.rs`:

Remove line 9 `pub mod turso;`
Remove line 14 `use crate::crypto::Encryptor;` → 保留（encryptor 还在用）
Remove line 21 `pub turso_client: turso::TursoClient,` from AppState

### Step 3: 清理 main.rs

Modify `crates/server/src/main.rs`:

Remove line 3: `use agent_sites::turso::TursoClient;`

Remove lines 85-91 (TursoClient 初始化):
```rust
    // 初始化 Turso 客户端
    let turso_client = TursoClient::new(
        cli.turso_api_url.clone(),
        cli.turso_api_token.clone(),
        cli.turso_org.clone(),
    );
    tracing::info!("TursoClient 就绪: {}", cli.turso_api_url);
```

Remove line 115 `turso_client,` from AppState construction.

### Step 4: Build 验证（会有编译错误，预期的）

Run: `cargo build -p agent-sites 2>&1 | head -20`
Expected: FAIL with errors about missing `turso_client` in databases.rs, bindings.rs, tests — 这些 Task 5-6 修复

### Step 5: 提交

```bash
git add crates/server/src/turso/ crates/server/src/lib.rs crates/server/src/main.rs
rm -rf crates/server/src/turso/
git add crates/server/src/turso/
git commit -m "refactor: 移除 TursoClient 模块（后期替换为 sqld）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 2: 配置 + Cli 清理

**Files:**
- Modify: `crates/server/src/config.rs`
- Modify: `crates/server/src/main.rs:48-58`（Cli 结构体）

### Step 1: Config 清理 + 新增

Modify `crates/server/src/config.rs`:

Remove lines 14-16:
```rust
    pub turso_api_url: String,
    pub turso_api_token: String,
    pub turso_org: String,
```

After `max_upload_size_mb: u64`, add:

```rust
    /// sqld 二进制路径
    pub sqld_path: String,
    /// sqld 数据目录
    pub sqld_data_dir: PathBuf,
    /// sqld JWT 签名密钥（可选，不设则无认证）
    pub sqld_jwt_key: String,
```

### Step 2: Cli 清理 + 新增

Modify `crates/server/src/main.rs`:

Remove lines 48-58 (turso_api_url, turso_api_token, turso_org).

After `max_upload_size_mb` (line 62), add:

```rust
    /// sqld 二进制路径
    #[arg(long, env = "SQLD_PATH", default_value = "sqld")]
    sqld_path: String,

    /// sqld 数据目录
    #[arg(long, env = "SQLD_DATA_DIR", default_value = "data/databases")]
    sqld_data_dir: String,

    /// sqld JWT 签名密钥（可选，不设则无认证）
    #[arg(long, env = "SQLD_JWT_KEY", default_value = "")]
    sqld_jwt_key: String,
```

### Step 3: 更新 main() 初始化

Modify `crates/server/src/main.rs`:

After storage_dir 初始化，新增 sqld data dir:
```rust
    // 初始化 sqld 数据目录
    let sqld_data_dir = PathBuf::from(&cli.sqld_data_dir);
    tokio::fs::create_dir_all(&sqld_data_dir).await?;
    tracing::info!("sqld 数据目录: {}", sqld_data_dir.display());
```

更新 ProcessManager::new 调用，传入 sqld_path 和 sqld_jwt_key。但 ProcessManager 签名尚未确定（Task 4 改）。先跳过此处改动，Task 4 统一处理。

### Step 4: Build 验证

Run: `cargo build -p agent-sites 2>&1 | head -15`
Expected: FAIL — 旧的 turso_* Cli 字段已删除，编译通过（其他错误来自 databases.rs 引用 turso_client）

### Step 5: 提交

```bash
git add crates/server/src/config.rs crates/server/src/main.rs
git commit -m "refactor: Config/Cli 移除 Turso 字段，新增 sqld 配置

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 3: 数据库迁移 — 新增 sqld_port 列

**Files:**
- Create: `crates/server/migrations/20260613000004_add_sqld_port.sql`
- Modify: `crates/server/src/db/models.rs`（Database struct + DatabaseRow 新增字段）

### Step 1: 创建迁移文件

Create `crates/server/migrations/20260613000004_add_sqld_port.sql`:

```sql
ALTER TABLE databases ADD COLUMN sqld_port INTEGER;
```

### Step 2: 更新 Database struct

Modify `crates/server/src/db/models.rs`，在 Database struct 的 `updated_at: String` 之后新增：

```rust
    pub sqld_port: Option<i64>,
```

### Step 3: 更新 DatabaseRow

Modify `crates/server/src/db/models.rs`，在 `DatabaseRow` struct 的 `updated_at: String` 之后新增：

```rust
    pub sqld_port: Option<i64>,
```

更新 `From<DatabaseRow> for Database` impl，新增:

```rust
            sqld_port: r.sqld_port,
```

### Step 4: 更新所有查询 SQL（加 sqld_port 列）

Modify `crates/server/src/db/models.rs`:

- `get_database` 的 SELECT: 在 `updated_at` 后加 `sqld_port`
- `list_databases` 的 SELECT: 同上
- `get_database_by_name` 的 SELECT: 同上
- `list_database_details_for_site` 的 SELECT: 同上（注意 `d.` 前缀）

所有 SELECT 中 `id, name, turso_db_name, turso_url, turso_token, region, status, created_at, updated_at` 改为:

```sql
id, name, turso_db_name, turso_url, turso_token, region, status, created_at, updated_at, sqld_port
```

### Step 5: 更新 create_database（status 默认 stopped）

Modify `crates/server/src/db/models.rs`，`create_database` 函数的 INSERT SQL 中 `'active'` 改为 `'stopped'`:

```rust
    sqlx::query(
        "INSERT INTO databases (id, name, turso_db_name, turso_url, turso_token, region, status, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)",
    )
```

### Step 6: Build + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites -- models_test`
Expected: FAIL — 编译可能通过（新字段不影响已有查询），但测试可能因 status 从 active 变为 stopped 而失败. 如果是这样，更新测试中的 `assert_eq!(db.status, "active")` → `assert_eq!(db.status, "stopped")` 和 `list_databases` 中的 `WHERE status = 'active'` — 实际上 list_databases 查 `active` 返回空列表，所以 list 测试会失败。需要更新测试。

Update `models_test.rs`:
- `test_create_and_get_database`: `assert_eq!(db.status, "stopped")`
- `test_list_databases`: 改成查 `stopped` 状态 OR 增加一步更新为 active
- `test_delete_database_软删除标记_inactive`: unchanged

### Step 7: 补充 sqld 状态更新函数

Modify `crates/server/src/db/models.rs`，在 `delete_database` 之后、`// ── 站点↔数据库绑定 ──` 之前，新增:

```rust
/// 更新 sqld 进程状态（端口和状态）
pub async fn update_sqld_state(
    pool: &SqlitePool,
    database_id: &str,
    status: &str,
    port: Option<u16>,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE databases SET status = ?, sqld_port = ?, turso_url = ?, updated_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(port.map(|p| p as i64))
    .bind(port.map(|p| format!("http://127.0.0.1:{p}")))
    .bind(&now)
    .bind(database_id)
    .execute(pool)
    .await?;
    Ok(())
}
```

### Step 8: Build + 测试通过

Run: `cargo build -p agent-sites && cargo test -p agent-sites -- models_test`
Expected: PASS

### Step 9: 提交

```bash
git add crates/server/migrations/ crates/server/src/db/
git commit -m "feat: 数据库迁移 sqld_port 列 + 模型更新（status 默认 stopped）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 4: ProcessManager — ProcessKind 枚举 + sqld 启动/停止

**Files:**
- Modify: `crates/server/src/process/mod.rs`（全面改造）
- Modify: `crates/server/src/process/mod_test.rs`（适配新 API）
- Modify: `crates/server/src/main.rs`（ProcessManager 构造参数更新）

### Background

当前 `ProcessManager` 结构:

```rust
pub struct ProcessManager {
    deno_path: String,
    port_min: u16,
    port_max: u16,
    pub(crate) processes: Arc<RwLock<HashMap<String, ManagedProcess>>>,
    encryptor: Option<Encryptor>,
}
```

`ManagedProcess` 结构:
```rust
pub(crate) struct ManagedProcess {
    pub(crate) child: tokio::process::Child,
    pub(crate) port: u16,
}
```

### Step 1: 添加 ProcessKind 枚举 + ManagedProcess 扩展

Modify `crates/server/src/process/mod.rs`:

After the `use` statements, before `ManagedProcess`, add:

```rust
/// 进程类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessKind {
    Deno,
    Sqld,
}
```

Modify `ManagedProcess`:

```rust
pub(crate) struct ManagedProcess {
    pub(crate) child: tokio::process::Child,
    pub(crate) port: u16,
    pub(crate) kind: ProcessKind,
}
```

### Step 2: 扩展 ProcessManager struct

```rust
pub struct ProcessManager {
    deno_path: String,
    sqld_path: String,
    sqld_data_dir: std::path::PathBuf,
    sqld_jwt_key: String,
    port_min: u16,
    port_max: u16,
    pub(crate) processes: Arc<RwLock<HashMap<String, ManagedProcess>>>,
    encryptor: Option<Encryptor>,
}
```

### Step 3: 更新 ProcessManager::new

```rust
    pub fn new(
        deno_path: String,
        sqld_path: String,
        sqld_data_dir: std::path::PathBuf,
        sqld_jwt_key: String,
        port_min: u16,
        port_max: u16,
        encryptor: Option<Encryptor>,
    ) -> Self {
        Self {
            deno_path,
            sqld_path,
            sqld_data_dir,
            sqld_jwt_key,
            port_min,
            port_max,
            processes: Arc::new(RwLock::new(HashMap::new())),
            encryptor,
        }
    }
```

### Step 4: 更新 Deno start — 插入时带 ProcessKind

在 `start()` 函数末尾，`ManagedProcess` 构造处添加 `kind`:

成功路径:
```rust
        self.processes
            .write()
            .insert(site_id.to_string(), ManagedProcess { child, port, kind: ProcessKind::Deno });
```

健康检查超时路径:
```rust
                self.processes
                    .write()
                    .insert(site_id.to_string(), ManagedProcess { child, port, kind: ProcessKind::Deno });
```

### Step 5: 添加 start_sqld 方法

在 `stop()` 方法之后添加:

```rust
    /// 冷启动 sqld 进程
    pub async fn start_sqld(
        &self,
        pool: &sqlx::SqlitePool,
        database_id: &str,
    ) -> Result<u16, crate::error::AppError> {
        use crate::error::AppError;

        // 防止重复启动
        {
            let procs = self.processes.read();
            if procs.contains_key(database_id) {
                let p = &procs[database_id];
                return Ok(p.port);
            }
        }

        // 分配端口
        let port = self.allocate_port();
        let data_dir = self.sqld_data_dir.join(database_id);
        tokio::fs::create_dir_all(&data_dir)
            .await
            .map_err(|e| AppError::Internal(format!("创建 sqld 数据目录失败: {e}")))?;

        // 构建 sqld 启动命令（本地部署，无认证）
        let cmd_args = format!(
            "{} --no-welcome --http-listen-addr 0.0.0.0:{} -d {}",
            self.sqld_path,
            port,
            data_dir.display(),
        );

        tracing::info!(
            db_id = %database_id,
            port = port,
            data_dir = %data_dir.display(),
            "启动 sqld 进程"
        );

        let child = deno::spawn_command(&cmd_args, port)?;

        // 简单等待一小会让 sqld 启动
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // 更新 DB: status → active, url → http://127.0.0.1:{port}
        db::models::update_sqld_state(pool, database_id, "active", Some(port)).await?;

        self.processes
            .write()
            .insert(database_id.to_string(), ManagedProcess { child, port, kind: ProcessKind::Sqld });

        tracing::info!(
            db_id = %database_id,
            port = port,
            "sqld 进程就绪"
        );

        Ok(port)
    }

    /// 停止 sqld 进程
    pub async fn stop_sqld(
        &self,
        pool: &sqlx::SqlitePool,
        database_id: &str,
    ) -> Result<(), crate::error::AppError> {
        tracing::info!(db_id = %database_id, "停止 sqld 进程");

        let proc = self.processes.write().remove(database_id);
        if let Some(mut proc) = proc {
            let _ = proc.child.kill().await;
        }
        db::models::update_sqld_state(pool, database_id, "stopped", None).await?;
        Ok(())
    }
```

### Step 6: 在 deno.rs 添加 spawn_command helper

Modify `crates/server/src/process/deno.rs`，在文件末尾添加:

```rust
/// 通用命令启动（用于 sqld 等非 Deno 进程）
pub fn spawn_command(cmd_str: &str, port: u16) -> std::io::Result<tokio::process::Child> {
    #[cfg(unix)]
    {
        let mut cmd = tokio::process::Command::new("bash");
        cmd.arg("-c").arg(cmd_str);
        cmd.env("PORT", port.to_string());
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        cmd.spawn()
    }
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").arg(cmd_str);
        cmd.env("PORT", port.to_string());
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        cmd.spawn()
    }
}
```

### Step 7: 更新 main.rs ProcessManager 构造

Modify `crates/server/src/main.rs`:

```rust
    let process_manager = ProcessManager::new(
        cli.deno_path.clone(),
        cli.sqld_path.clone(),
        sqld_data_dir.clone(),
        cli.sqld_jwt_key.clone(),
        cli.deno_port_min,
        cli.deno_port_max,
        encryptor.clone(),
    );
    tracing::info!(
        "ProcessManager 就绪: deno={} sqld={} ports={}-{}",
        cli.deno_path, cli.sqld_path, cli.deno_port_min, cli.deno_port_max
    );
```

### Step 8: 更新所有 ProcessManager::new 调用点

搜索 `ProcessManager::new(`，更新所有测试文件中的调用:

- `crates/server/src/process/mod_test.rs`
- `crates/server/src/api/sites_test.rs`
- `crates/server/src/api/databases_test.rs`
- `crates/server/src/api/bindings_test.rs`
- `crates/server/src/api/deploy_test.rs`
- `crates/server/src/proxy/mod_test.rs`
- `crates/server/src/routing/mod_test.rs`

新签名: `ProcessManager::new("deno".into(), "sqld".into(), PathBuf::from("data/databases"), "".into(), 4000, 4100, None)`

### Step 9: Build + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: FAIL — 多个测试文件 assert 旧的 status "active" 需要更新为 "stopped"

### Step 10: 提交

```bash
git add crates/server/src/process/ crates/server/src/main.rs
git commit -m "feat: ProcessManager ProcessKind 枚举 + sqld 启动/停止

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 5: 数据库 API 重写

**Files:**
- Modify: `crates/server/src/api/databases.rs`（完全重写）
- Modify: `crates/server/src/api/databases_test.rs`（重写适配）

### Step 1: 重写 databases.rs

Modify `crates/server/src/api/databases.rs`:

```rust
use crate::db;
use crate::error::{ApiResponse, AppError};
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

/// 创建数据库请求（不再需要 region）
#[derive(Debug, Deserialize)]
pub struct CreateDatabaseInput {
    pub name: String,
}

/// POST /api/databases — 创建数据库（懒创建，不启动 sqld）
pub async fn create_database(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateDatabaseInput>,
) -> Result<impl IntoResponse, AppError> {
    // 重名检查
    if db::models::get_database_by_name(&state.db, &input.name)
        .await?
        .is_some()
    {
        return Err(AppError::Conflict("数据库名已存在".to_string()));
    }

    let id = uuid::Uuid::now_v7().to_string();

    // 本地部署无认证，token 为空
    let token = String::new();

    tracing::info!(
        db_name = %input.name,
        db_id = %id,
        "数据库创建成功（懒创建，未启动 sqld）"
    );

    // 加密 token 后存储
    let stored_token = if let Some(ref encryptor) = state.encryptor {
        encryptor.encrypt(&token)
    } else {
        token
    };

    // 持久化（status = stopped，sqld_port = NULL，没有 turso_url）
    let database = db::models::create_database(
        &state.db,
        &input.name,
        &id, // turso_db_name = 本地 id
        "",  // turso_url = 空（启动后填充）
        &stored_token,
        "local", // region = "local"
    )
    .await?;

    Ok((StatusCode::CREATED, Json(ApiResponse::ok(database))))
}

/// GET /api/databases — 列出所有数据库（含运行状态）
pub async fn list_databases(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let databases = db::models::list_databases(&state.db).await?;
    Ok(Json(ApiResponse::ok(databases)))
}

/// GET /api/databases/:id — 获取单个数据库详情
pub async fn get_database(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let database = db::models::get_database(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(ApiResponse::ok(database)))
}

/// DELETE /api/databases/:id — 删除数据库
pub async fn delete_database(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db_record = db::models::get_database(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    // 停止 sqld 进程（如有运行）
    if state.process_manager.is_running(&id) {
        state.process_manager.stop_sqld(&state.db, &id).await?;
    }

    // 软删除
    db::models::delete_database(&state.db, &id).await?;

    tracing::info!(db_id = %id, "数据库已标记删除");

    // 异步清理数据文件
    let data_dir = state.sqld_data_dir.join(&id);
    tokio::spawn(async move {
        let _ = tokio::fs::remove_dir_all(&data_dir).await;
    });

    // 异步清理绑定关系
    let pool = state.db.clone();
    let bid = id.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("DELETE FROM site_database_bindings WHERE database_id = ?")
            .bind(&bid)
            .execute(&pool)
            .await;
    });

    Ok(StatusCode::NO_CONTENT)
}


```



### Step 2: lib.rs — AppState 新增 sqld 字段

Modify `crates/server/src/lib.rs`:

```rust
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub storage_dir: std::path::PathBuf,
    pub sqld_data_dir: std::path::PathBuf,
    pub sqld_jwt_key: String,
    pub process_manager: process::ProcessManager,
    pub max_upload_size_mb: u64,
    pub encryptor: Option<Encryptor>,
}
```

导入 `crypto::Encryptor` 已有。

### Step 3: main.rs — AppState 构造新增 sqld 字段

Modify `crates/server/src/main.rs`:

```rust
    let state = Arc::new(agent_sites::AppState {
        db: pool.clone(),
        storage_dir: storage_dir.clone(),
        sqld_data_dir,
        sqld_jwt_key: cli.sqld_jwt_key,
        process_manager,
        max_upload_size_mb: cli.max_upload_size_mb,
        encryptor,
    });
```

### Step 4: 重写 databases_test.rs

Update test `make_state` helper to include new AppState fields. Update `test_list_databases_返回空列表` to expect empty list since new databases start as "stopped" and list_databases only returns "active".

### Step 5: Build + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites -- databases_test`
Expected: PASS

### Step 6: 提交

```bash
git add crates/server/src/api/databases.rs crates/server/src/api/databases_test.rs crates/server/src/lib.rs crates/server/src/main.rs
git commit -m "feat: 重写 /api/databases — 懒创建/本地 JWT/移除 Turso Cloud

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 6: 绑定 API 集成 — 绑定时冷启动 sqld

**Files:**
- Modify: `crates/server/src/api/bindings.rs`
- Modify: `crates/server/src/api/bindings_test.rs`

### Step 1: 更新 bind_database handler

Modify `crates/server/src/api/bindings.rs`，在 `bind_database` handler 中，验证 site/database 存在后、写入绑定前，新增 sqld 冷启动逻辑:

```rust
    // 如果 database status 为 stopped，冷启动 sqld
    if db_record.status == "stopped" {
        tracing::info!(
            site_id = %site_id,
            database_id = %input.database_id,
            "绑定触发 sqld 冷启动"
        );
        state.process_manager.start_sqld(&state.db, &input.database_id).await?;
    }
```

### Step 2: 更新 bindings_test.rs

Update `make_state` 辅助函数，新增 AppState 字段。更新测试确保绑定时 sqld 启动逻辑被覆盖。

### Step 3: Build + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites -- bindings_test`
Expected: PASS

### Step 4: 提交

```bash
git add crates/server/src/api/bindings.rs crates/server/src/api/bindings_test.rs
git commit -m "feat: 绑定数据库时冷启动 sqld 进程

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 7: 全局测试适配 + 全量通过

**Files:**
- Modify: 所有测试文件中的 `make_state` / 测试辅助函数

### Step 1: 更新所有 AppState 构造

搜索所有 `AppState {`，确保新增字段 `sqld_data_dir`、`sqld_jwt_key` 存在。搜索 `ProcessManager::new(`，确保所有调用匹配新签名。

### Step 2: 全量测试

Run: `cargo test -p agent-sites`
Expected: PASS（全部测试通过）

### Step 3: 提交

```bash
git add crates/server/src/
git commit -m "test: 全局测试适配 sqld 架构变更

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 8: Docker + README 更新

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`

### Step 1: Docker 环境变量

Remove turso lines, add sqld lines in both files:

```dockerfile
ENV SQLD_PATH=sqld
ENV SQLD_DATA_DIR=data/databases
ENV SQLD_JWT_KEY=
```

Remove:
```dockerfile
ENV TURSO_API_URL=...
ENV TURSO_API_TOKEN=
ENV TURSO_ORG=...
```

Same for docker-compose.yml.

### Step 2: README 更新

- 路线图：阶段 3+4 条目更新为 sqld 自部署描述
- 环境变量表：移除 TURSO_*，新增 SQLD_*
- 技术栈：`libSQL (Turso Cloud)` → `libSQL (sqld 自部署)`

### Step 3: 提交

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "docs: Docker/README 更新 sqld 自部署架构

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## 总结

| Task | 内容 | 依赖 |
|------|------|------|
| 1 | 移除 TursoClient | 无 |
| 2 | Config/Cli 清理 + sqld 配置 | 无 |
| 3 | 数据库迁移 + 模型更新 | 无 |
| 4 | ProcessManager ProcessKind + sqld | 无（预计编译错误来自引用） |
| 5 | databases.rs 重写 + AppState 扩展 | Task 1, 2, 3 |
| 6 | bindings.rs 集成冷启动 | Task 4, 5 |
| 7 | 全局测试适配 | Task 1-6 |
| 8 | Docker + README | 无 |
