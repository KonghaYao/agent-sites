> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 阶段 1：核心平台 + 静态站点托管 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建能创建站点、从本地文件系统直接服务静态文件并通过路径前缀路由分发的平台服务。

**Architecture:** Rust + axum 单服务器，SQLite 存储站点元数据，静态文件直接从 `{storage_dir}/{site_id}/` 读取（零网络开销），路径前缀路由 `/sites/{uuid}/{path}` 分发请求。

**Tech Stack:** axum 0.8, sqlx 0.8 (SQLite), tokio, uuid v7, mime_guess, Docker

**Spec:** `docs/superpowers/specs/2026-06-13-platform-architecture-design.md`

---

## 文件结构总览

```
crates/server/src/
├── main.rs                  # [修改] 入口，初始化 AppState 并启动服务
├── lib.rs                   # [修改] create_app, AppState, 模块声明
├── config.rs                # [新建] 配置结构体
├── error.rs                 # [新建] 统一错误类型 + API 响应包装
├── db/
│   ├── mod.rs               # [新建] 连接池初始化 + 迁移执行
│   └── models.rs            # [新建] Site 结构体 + CRUD 操作
├── routing/
│   └── mod.rs               # [新建] 静态文件服务 handler
└── api/
    ├── mod.rs               # [新建] API 路由汇总
    └── sites.rs             # [新建] 站点 CRUD handler

crates/server/migrations/
└── 20260613000001_create_sites.sql   # [新建]

项目根目录：
├── Dockerfile               # [新建] 多阶段构建
├── docker-compose.yml       # [新建] 服务编排
└── .dockerignore            # [新建]
```

---

## Task 1: 依赖、配置、错误类型与 Docker

**Files:**
- Modify: `Cargo.toml`（workspace 依赖）
- Modify: `crates/server/Cargo.toml`（crate 依赖）
- Create: `crates/server/src/config.rs`
- Create: `crates/server/src/error.rs`
- Modify: `crates/server/src/lib.rs`（添加模块声明，保留现有 create_app）
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: 更新 workspace 依赖**

在 `Cargo.toml` 的 `[workspace.dependencies]` 中，修改 sqlx 行添加 `migrate` feature：

```toml
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "migrate"] }
```

在末尾添加：

```toml
# --- MIME ---
mime_guess = "2"
```

- [ ] **Step 2: 更新 crate 依赖**

在 `crates/server/Cargo.toml` 的 `[dependencies]` 末尾添加：

```toml
mime_guess.workspace = true
```

- [ ] **Step 3: 创建 config.rs**

Create `crates/server/src/config.rs`:

```rust
use std::path::PathBuf;

/// 平台配置
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub storage_dir: PathBuf,
}
```

- [ ] **Step 4: 创建 error.rs**

Create `crates/server/src/error.rs`:

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// 应用错误类型
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("站点不存在")]
    NotFound,

    #[error("站点未激活")]
    SiteInactive,

    #[error("请求参数错误: {0}")]
    BadRequest(String),

    #[error("数据库错误: {0}")]
    Database(#[from] sqlx::Error),

    #[error("内部错误: {0}")]
    Internal(String),
}

/// API 统一响应包装
#[derive(Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub data: T,
    pub error: Option<ErrorDetail>,
}

#[derive(Serialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

impl<T: Serialize> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self { data, error: None }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            AppError::SiteInactive => (StatusCode::SERVICE_UNAVAILABLE, "SITE_INACTIVE"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            AppError::Database(_) => (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
        };

        let body = serde_json::json!({
            "data": null,
            "error": { "code": code, "message": self.to_string() }
        });

        (status, axum::Json(body)).into_response()
    }
}
```

- [ ] **Step 5: 更新 lib.rs 模块声明**

在 `crates/server/src/lib.rs` **顶部**添加模块声明（保留现有 `create_app`、handler、测试不变）：

```rust
pub mod api;
pub mod config;
pub mod db;
pub mod error;
pub mod routing;
```

创建占位模块文件（确保编译通过，内容为空）：
- `crates/server/src/db/mod.rs`
- `crates/server/src/db/models.rs`
- `crates/server/src/routing/mod.rs`
- `crates/server/src/api/mod.rs`
- `crates/server/src/api/sites.rs`

- [ ] **Step 6: 创建 Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM rust:1.85-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/agent-sites /usr/local/bin/agent-sites
WORKDIR /app
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["agent-sites"]
```

