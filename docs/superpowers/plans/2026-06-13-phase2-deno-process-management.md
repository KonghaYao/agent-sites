> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 阶段 2：Deno 进程管理 + 动态后端 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 支持 Agent 站点运行动态后端——平台管理 Deno 进程（按需冷启动 + 可配置热启动/超时），反向代理 `/sites/{uuid}/api/*` 到 Deno，支持版本部署/回滚。

**Architecture:** ProcessManager 管理 Deno 进程生命周期（parking_lot::RwLock 内同步），DB 存储运行态（deno_status/port），reqwest 做反向代理透传请求/响应，后台 tokio 任务巡检空闲进程。

**Tech Stack:** axum 0.8, sqlx 0.8, reqwest 0.12, parking_lot 0.12, Deno, tokio::process

**Spec:** `docs/superpowers/specs/2026-06-13-phase2-deno-process-management-design.md`

---

## 文件结构总览

```
crates/server/src/
├── process/                  # [新建]
│   ├── mod.rs                # ProcessManager (start/stop/status)
│   ├── deno.rs               # Deno spawn + 健康检查
│   └── mod_test.rs           # ProcessManager 单元测试
├── proxy/                    # [新建]
│   ├── mod.rs                # 反向代理 handler
│   └── mod_test.rs           # 代理测试
├── db/
│   ├── mod.rs                # 不变
│   └── models.rs             # [修改] Version 模型 + Site 扩展字段 + 运行态 CRUD
├── api/
│   ├── mod.rs                # [修改] 新增路由
│   ├── sites.rs              # [修改] 新增版本/运行态 handler
│   └── sites_test.rs         # [修改] 新增 API 测试
├── lib.rs                    # [修改] AppState 扩展 + create_app
├── main.rs                   # [修改] 初始化 PM + 后台巡检任务 + 新 CLI 参数
├── error.rs                  # [修改] 新增错误变体
└── config.rs                 # [修改] 新增 Deno 配置项

crates/server/migrations/
└── 20260613000002_add_versions.sql  # [新建] versions 表 + sites 列扩展

项目根目录：
├── docker-compose.yml        # [修改] 添加 Deno 安装
└── Dockerfile                # [修改] 安装 Deno
```

---

## Task 1: 数据库迁移 + Version 模型 + Site 运行态字段

**Files:**
- Create: `crates/server/migrations/20260613000002_add_versions.sql`
- Modify: `crates/server/src/db/models.rs`（新增 Version + 扩展 Site + 运行态 CRUD）

- [ ] **Step 1: 创建迁移文件**

Create `crates/server/migrations/20260613000002_add_versions.sql`:

```sql
CREATE TABLE versions (
    id          TEXT PRIMARY KEY,
    site_id     TEXT NOT NULL,
    code_dir    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

ALTER TABLE sites ADD COLUMN active_version_id TEXT;
ALTER TABLE sites ADD COLUMN deno_port INTEGER;
ALTER TABLE sites ADD COLUMN deno_status TEXT DEFAULT 'stopped';
ALTER TABLE sites ADD COLUMN keep_alive INTEGER DEFAULT 0;
ALTER TABLE sites ADD COLUMN idle_timeout_secs INTEGER DEFAULT 300;
ALTER TABLE sites ADD COLUMN last_activity_at TEXT;

CREATE INDEX idx_versions_site_id ON versions(site_id);
```

- [ ] **Step 2: 运行迁移验证**

Run: `cargo test` — 确认当前所有测试仍通过（迁移在运行时执行，不影响已有测试）

- [ ] **Step 3: 扩展 Site 模型与 CRUD**

Replace `crates/server/src/db/models.rs`:

```rust
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

// ── 站点 ──

/// 站点记录（含运行态字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Site {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    // 运行态字段
    pub active_version_id: Option<String>,
    pub deno_port: Option<i64>,
    pub deno_status: String,
    pub keep_alive: bool,
    pub idle_timeout_secs: i64,
    pub last_activity_at: Option<String>,
}

/// 创建站点请求
#[derive(Debug, Deserialize)]
pub struct CreateSiteInput {
    pub name: String,
}

/// 创建站点（运行态字段使用默认值）
pub async fn create_site(pool: &SqlitePool, name: &str) -> Result<Site, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let id = Uuid::now_v7().to_string();

    sqlx::query(
        "INSERT INTO sites (id, name, status, created_at, updated_at) \
         VALUES (?, ?, 'active', ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let site = get_site(pool, &id).await?.ok_or(sqlx::Error::RowNotFound)?;
    Ok(site)
}

/// 按 ID 查询站点
pub async fn get_site(pool: &SqlitePool, id: &str) -> Result<Option<Site>, sqlx::Error> {
    let row = sqlx::query_as::<_, SiteRow>(
        "SELECT id, name, status, created_at, updated_at, \
         active_version_id, deno_port, deno_status, \
         keep_alive, idle_timeout_secs, last_activity_at \
         FROM sites WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.into()))
}

/// 列出所有 active 站点
pub async fn list_sites(pool: &SqlitePool) -> Result<Vec<Site>, sqlx::Error> {
    let rows = sqlx::query_as::<_, SiteRow>(
        "SELECT id, name, status, created_at, updated_at, \
         active_version_id, deno_port, deno_status, \
         keep_alive, idle_timeout_secs, last_activity_at \
         FROM sites WHERE status = 'active' ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| r.into()).collect())
}

/// 软删除站点
pub async fn delete_site(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE sites SET status = 'inactive', updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;

    Ok(result.rows_affected() > 0)
}

/// 更新 Deno 运行态（status / port / last_activity_at）
pub async fn update_deno_state(
    pool: &SqlitePool,
    site_id: &str,
    status: &str,
    port: Option<u16>,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE sites SET deno_status = ?, deno_port = ?, updated_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(port.map(|p| p as i64))
    .bind(&now)
    .bind(site_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 更新 last_activity_at
pub async fn touch_activity(pool: &SqlitePool, site_id: &str) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE sites SET last_activity_at = ? WHERE id = ?")
        .bind(&now)
        .bind(site_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 更新站点运行时配置
pub async fn update_site_runtime(
    pool: &SqlitePool,
    site_id: &str,
    keep_alive: Option<bool>,
    idle_timeout_secs: Option<i64>,
) -> Result<bool, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let keep = keep_alive.map(|v| v as i64);
    let result = if let (Some(k), Some(t)) = (keep, idle_timeout_secs) {
        sqlx::query("UPDATE sites SET keep_alive = ?, idle_timeout_secs = ?, updated_at = ? WHERE id = ?")
            .bind(k).bind(t).bind(&now).bind(site_id).execute(pool).await?
    } else if let Some(k) = keep {
        sqlx::query("UPDATE sites SET keep_alive = ?, updated_at = ? WHERE id = ?")
            .bind(k).bind(&now).bind(site_id).execute(pool).await?
    } else if let Some(t) = idle_timeout_secs {
        sqlx::query("UPDATE sites SET idle_timeout_secs = ?, updated_at = ? WHERE id = ?")
            .bind(t).bind(&now).bind(site_id).execute(pool).await?
    } else {
        return Ok(false);
    };

    Ok(result.rows_affected() > 0)
}

/// 设置激活版本
pub async fn set_active_version(
    pool: &SqlitePool,
    site_id: &str,
    version_id: &str,
) -> Result<bool, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE sites SET active_version_id = ?, updated_at = ? WHERE id = ?",
    )
    .bind(version_id)
    .bind(&now)
    .bind(site_id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

// ── 版本 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub site_id: String,
    pub code_dir: String,
    pub created_at: String,
}

/// 创建新版本
pub async fn create_version(
    pool: &SqlitePool,
    site_id: &str,
) -> Result<Version, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let id = Uuid::now_v7().to_string();
    let code_dir = format!("versions/{}", id);

    sqlx::query(
        "INSERT INTO versions (id, site_id, code_dir, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(site_id)
    .bind(&code_dir)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Version {
        id,
        site_id: site_id.to_string(),
        code_dir,
        created_at: now,
    })
}

/// 列出站点的所有版本
pub async fn list_versions(pool: &SqlitePool, site_id: &str) -> Result<Vec<Version>, sqlx::Error> {
    let rows = sqlx::query_as::<_, VersionRow>(
        "SELECT id, site_id, code_dir, created_at FROM versions \
         WHERE site_id = ? ORDER BY created_at DESC",
    )
    .bind(site_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| r.into()).collect())
}

/// 按 ID 查询版本
pub async fn get_version(pool: &SqlitePool, id: &str) -> Result<Option<Version>, sqlx::Error> {
    let row = sqlx::query_as::<_, VersionRow>(
        "SELECT id, site_id, code_dir, created_at FROM versions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.into()))
}

/// 查询所有 running 状态的站点（用于后台巡检）
pub async fn list_running_sites(pool: &SqlitePool) -> Result<Vec<Site>, sqlx::Error> {
    let rows = sqlx::query_as::<_, SiteRow>(
        "SELECT id, name, status, created_at, updated_at, \
         active_version_id, deno_port, deno_status, \
         keep_alive, idle_timeout_secs, last_activity_at \
         FROM sites WHERE deno_status = 'running'",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| r.into()).collect())
}

// ── 内部映射类型 ──

#[derive(sqlx::FromRow)]
struct SiteRow {
    id: String,
    name: String,
    status: String,
    created_at: String,
    updated_at: String,
    active_version_id: Option<String>,
    deno_port: Option<i64>,
    deno_status: String,
    keep_alive: i64,
    idle_timeout_secs: i64,
    last_activity_at: Option<String>,
}

impl From<SiteRow> for Site {
    fn from(r: SiteRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            status: r.status,
            created_at: r.created_at,
            updated_at: r.updated_at,
            active_version_id: r.active_version_id,
            deno_port: r.deno_port.map(|p| p),
            deno_status: r.deno_status,
            keep_alive: r.keep_alive != 0,
            idle_timeout_secs: r.idle_timeout_secs,
            last_activity_at: r.last_activity_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    id: String,
    site_id: String,
    code_dir: String,
    created_at: String,
}

impl From<VersionRow> for Version {
    fn from(r: VersionRow) -> Self {
        Self {
            id: r.id,
            site_id: r.site_id,
            code_dir: r.code_dir,
            created_at: r.created_at,
        }
    }
}

#[cfg(test)]
#[path = "models_test.rs"]
mod models_test;
```

- [ ] **Step 4: 更新测试文件**

Create `crates/server/src/db/models_test.rs` (replace contents):

```rust
use super::*;

async fn make_test_pool() -> (tempfile::TempDir, sqlx::SqlitePool) {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = crate::db::init_pool(&db_url).await.unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    (temp, pool)
}

// ── Site CRUD tests ──

#[tokio::test]
async fn test_创建站点_返回带id的完整记录() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "测试站点").await.unwrap();
    assert!(!site.id.is_empty());
    assert_eq!(site.name, "测试站点");
    assert_eq!(site.status, "active");
    assert_eq!(site.deno_status, "stopped");
    assert!(!site.keep_alive);
    assert_eq!(site.idle_timeout_secs, 300);
}

#[tokio::test]
async fn test_查询单个站点_存在的id返回记录() {
    let (_temp, pool) = make_test_pool().await;
    let created = create_site(&pool, "站点A").await.unwrap();
    let found = get_site(&pool, &created.id).await.unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().name, "站点A");
}

#[tokio::test]
async fn test_查询单个站点_不存在的id返回none() {
    let (_temp, pool) = make_test_pool().await;
    let found = get_site(&pool, "不存在的id").await.unwrap();
    assert!(found.is_none());
}

#[tokio::test]
async fn test_列出站点_只返回active状态() {
    let (_temp, pool) = make_test_pool().await;
    create_site(&pool, "站点A").await.unwrap();
    let site_b = create_site(&pool, "站点B").await.unwrap();
    delete_site(&pool, &site_b.id).await.unwrap();
    let sites = list_sites(&pool).await.unwrap();
    assert_eq!(sites.len(), 1);
    assert_eq!(sites[0].name, "站点A");
}

#[tokio::test]
async fn test_删除站点_软删除后状态变为inactive() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "待删除").await.unwrap();
    delete_site(&pool, &site.id).await.unwrap();
    let found = get_site(&pool, &site.id).await.unwrap().unwrap();
    assert_eq!(found.status, "inactive");
}

#[tokio::test]
async fn test_更新deno状态_状态变为running并设置端口() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "站点").await.unwrap();
    update_deno_state(&pool, &site.id, "running", Some(41234)).await.unwrap();
    let updated = get_site(&pool, &site.id).await.unwrap().unwrap();
    assert_eq!(updated.deno_status, "running");
    assert_eq!(updated.deno_port, Some(41234));
}

#[tokio::test]
async fn test_更新运行时配置_修改keep_alive和超时() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "站点").await.unwrap();
    update_site_runtime(&pool, &site.id, Some(true), Some(600)).await.unwrap();
    let updated = get_site(&pool, &site.id).await.unwrap().unwrap();
    assert!(updated.keep_alive);
    assert_eq!(updated.idle_timeout_secs, 600);
}

// ── Version CRUD tests ──

#[tokio::test]
async fn test_创建版本_返回带id和目录的记录() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "站点").await.unwrap();
    let version = create_version(&pool, &site.id).await.unwrap();
    assert!(!version.id.is_empty());
    assert_eq!(version.site_id, site.id);
    assert!(version.code_dir.starts_with("versions/"));
}

#[tokio::test]
async fn test_列出站点版本_按创建时间倒序() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "站点").await.unwrap();
    let v1 = create_version(&pool, &site.id).await.unwrap();
    let v2 = create_version(&pool, &site.id).await.unwrap();
    let versions = list_versions(&pool, &site.id).await.unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].id, v2.id); // 最新在前
}

#[tokio::test]
async fn test_设置激活版本_站点记录更新() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "站点").await.unwrap();
    let version = create_version(&pool, &site.id).await.unwrap();
    set_active_version(&pool, &site.id, &version.id).await.unwrap();
    let updated = get_site(&pool, &site.id).await.unwrap().unwrap();
    assert_eq!(updated.active_version_id, Some(version.id));
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cargo test -p agent-sites db::models_test`
Expected: 10 tests passed

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: versions 迁移 + Site/Version 模型扩展

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

## Task 2: ProcessManager + Deno 封装

**Files:**
- Create: `crates/server/src/process/deno.rs`
- Create: `crates/server/src/process/mod.rs`
- Create: `crates/server/src/process/mod_test.rs`

- [ ] **Step 1: 实现 Deno 封装**

Create `crates/server/src/process/deno.rs`:

```rust
use std::process::Stdio;
use tokio::process::{Child, Command};

/// 跨平台 Deno 进程启动（通过 bash -c / cmd /C）
#[cfg(unix)]
pub fn spawn_deno(
    main_ts_path: &str,
    port: u16,
    deno_path: &str,
) -> std::io::Result<Child> {
    let cmd_str = format!(
        "{} run --allow-net --allow-env {}",
        deno_path, main_ts_path
    );
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(&cmd_str);
    cmd.env("PORT", port.to_string());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    cmd.spawn()
}

#[cfg(windows)]
pub fn spawn_deno(
    main_ts_path: &str,
    port: u16,
    deno_path: &str,
) -> std::io::Result<Child> {
    let cmd_str = format!(
        "{} run --allow-net --allow-env {}",
        deno_path, main_ts_path
    );
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(&cmd_str);
    cmd.env("PORT", port.to_string());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    cmd.spawn()
}

/// 轮询健康检查：GET http://localhost:{port}/api/health
pub async fn wait_for_health(port: u16, timeout_secs: u64) -> bool {
    let url = format!("http://localhost:{port}/api/health");
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        match client.get(&url).timeout(std::time::Duration::from_millis(500)).send().await {
            Ok(resp) if resp.status().is_success() => return true,
            _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
        }
    }
}
```

- [ ] **Step 2: 实现 ProcessManager**

Create `crates/server/src/process/mod.rs`:

```rust
pub mod deno;

use crate::db;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

/// 正在运行的子进程信息
pub(crate) struct ManagedProcess {
    pub(crate) child: tokio::process::Child,
    pub(crate) port: u16,
}

/// Deno 进程管理器
pub struct ProcessManager {
    deno_path: String,
    port_min: u16,
    port_max: u16,
    processes: pub(crate) Arc<RwLock<HashMap<String, ManagedProcess>>>,
}

impl ProcessManager {
    pub fn new(deno_path: String, port_min: u16, port_max: u16) -> Self {
        Self {
            deno_path,
            port_min,
            port_max,
            processes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 冷启动：分配端口 → 标记 starting → 起进程 → 健康检查 → 标记 running
    pub async fn start(
        &self,
        pool: &sqlx::SqlitePool,
        storage_dir: &std::path::Path,
        site_id: &str,
    ) -> Result<u16, crate::error::AppError> {
        use crate::error::AppError;

        // 防止重复启动
        {
            let procs = self.processes.read();
            if procs.contains_key(site_id) {
                let p = &procs[site_id];
                return Ok(p.port);
            }
        }

        // 获取活跃版本
        let site = db::models::get_site(pool, site_id)
            .await?
            .ok_or(AppError::NotFound)?;
        let version_id = site.active_version_id.as_ref().ok_or_else(|| {
            AppError::BadRequest("站点未设置活跃版本".to_string())
        })?;
        let version = db::models::get_version(pool, version_id)
            .await?
            .ok_or(AppError::NotFound)?;

        // 标记 starting
        db::models::update_deno_state(pool, site_id, "starting", None).await?;

        // 分配端口
        let port = self.allocate_port();

        // 构建代码路径
        let main_ts = storage_dir
            .join(site_id)
            .join(&version.code_dir)
            .join("main.ts");
        let main_ts_str = main_ts.to_string_lossy().to_string();

        // 启动进程
        let child = deno::spawn_deno(&main_ts_str, port, &self.deno_path)
            .map_err(|e| AppError::Internal(format!("Deno 启动失败: {e}")))?;

        // 健康检查
        let healthy = deno::wait_for_health(port, 10).await;
        if !healthy {
            // 超时：尝试 kill，标记 error
            let mut child = child;
            let _ = child.kill().await;
            db::models::update_deno_state(pool, site_id, "error", Some(port)).await?;
            return Err(AppError::Internal("Deno 健康检查超时".to_string()));
        }

        // 成功：标记 running
        db::models::update_deno_state(pool, site_id, "running", Some(port)).await?;
        self.processes.write().insert(
            site_id.to_string(),
            ManagedProcess { child, port },
        );

        Ok(port)
    }

    /// 停止进程
    pub async fn stop(
        &self,
        pool: &sqlx::SqlitePool,
        site_id: &str,
    ) -> Result<(), crate::error::AppError> {
        if let Some(mut proc) = self.processes.write().remove(site_id) {
            let _ = proc.child.kill().await;
        }
        db::models::update_deno_state(pool, site_id, "stopped", None).await?;
        Ok(())
    }

    /// 检查进程是否在运行
    pub fn is_running(&self, site_id: &str) -> bool {
        self.processes.read().contains_key(site_id)
    }

    /// 获取运行中进程的端口
    pub fn get_port(&self, site_id: &str) -> Option<u16> {
        self.processes.read().get(site_id).map(|p| p.port)
    }

    /// 分配一个可用端口（扫描范围内首个未被占用的）
    fn allocate_port(&self) -> u16 {
        let procs = self.processes.read();
        let used: Vec<u16> = procs.values().map(|p| p.port).collect();
        (self.port_min..=self.port_max)
            .find(|p| !used.contains(p))
            .unwrap_or(self.port_min)
    }
}
```

- [ ] **Step 3: 写 ProcessManager 单元测试**