- [ ] **Step 7: 创建 docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  agent-sites:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - RUST_LOG=info
      - DATABASE_URL=sqlite:data/agent-sites.db
      - STORAGE_DIR=data/sites
    restart: unless-stopped
```

- [ ] **Step 8: 创建 .dockerignore**

Create `.dockerignore`:

```
target/
data/
.git/
docs/
.claude/
agm.json
agm.lock.json
```

- [ ] **Step 9: 验证编译**

Run: `cargo build`
Expected: 编译成功

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: 项目依赖、配置、错误类型与 Docker 文件"
```

---

## Task 2: 数据库迁移与连接池

**Files:**
- Create: `crates/server/migrations/20260613000001_create_sites.sql`
- Modify: `crates/server/src/db/mod.rs`

- [ ] **Step 1: 创建迁移文件**

Create `crates/server/migrations/20260613000001_create_sites.sql`:

```sql
CREATE TABLE sites (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_sites_status ON sites(status);
```

- [ ] **Step 2: 写失败测试**

Create `crates/server/src/db/mod_test.rs`:

```rust
use super::*;

#[tokio::test]
async fn test_连接池_迁移后存在sites表() {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = init_pool(&db_url).await.unwrap();
    run_migrations(&pool).await.unwrap();

    let row: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sites'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.0, 1, "sites 表应存在");

    pool.close().await;
}

#[tokio::test]
async fn test_连接池_重复迁移不报错() {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = init_pool(&db_url).await.unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();

    pool.close().await;
}
```

- [ ] **Step 3: 实现 db/mod.rs**

Replace `crates/server/src/db/mod.rs`:

```rust
pub mod models;

use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

/// 初始化 SQLite 连接池
pub async fn init_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;
    Ok(pool)
}

/// 执行数据库迁移
pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!().run(pool).await
}

#[cfg(test)]
#[path = "mod_test.rs"]
mod mod_test;
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cargo test -p agent-sites db::mod_test`
Expected: 2 tests passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 数据库迁移与连接池 (sites 表)"
```

---

## Task 3: Site 模型与 CRUD 操作

**Files:**
- Modify: `crates/server/src/db/models.rs`
- Create: `crates/server/src/db/models_test.rs`

- [ ] **Step 1: 写失败测试**

Create `crates/server/src/db/models_test.rs`:

```rust
use super::*;

async fn make_test_pool() -> (tempfile::TempDir, sqlx::SqlitePool) {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = crate::db::init_pool(&db_url).await.unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    (temp, pool)
}

#[tokio::test]
async fn test_创建站点_返回带id的完整记录() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "测试站点").await.unwrap();
    assert!(!site.id.is_empty(), "id 不应为空");
    assert_eq!(site.name, "测试站点");
    assert_eq!(site.status, "active");
}

#[tokio::test]
async fn test_查询单个站点_存在的id返回记录() {
    let (_temp, pool) = make_test_pool().await;
    let created = create_site(&pool, "站点A").await.unwrap();
    let found = get_site(&pool, &created.id).await.unwrap();
    assert!(found.is_some(), "应找到站点");
    assert_eq!(found.unwrap().name, "站点A");
}

#[tokio::test]
async fn test_查询单个站点_不存在的id返回None() {
    let (_temp, pool) = make_test_pool().await;
    let found = get_site(&pool, "不存在的id").await.unwrap();
    assert!(found.is_none(), "不应找到站点");
}

#[tokio::test]
async fn test_列出站点_只返回active状态() {
    let (_temp, pool) = make_test_pool().await;
    create_site(&pool, "站点A").await.unwrap();
    let site_b = create_site(&pool, "站点B").await.unwrap();
    delete_site(&pool, &site_b.id).await.unwrap();

    let sites = list_sites(&pool).await.unwrap();
    assert_eq!(sites.len(), 1, "应只有 1 个 active 站点");
    assert_eq!(sites[0].name, "站点A");
}

#[tokio::test]
async fn test_删除站点_软删除后状态变为inactive() {
    let (_temp, pool) = make_test_pool().await;
    let site = create_site(&pool, "待删除").await.unwrap();
    delete_site(&pool, &site.id).await.unwrap();

    let found = get_site(&pool, &site.id).await.unwrap().unwrap();
    assert_eq!(found.status, "inactive", "状态应为 inactive");
}
```

- [ ] **Step 2: 实现 models.rs**

Replace `crates/server/src/db/models.rs`:

```rust
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// 站点记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Site {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建站点请求
#[derive(Debug, Deserialize)]
pub struct CreateSiteInput {
    pub name: String,
}

/// 创建站点
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
        "SELECT id, name, status, created_at, updated_at FROM sites WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.into()))
}

/// 列出所有 active 站点
pub async fn list_sites(pool: &SqlitePool) -> Result<Vec<Site>, sqlx::Error> {
    let rows = sqlx::query_as::<_, SiteRow>(
        "SELECT id, name, status, created_at, updated_at \
         FROM sites WHERE status = 'active' ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| r.into()).collect())
}

/// 软删除站点（status → inactive）
pub async fn delete_site(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE sites SET status = 'inactive', updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;

    Ok(result.rows_affected() > 0)
}

#[derive(sqlx::FromRow)]
struct SiteRow {
    id: String,
    name: String,
    status: String,
    created_at: String,
    updated_at: String,
}

impl From<SiteRow> for Site {
    fn from(r: SiteRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            status: r.status,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[cfg(test)]
#[path = "models_test.rs"]
mod models_test;
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cargo test -p agent-sites db::models_test`
Expected: 5 tests passed

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: Site 模型与 CRUD 操作"
```

---

## Task 4: 静态文件服务

**Files:**
- Modify: `crates/server/src/routing/mod.rs`
- Create: `crates/server/src/routing/mod_test.rs`
- Modify: `crates/server/src/lib.rs`（添加 AppState 结构体）

- [ ] **Step 1: 在 lib.rs 添加 AppState 结构体**

在 `crates/server/src/lib.rs` 模块声明之后添加（保留现有 create_app/handler 不变）：

```rust
use std::sync::Arc;

/// 全局共享状态
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub storage_dir: std::path::PathBuf,
}
```

- [ ] **Step 2: 写失败测试**

Create `crates/server/src/routing/mod_test.rs`:

```rust
use super::*;
use crate::db;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;

/// 构建测试用 AppState：临时目录同时包含数据库和存储
async fn make_app_state() -> (tempfile::TempDir, Arc<AppState>) {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = db::init_pool(&db_url).await.unwrap();
    db::run_migrations(&pool).await.unwrap();

    let storage_dir = temp.path().join("storage");
    tokio::fs::create_dir_all(&storage_dir).await.unwrap();

    let state = Arc::new(AppState {
        db: pool,
        storage_dir,
    });
    (temp, state)
}

fn make_router(state: Arc<AppState>) -> axum::Router {
    use axum::routing::get;
    axum::Router::new()
        .route("/sites/{uuid}/{*path}", get(serve_site_file))
        .with_state(state)
}

#[tokio::test]
async fn test_静态服务_返回文件内容() {
    let (_db_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    // 在存储目录中放置文件
    let file_path = state.storage_dir.join(&site.id).join("index.html");
    tokio::fs::create_dir_all(file_path.parent().unwrap()).await.unwrap();
    tokio::fs::write(&file_path, b"<h1>hello</h1>").await.unwrap();

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
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"<h1>hello</h1>");
}

#[tokio::test]
async fn test_静态服务_站点不存在返回404() {
    let (_db_temp, state) = make_app_state().await;
    let app = make_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/sites/no-such-id/index.html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_静态服务_文件不存在返回404() {
    let (_db_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sites/{}/nope.html", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_静态服务_路径穿越攻击被阻止() {
    let (_db_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    // 在存储目录外放置文件
    let secret_path = state.storage_dir.join("secret.txt");
    tokio::fs::write(&secret_path, b"secret").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sites/{}/../secret.txt", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_静态服务_返回正确的Content_Type() {
    let (_db_temp, state) = make_app_state().await;
    let site = db::models::create_site(&state.db, "测试").await.unwrap();

    let file_path = state.storage_dir.join(&site.id).join("style.css");
    tokio::fs::create_dir_all(file_path.parent().unwrap()).await.unwrap();
    tokio::fs::write(&file_path, b"body{}").await.unwrap();

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

    let content_type = response.headers().get(header::CONTENT_TYPE).unwrap();
    assert!(
        content_type.to_str().unwrap().contains("text/css"),
        "CSS 文件应返回 text/css"
    );
}
```

- [ ] **Step 3: 实现 routing/mod.rs**

Replace `crates/server/src/routing/mod.rs`:

```rust
use crate::db;
use crate::error::AppError;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use std::sync::Arc;

/// 静态文件服务：`GET /sites/{uuid}/{*path}`
pub async fn serve_site_file(
    State(state): State<Arc<AppState>>,
    Path((site_id, file_path)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    // 查找站点
    let site = db::models::get_site(&state.db, &site_id)
        .await?
        .ok_or(AppError::NotFound)?;

    if site.status != "active" {
        return Err(AppError::SiteInactive);
    }

    // 构建完整文件路径
    let site_dir = state.storage_dir.join(&site_id);
    let full_path = site_dir.join(&file_path);

    // 路径穿越防护：canonicalize 后检查前缀
    let canonical = full_path
        .canonicalize()
        .map_err(|_| AppError::NotFound)?;
    let site_root = site_dir
        .canonicalize()
        .map_err(|_| AppError::NotFound)?;
    if !canonical.starts_with(&site_root) {
        return Err(AppError::NotFound);
    }

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
            (
                header::CACHE_CONTROL,
                "public, max-age=3600".to_string(),
            ),
        ],
        data,
    ))
}

#[cfg(test)]
#[path = "mod_test.rs"]
mod mod_test;
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cargo test -p agent-sites routing::mod_test`
Expected: 5 tests passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 静态文件服务 handler (路径穿越防护 + Content-Type)"
```

---

## Task 5: Management API（站点 CRUD 端点）

**Files:**
- Modify: `crates/server/src/api/sites.rs`
- Modify: `crates/server/src/api/mod.rs`
- Create: `crates/server/src/api/sites_test.rs`

- [ ] **Step 1: 写失败测试**

Create `crates/server/src/api/sites_test.rs`:

```rust
use super::*;
use crate::db;
use crate::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;

async fn make_state() -> (tempfile::TempDir, Arc<AppState>) {
    let temp = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite:{}", temp.path().join("test.db").display());
    let pool = db::init_pool(&db_url).await.unwrap();
    db::run_migrations(&pool).await.unwrap();

    let storage_dir = temp.path().join("storage");
    tokio::fs::create_dir_all(&storage_dir).await.unwrap();

    let state = Arc::new(AppState {
        db: pool,
        storage_dir,
    });
    (temp, state)
}

fn make_router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new().nest("/api", routes()).with_state(state)
}

#[tokio::test]
async fn test_创建站点_API_返回201和站点数据() {
    let (_temp, state) = make_state().await;
    let app = make_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sites")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "测试站点" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_列出站点_API_返回active站点列表() {
    let (_temp, state) = make_state().await;
    db::models::create_site(&state.db, "站点A").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/sites")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["data"].is_array(), "data 应为数组");
    assert_eq!(json["data"].as_array().unwrap().len(), 1);
    assert_eq!(json["data"][0]["name"], "站点A");
}

#[tokio::test]
async fn test_查询单个站点_API_存在时返回200() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "站点X").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/sites/{}", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_查询单个站点_API_不存在时返回404() {
    let (_temp, state) = make_state().await;
    let app = make_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/sites/no-such-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_删除站点_API_软删除返回204() {
    let (_temp, state) = make_state().await;
    let site = db::models::create_site(&state.db, "待删").await.unwrap();

    let app = make_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/sites/{}", site.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn test_创建站点_API_缺少name字段返回400() {
    let (_temp, state) = make_state().await;
    let app = make_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sites")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: 实现 api/sites.rs**

Replace `crates/server/src/api/sites.rs`:

```rust
use crate::db;
use crate::db::models::CreateSiteInput;
use crate::error::{ApiResponse, AppError};
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

/// POST /api/sites — 创建站点
pub async fn create_site(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateSiteInput>,
) -> Result<impl IntoResponse, AppError> {
    let site = db::models::create_site(&state.db, &input.name).await?;
    Ok((StatusCode::CREATED, Json(ApiResponse::ok(site))))
}

/// GET /api/sites — 列出所有 active 站点
pub async fn list_sites(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let sites = db::models::list_sites(&state.db).await?;
    Ok(Json(ApiResponse::ok(sites)))
}

/// GET /api/sites/:id — 获取单个站点
pub async fn get_site(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let site = db::models::get_site(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(ApiResponse::ok(site)))
}

/// DELETE /api/sites/:id — 软删除站点
pub async fn delete_site(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let deleted = db::models::delete_site(&state.db, &id).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "sites_test.rs"]
mod sites_test;
```

- [ ] **Step 3: 实现 api/mod.rs**

Replace `crates/server/src/api/mod.rs`:

```rust
pub mod sites;

use crate::AppState;
use std::sync::Arc;

/// API 路由汇总
pub fn routes() -> axum::Router<Arc<AppState>> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route("/sites", post(sites::create_site).get(sites::list_sites))
        .route("/sites/{id}", get(sites::get_site).delete(sites::delete_site))
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cargo test -p agent-sites api::sites_test`
Expected: 6 tests passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Management API (站点 CRUD 端点)"
```

---

## Task 6: 应用组装与 main.rs

**Files:**
- Modify: `crates/server/src/lib.rs`
- Modify: `crates/server/src/main.rs`

- [ ] **Step 1: 更新 lib.rs — create_app + AppState**

Replace entire `crates/server/src/lib.rs`:

```rust
pub mod api;
pub mod config;
pub mod db;
pub mod error;
pub mod routing;

use std::sync::Arc;

/// 全局共享状态
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub storage_dir: std::path::PathBuf,
}

/// 构建应用 Router
pub fn create_app(state: Arc<AppState>) -> axum::Router {
    use axum::routing::get;

    let router: axum::Router<Arc<AppState>> = axum::Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_handler))
        .nest("/api", api::routes())
        .route("/sites/{uuid}/{*path}", get(routing::serve_site_file));

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
    use super::*;

    #[test]
    fn test_create_app_签名变更后仍可编译() {
        // AppState 和 create_app 的完整集成测试在 routing 和 api 模块
    }
}
```

- [ ] **Step 2: 更新 main.rs**

Replace entire `crates/server/src/main.rs`:

```rust
use agent_sites::config::Config;
use agent_sites::db;
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

    // 组装 AppState
    let state = Arc::new(agent_sites::AppState {
        db: pool,
        storage_dir,
    });

    let app = agent_sites::create_app(state);

    let addr = format!("{}:{}", cli.host, cli.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("agent-sites 监听 http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] **Step 3: 验证完整编译**

Run: `cargo build`
Expected: 编译成功

- [ ] **Step 4: 运行全部测试**

Run: `cargo test`
Expected: 所有测试通过

- [ ] **Step 5: 运行 clippy**

Run: `cargo clippy -- -D warnings`
Expected: 无 warning

- [ ] **Step 6: 格式化检查**

Run: `cargo fmt -- --check`
Expected: 无格式问题（如有，运行 `cargo fmt` 修复）

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: 应用组装与启动流程 (create_app + main.rs)"
```