Create `crates/server/src/process/mod_test.rs`:

```rust
use super::*;

#[test]
fn test_端口分配_不重复() {
    let pm = ProcessManager::new("deno".into(), 4000, 4010);
    let port1 = pm.allocate_port();
    let port2 = pm.allocate_port();
    assert_eq!(port1, 4000);
    assert_eq!(port2, 4001); // 还未加锁，所以两次都从头扫描

    // 模拟占用后重新分配
    pm.processes.write().insert(
        "s1".into(),
        ManagedProcess { child: tokio::process::Command::new("echo").arg("test").spawn().unwrap(), port: 4000 },
    );
    let port3 = pm.allocate_port();
    assert_eq!(port3, 4001); // 跳过 4000

    pm.processes.write().insert(
        "s2".into(),
        ManagedProcess { child: tokio::process::Command::new("echo").arg("test").spawn().unwrap(), port: 4001 },
    );
    let port4 = pm.allocate_port();
    assert_eq!(port4, 4002); // 跳过 4000, 4001
}

#[test]
fn test_进程管理_检查运行状态() {
    let pm = ProcessManager::new("deno".into(), 4000, 4010);
    assert!(!pm.is_running("s1"));

    let child = tokio::process::Command::new("sleep")
        .arg("10")
        .spawn()
        .unwrap();
    pm.processes.write().insert(
        "s1".into(),
        ManagedProcess { child, port: 4000 },
    );
    assert!(pm.is_running("s1"));
    assert_eq!(pm.get_port("s1"), Some(4000));
}

#[test]
fn test_端口范围_超出上限回绕() {
    let pm = ProcessManager::new("deno".into(), 4000, 4000);
    // 只有一个可用端口，占用后再次分配应回绕到起始
    let child = tokio::process::Command::new("sleep")
        .arg("10")
        .spawn()
        .unwrap();
    pm.processes.write().insert(
        "s1".into(),
        ManagedProcess { child, port: 4000 },
    );
    let port = pm.allocate_port();
    assert_eq!(port, 4000); // 回绕
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cargo test -p agent-sites process::mod_test`
Expected: 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ProcessManager + Deno 封装 (冷启动/健康检查/端口分配)

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

## Task 3: 反向代理 Handler

**Files:**
- Create: `crates/server/src/proxy/mod.rs`
- Create: `crates/server/src/proxy/mod_test.rs`

- [ ] **Step 1: 写失败测试**

Create `crates/server/src/proxy/mod_test.rs`:

```rust
use super::*;
use crate::process::ProcessManager;
use crate::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;

/// 以同步方式创建测试 AppState（需在 #[tokio::test] 中调用）
async fn make_test_state() -> (tempfile::TempDir, Arc<AppState>) {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = crate::db::init_pool(&db_url).await.unwrap();
    crate::db::run_migrations(&pool).await.unwrap();

    let state = Arc::new(AppState {
        db: pool,
        storage_dir: temp.path().to_path_buf(),
        process_manager: ProcessManager::new("deno".into(), 4000, 5000),
    });
    (temp, state)
}

fn make_router(state: Arc<AppState>) -> axum::Router {
    use axum::routing::get;
    axum::Router::new()
        .route("/sites/{uuid}/api/{*path}", get(serve_api_proxy))
        .with_state(state)
}

#[tokio::test]
async fn test_代理_站点不存在返回404() {
    let (_temp, state) = make_test_state().await;
    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/sites/nonexistent/api/test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_代理_站点无活跃版本返回400() {
    let (_temp, state) = make_test_state().await;
    // 创建站点（无活跃版本）
    let site = crate::db::models::create_site(&state.db, "测试").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sites/{}/api/test", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response.status().is_client_error(),
        "应返回客户端错误（无活跃版本）"
    );
}
```

- [ ] **Step 2: 实现 proxy/mod.rs**

Create `crates/server/src/proxy/mod.rs`:

```rust
use crate::db;
use crate::error::AppError;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use std::sync::Arc;

/// 反向代理：`GET/POST/PUT/DELETE /sites/{uuid}/api/{*path}`
pub async fn serve_api_proxy(
    State(state): State<Arc<AppState>>,
    Path((site_id, api_path)): Path<(String, String)>,
    method: Method,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, AppError> {
    // 查找站点
    let site = db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;

    // 冷启动逻辑
    let deno_port = match site.deno_status.as_str() {
        "running" => site
            .deno_port
            .map(|p| p as u16)
            .ok_or_else(|| AppError::Internal("状态不一致".to_string()))?,
        _ => {
            // 非 running → 触发冷启动
            state
                .process_manager
                .start(&state.db, &state.storage_dir, &site_id)
                .await?
        }
    };

    // 更新最后活动时间
    db::models::touch_activity(&state.db, &site_id).await?;

    // 构造 Deno URL
    let deno_url = format!("http://localhost:{deno_port}/api/{api_path}");

    // 使用 reqwest 转发请求
    let client = reqwest::Client::new();
    let req_builder = match method {
        Method::GET => client.get(&deno_url),
        Method::POST => client.post(&deno_url).body(body.to_vec()),
        Method::PUT => client.put(&deno_url).body(body.to_vec()),
        Method::DELETE => client.delete(&deno_url),
        _ => {
            let mut req = client.request(method.into(), &deno_url);
            if !body.is_empty() {
                req = req.body(body.to_vec());
            }
            req
        }
    };

    // 转发部分请求头
    let mut req_builder = req_builder;
    if let Some(ct) = headers.get(axum::http::header::CONTENT_TYPE) {
        req_builder = req_builder.header("content-type", ct.to_str().unwrap_or(""));
    }

    let deno_resp = req_builder
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("代理请求失败: {e}")))?;

    // 透传响应
    let status = StatusCode::from_u16(deno_resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = deno_resp.headers().clone();
    let resp_body = deno_resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("读取代理响应失败: {e}")))?
        .to_vec();

    let mut resp = axum::response::Response::new(axum::body::Body::from(resp_body));
    *resp.status_mut() = status;
    let resp_headers = resp.headers_mut();
    for (key, value) in headers.iter() {
        if key != "transfer-encoding" && key != "content-encoding" {
            resp_headers.insert(key.clone(), value.clone());
        }
    }

    Ok(resp)
}

#[cfg(test)]
#[path = "mod_test.rs"]
mod mod_test;
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cargo test -p agent-sites proxy::mod_test`
Expected: 2 tests passed

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: 反向代理 handler (冷启动触发 + reqwest 透传)

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

## Task 4: Management API 新增端点

**Files:**
- Modify: `crates/server/src/api/sites.rs`（新增 handler）
- Modify: `crates/server/src/api/mod.rs`（新增路由）
- Modify: `crates/server/src/api/sites_test.rs`（新增 API 测试）

- [ ] **Step 1: 新增 API handler**

在 `crates/server/src/api/sites.rs` 的 `delete_site` 之后、`#[cfg(test)]` 之前，添加以下 handler：

```rust
// ── 版本管理 ──

#[derive(Debug, Deserialize)]
pub struct CreateVersionInput {
    pub code_dir: Option<String>,
}

/// POST /api/sites/:id/versions
pub async fn create_version(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    // 确认站点存在
    db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let version = db::models::create_version(&state.db, &site_id).await?;
    Ok((StatusCode::CREATED, Json(ApiResponse::ok(version))))
}

/// GET /api/sites/:id/versions
pub async fn list_versions(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let versions = db::models::list_versions(&state.db, &site_id).await?;
    Ok(Json(ApiResponse::ok(versions)))
}

/// PUT /api/sites/:id/versions/:vid/activate
pub async fn activate_version(
    State(state): State<Arc<AppState>>,
    Path((site_id, version_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    // 验证 site 和 version 存在
    db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;
    db::models::get_version(&state.db, &version_id)
        .await?
        .ok_or(AppError::NotFound)?;

    // 激活版本
    db::models::set_active_version(&state.db, &site_id, &version_id).await?;

    // 如果有运行中的 Deno，停掉（下次请求会冷启动新版本）
    if state.process_manager.is_running(&site_id) {
        state.process_manager.stop(&state.db, &site_id).await?;
    }

    Ok(Json(ApiResponse::ok(serde_json::json!({"activated": version_id}))))
}

// ── 运行态管理 ──

#[derive(Debug, Deserialize)]
pub struct UpdateRuntimeInput {
    pub keep_alive: Option<bool>,
    pub idle_timeout_secs: Option<i64>,
}

/// PUT /api/sites/:id/runtime
pub async fn update_runtime(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
    Json(input): Json<UpdateRuntimeInput>,
) -> Result<impl IntoResponse, AppError> {
    let ok = db::models::update_site_runtime(
        &state.db, &site_id, input.keep_alive, input.idle_timeout_secs,
    )
    .await?;
    if !ok {
        return Err(AppError::NotFound);
    }
    Ok(Json(ApiResponse::ok(serde_json::json!({"updated": true}))))
}

/// GET /api/sites/:id/deno/status
pub async fn get_deno_status(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let site = db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let status = serde_json::json!({
        "status": site.deno_status,
        "port": site.deno_port,
        "keep_alive": site.keep_alive,
        "idle_timeout_secs": site.idle_timeout_secs,
        "active_version_id": site.active_version_id,
        "last_activity_at": site.last_activity_at,
    });
    Ok(Json(ApiResponse::ok(status)))
}

/// POST /api/sites/:id/deno/start
pub async fn start_deno(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let port = state
        .process_manager
        .start(&state.db, &state.storage_dir, &site_id)
        .await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({"port": port}))))
}

/// POST /api/sites/:id/deno/stop
pub async fn stop_deno(
    State(state): State<Arc<AppState>>,
    Path(site_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    state.process_manager.stop(&state.db, &site_id).await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({"stopped": true}))))
}
```

- [ ] **Step 2: 更新 api/mod.rs — 新增路由**

Replace `crates/server/src/api/mod.rs`:

```rust
pub mod sites;

use crate::AppState;
use std::sync::Arc;

/// API 路由汇总
pub fn routes() -> axum::Router<Arc<AppState>> {
    use axum::routing::{delete, get, post, put};
    axum::Router::new()
        .route("/sites", post(sites::create_site).get(sites::list_sites))
        .route(
            "/sites/{id}",
            get(sites::get_site).delete(sites::delete_site),
        )
        // 版本管理
        .route(
            "/sites/{id}/versions",
            post(sites::create_version).get(sites::list_versions),
        )
        .route(
            "/sites/{id}/versions/{vid}/activate",
            put(sites::activate_version),
        )
        // 运行态管理
        .route("/sites/{id}/runtime", put(sites::update_runtime))
        .route("/sites/{id}/deno/status", get(sites::get_deno_status))
        .route("/sites/{id}/deno/start", post(sites::start_deno))
        .route("/sites/{id}/deno/stop", post(sites::stop_deno))
}
```

- [ ] **Step 3: 运行现有 API 测试验证兼容性**

Run: `cargo test -p agent-sites api::sites_test`
Expected: 已有 6 个测试仍然通过

- [ ] **Step 4: 新增 API 测试**

在 `crates/server/src/api/sites_test.rs`（不替换，末尾追加）添加：

```rust
// ── 版本管理测试 ──

#[tokio::test]
async fn test_创建版本_API_返回201和版本数据() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点").await.unwrap();
    let app = make_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sites/{}/versions", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_列出站点版本_API_返回版本列表() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点").await.unwrap();
    db::models::create_version(&state.db, &site.id).await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/sites/{}/versions", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_激活版本_API_返回200() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点").await.unwrap();
    let version = db::models::create_version(&state.db, &site.id).await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/sites/{}/versions/{}/activate", site.id, version.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_更新运行时配置_API_修改keep_alive() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/sites/{}/runtime", site.id))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"keep_alive": true, "idle_timeout_secs": 600}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_deno状态_API_返回运行态信息() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/sites/{}/deno/status", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["data"]["status"], "stopped");
}

#[tokio::test]
async fn test_手动停止deno_无需运行返回200() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sites/{}/deno/stop", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}
```

- [ ] **Step 5: 运行全部 API 测试**

Run: `cargo test -p agent-sites api::sites_test`
Expected: 12 tests passed (6 原有 + 6 新增)

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Management API 新增版本管理 + 运行态端点

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```

---

## Task 5: 后台巡检 + App 组装 + Docker

**Files:**
- Modify: `crates/server/src/error.rs`（新增 ProcessError）
- Modify: `crates/server/src/config.rs`（新增 Deno 配置项）
- Modify: `crates/server/src/lib.rs`（AppState 扩展 + create_app 扩展 + 模块声明）
- Modify: `crates/server/src/main.rs`（PM 初始化 + 后台任务 + 新 CLI 参数）
- Modify: `Dockerfile`（安装 Deno）
- Modify: `docker-compose.yml`（新增环境变量）

- [ ] **Step 1: 确保 error.rs 无需额外变更（已有 Internal 变体可覆盖进程错误场景）**

Task 5 不新增 error 变体——现存的 `AppError::Internal` 已足够覆盖 Deno 进程启动失败、健康检查超时等场景。

- [ ] **Step 2: 更新 config.rs**

Replace `crates/server/src/config.rs`:

```rust
use std::path::PathBuf;

/// 平台配置
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub storage_dir: PathBuf,
    pub deno_path: String,
    pub deno_port_min: u16,
    pub deno_port_max: u16,
    pub idle_check_interval_secs: u64,
}
```

- [ ] **Step 3: 更新 lib.rs**

Replace entire `crates/server/src/lib.rs`:

```rust
pub mod api;
pub mod config;
pub mod db;
pub mod error;
pub mod process;
pub mod proxy;
pub mod routing;

use std::sync::Arc;

/// 全局共享状态
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub storage_dir: std::path::PathBuf,
    pub process_manager: process::ProcessManager,
}

/// 构建应用 Router
pub fn create_app(state: Arc<AppState>) -> axum::Router {
    use axum::routing::{delete, get, post, put};

    let router: axum::Router<Arc<AppState>> = axum::Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_handler))
        .nest("/api", api::routes())
        // 静态文件服务（阶段 1）
        .route("/sites/{uuid}/{*path}", get(routing::serve_site_file))
        // 反向代理（阶段 2：method routing with any method）
        .route(
            "/sites/{uuid}/api/{*path}",
            get(proxy::serve_api_proxy)
                .post(proxy::serve_api_proxy)
                .put(proxy::serve_api_proxy)
                .delete(proxy::serve_api_proxy)
                .patch(proxy::serve_api_proxy),
        );

    router.with_state(state)
}

async fn root_handler() -> &'static str {
    "agent-sites — Agent 站点托管平台"
}

async fn health_handler() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_create_app_签名变更后仍可编译() {}
}
```

- [ ] **Step 4: 更新 main.rs — 初始化 PM + 后台巡检任务**

Replace entire `crates/server/src/main.rs`:

```rust
use agent_sites::db;
use agent_sites::process::ProcessManager;
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;

/// agent-sites — Agent 站点托管平台
#[derive(Parser, Debug)]
#[command(name = "agent-sites", version, about)]
struct Cli {
    /// 监听地址
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// 监听端口
    #[arg(long, default_value = "3000")]
    port: u16,

    /// 数据库路径
    #[arg(long, env = "DATABASE_URL", default_value = "sqlite:data/agent-sites.db")]
    database_url: String,

    /// 站点文件存储目录
    #[arg(long, env = "STORAGE_DIR", default_value = "data/sites")]
    storage_dir: String,

    /// Deno 可执行文件路径
    #[arg(long, env = "DENO_PATH", default_value = "deno")]
    deno_path: String,

    /// Deno 端口范围起始
    #[arg(long, env = "DENO_PORT_MIN", default_value = "4000")]
    deno_port_min: u16,

    /// Deno 端口范围结束
    #[arg(long, env = "DENO_PORT_MAX", default_value = "5000")]
    deno_port_max: u16,

    /// 空闲巡检间隔（秒）
    #[arg(long, env = "IDLE_CHECK_INTERVAL_SECS", default_value = "30")]
    idle_check_interval_secs: u64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    // 初始化数据库
    let pool = db::init_pool(&cli.database_url).await?;
    db::run_migrations(&pool).await?;
    tracing::info!("数据库初始化完成: {}", cli.database_url);

    // 初始化存储目录
    let storage_dir = PathBuf::from(&cli.storage_dir);
    tokio::fs::create_dir_all(&storage_dir).await?;
    tracing::info!("存储目录: {}", storage_dir.display());

    // 初始化 ProcessManager
    let process_manager = ProcessManager::new(
        cli.deno_path.clone(),
        cli.deno_port_min,
        cli.deno_port_max,
    );
    tracing::info!(
        "ProcessManager 就绪: deno={} ports={}-{}",
        cli.deno_path, cli.deno_port_min, cli.deno_port_max
    );

    // 组装 AppState
    let state = Arc::new(agent_sites::AppState {
        db: pool.clone(),
        storage_dir: storage_dir.clone(),
        process_manager,
    });

    // 启动后台空闲巡检任务
    let idle_state = state.clone();
    let idle_interval = cli.idle_check_interval_secs;
    tokio::spawn(async move {
        run_idle_checker(idle_state, idle_interval).await;
    });

    let app = agent_sites::create_app(state);

    let addr = format!("{}:{}", cli.host, cli.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("agent-sites 监听 http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// 后台空闲巡检：定期检查 running 状态的站点，关闭超时的
async fn run_idle_checker(state: Arc<agent_sites::AppState>, interval_secs: u64) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
    loop {
        interval.tick().await;
        match agent_sites::db::models::list_running_sites(&state.db).await {
            Ok(sites) => {
                let now = chrono::Utc::now();
                for site in sites {
                    if site.keep_alive {
                        continue; // 热启动模式，不自动关闭
                    }
                    if let Some(ref last) = site.last_activity_at {
                        if let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(last) {
                            let idle = (now - last_time.with_timezone(&chrono::Utc))
                                .num_seconds();
                            if idle >= site.idle_timeout_secs {
                                tracing::info!(
                                    site_id = %site.id,
                                    idle_secs = idle,
                                    "空闲超时，停止 Deno"
                                );
                                if let Err(e) =
                                    state.process_manager.stop(&state.db, &site.id).await
                                {
                                    tracing::error!(site_id = %site.id, error = %e, "停止 Deno 失败");
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => tracing::error!(error = ?e, "巡检查询 running 站点失败"),
        }
    }
}
```

- [ ] **Step 5: 更新 Dockerfile — 安装 Deno**

在 `Dockerfile` 的 runtime stage（`debian:bookworm-slim`）中添加 Deno 安装：

```dockerfile
# 在 WORKDIR /app 之前添加：
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/deno && \
    apt-get purge -y curl unzip && \
    rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 6: 更新 docker-compose.yml**

在 `docker-compose.yml` 的 environment 中添加 Deno 相关环境变量：

```yaml
      - DENO_PATH=deno
      - DENO_PORT_MIN=4000
      - DENO_PORT_MAX=5000
      - IDLE_CHECK_INTERVAL_SECS=30
```

- [ ] **Step 7: 修复 api/mod.rs 未使用的 import**

如果 Task 4 Step 2 添加了 `put` 和 `delete` 的 import，需要确保 `api/mod.rs` 使用了它们。检查并修复。

- [ ] **Step 8: 修复 ProcessManager 中的 Child 类型兼容性**

在 Task 3 测试中使用了 `std::process::Child`，需要确保与 `tokio::process::Child` 兼容。修正为一致类型。

- [ ] **Step 9: 验证完整编译和测试**

Run:
```bash
cargo fmt
cargo build
cargo test
cargo clippy -- -D warnings
```

Expected: 全部通过

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: 后台巡检 + App 组装 + Docker Deno 支持

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>"
```
