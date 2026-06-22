# PocketBase 预置 Superuser + 屏蔽 Admin UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 App 创建时自动预置 PocketBase superuser，杜绝首次注册抢注窗口，同时删除 `/_/` Admin UI 代理路由和 `ADMIN_TOKEN` 网关层校验。

**Architecture:** spawn PocketBase 进程之前，先用 `pocketbase superuser upsert` CLI 子命令往数据目录写入 superuser 凭证（PB 自动初始化 schema）。Agent 拿到凭证后通过 `/api/collections/_superusers/auth-with-password` 换 token，再操作 collections。`/_/` 路由直接删除（落到现有静态文件 handler 自然 404）。`ADMIN_TOKEN` 配置项连同 `state.rs` 的 token 字段、`main.rs` 的 CLI 参数一起清除。

**Tech Stack:** Rust 2021 / axum 0.8 / tokio / serde / PocketBase 0.23.x CLI / uuid v4

---

## 文件结构

**修改的文件：**
| 文件 | 改动 |
|---|---|
| `crates/server/src/process/pocketbase.rs` | 新增 `init_superuser` 函数 |
| `crates/server/src/process/pocketbase_test.rs` | 新增 4 个 `init_superuser` 单元测试 |
| `crates/server/src/app/model.rs` | `App` 加 `superuser_email` + `superuser_password` 字段（`#[serde(default)]`） |
| `crates/server/src/app/model_test.rs` | 已有 `App { ... }` 字面量补 2 字段；新增反序列化默认值测试 |
| `crates/server/src/app/store_test.rs` | `make_app` helper 补 2 字段 |
| `crates/server/src/api/apps.rs` | `make_placeholder` + `AppResponse` + `create_app` 接入 init_superuser |
| `crates/server/src/api/apps_test.rs` | `make_app_state_with_range` 删 admin_token 实参 |
| `crates/server/src/lib.rs` | 删 `serve_admin_proxy` + 路由 + `constant_time_eq` |
| `crates/server/src/lib_test.rs` | 删 4 个 admin_proxy 测试，新增 `/_/` 404 + 端到端 token 测试 |
| `crates/server/src/state.rs` | 删 `admin_token` 字段、构造参数、`with_admin_token` 方法 |
| `crates/server/src/main.rs` | 删 `--admin-token` CLI 参数 + 警告日志 + AppState 构造实参 |
| `CLAUDE.md` | 删 `ADMIN_TOKEN` 行 |
| `README.md` | 删 `ADMIN_TOKEN` 行 |
| `docs/architecture.md` | §4.1/§4.2 删 `/_/`，§7.1/§7.2 改为 superuser 凭证流程 |

**不修改的文件：** `process/mod.rs`（start 不变）、`config.rs`（已废弃，无 admin_token 字段）、`error.rs`、`proxy/*`、`static_files/*`、`port_allocator.rs`

---

## Task 1: 新增 `init_superuser` 函数 + 单元测试

**Files:**
- Modify: `crates/server/src/process/pocketbase.rs`
- Modify: `crates/server/src/process/pocketbase_test.rs`

**目的：** 给 PocketBase 数据目录预置 superuser。该函数在 `process_manager.start` 之前调用，确保 spawn 出来的 PB 直接跳过首次注册页。

- [ ] **Step 1: 在 `pocketbase_test.rs` 写失败测试**

把以下内容追加到 `crates/server/src/process/pocketbase_test.rs` 末尾：

```rust
use crate::process::pocketbase::{init_superuser, pb_binary_available, pb_binary_path};

#[test]
fn test_init_superuser_空目录_成功_目录非空() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path();
    init_superuser(
        &pb_binary_path(),
        data_dir,
        "admin@app-test1.local",
        "abcdef1234567890abcdef1234567890",
    )
    .expect("空目录预置 superuser 应成功");
    // PocketBase 自动初始化 schema，data.db 必须存在
    let data_db = data_dir.join("data.db");
    assert!(data_db.exists(), "init 后 data.db 应存在");
}

#[test]
fn test_init_superuser_幂等更新密码_二次调用成功() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path();
    init_superuser(
        &pb_binary_path(),
        data_dir,
        "admin@app-test2.local",
        "firstpassword1234567890",
    )
    .unwrap();
    // 第二次 upsert（同 email 不同密码）应成功更新
    init_superuser(
        &pb_binary_path(),
        data_dir,
        "admin@app-test2.local",
        "secondpassword12345678",
    )
    .expect("幂等 upsert 不应报错");
}

#[test]
fn test_init_superuser_email非法_返回错误() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let result = init_superuser(
        &pb_binary_path(),
        tmp.path(),
        "admin@local", // 缺 TLD，PB 拒绝
        "abcdef1234567890abcdef1234567890",
    );
    assert!(result.is_err(), "非法 email 必须返回 Err");
}

#[test]
fn test_init_superuser_pb不存在_返回错误() {
    let tmp = tempfile::tempdir().unwrap();
    let result = init_superuser(
        std::path::Path::new("/nonexistent/pocketbase-binary"),
        tmp.path(),
        "admin@app-test3.local",
        "abcdef1234567890abcdef1234567890",
    );
    assert!(result.is_err(), "PB 不存在必须返回 Err");
}
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cargo test -p agent-sites --lib process::pocketbase_test
```
预期：编译失败（`init_superuser` 未定义、`pb_binary_available`/`pb_binary_path` 未 import）

- [ ] **Step 3: 在 `pocketbase.rs` 实现 `init_superuser`**

把以下内容追加到 `crates/server/src/process/pocketbase.rs`（在 `wait_for_health` 函数之后、`#[cfg(test)]` 之前）：

```rust
/// 在 spawn PocketBase 之前预置 superuser，避免首次注册页面被抢注。
///
/// 调用 `pocketbase superuser upsert <email> <password>`，操作 SQLite
/// 数据目录，**不需要 PocketBase 进程在运行**。空目录时 PocketBase 自动
/// 初始化 schema（生成 data.db / auxiliary.db / types.d.ts）。
///
/// `upsert` 幂等：同 email 二次调用更新密码，无副作用。
/// 调用方应保证 email RFC 格式（如 `admin@app-xxx.local`），否则
/// PocketBase 拒绝并返回错误。
///
/// Issue #2：原方案靠 ADMIN_TOKEN 在网关层防御 /_/ 抢注，但只要
/// /_/ 路由暴露 + 未预置 superuser，第一访问者仍可创建超管。本函数
/// 在 spawn 前写入凭证，从根上消除抢注窗口。
pub fn init_superuser(
    binary: &Path,
    data_dir: &Path,
    email: &str,
    password: &str,
) -> std::io::Result<()> {
    let output = std::process::Command::new(binary)
        .arg("superuser")
        .arg("upsert")
        .arg(format!("--dir={}", data_dir.display()))
        .arg(email)
        .arg(password)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "superuser upsert 退出码 {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
            ),
        ));
    }
    Ok(())
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cargo test -p agent-sites --lib process::pocketbase_test
```
预期：4 个新测试 + 4 个已有测试全过

- [ ] **Step 5: 提交**

```bash
git add crates/server/src/process/pocketbase.rs crates/server/src/process/pocketbase_test.rs
git commit -m "$(cat <<'EOF'
feat(process): 新增 init_superuser 预置 PB superuser

spawn PB 前预置 superuser 凭证，从根上消除 /_/ 首次注册抢注窗口。
upsert 幂等，支持同 email 二次调用（重启时更新密码）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 2: App 模型加 superuser 字段（向后兼容）

**Files:**
- Modify: `crates/server/src/app/model.rs:25-33`
- Modify: `crates/server/src/app/model_test.rs`
- Modify: `crates/server/src/app/store_test.rs:4-13`

**目的：** 在 `App` 结构体里持久化 superuser 凭证，让网关重启后仍能拿到。`#[serde(default)]` 保证旧的 `apps.json`（无此字段）反序列化不炸。

- [ ] **Step 1: 在 `model_test.rs` 写失败测试（向后兼容）**

把以下内容追加到 `crates/server/src/app/model_test.rs` 末尾：

```rust
#[test]
fn test_app_旧json无superuser字段_反序列化_默认空字符串() {
    // 模拟旧 apps.json（pivot 之前的格式），无 superuser_email/password 字段
    let old_json = r#"{
        "id": "app-old1",
        "name": "legacy",
        "port": 9001,
        "status": "running",
        "created_at": "2026-06-19T10:00:00Z",
        "updated_at": "2026-06-19T10:00:00Z"
    }"#;
    let app: App = serde_json::from_str(old_json).expect("旧 json 必须能反序列化（向后兼容）");
    assert_eq!(app.id, "app-old1");
    assert_eq!(app.superuser_email, "");
    assert_eq!(app.superuser_password, "");
}

#[test]
fn test_app_新字段序列化_包含superuser() {
    let app = App {
        id: "app-abc123".to_string(),
        name: "demo".to_string(),
        port: 9001,
        status: AppStatus::Running,
        created_at: "2026-06-19T10:00:00Z".to_string(),
        updated_at: "2026-06-19T10:00:00Z".to_string(),
        superuser_email: "admin@app-abc123.local".to_string(),
        superuser_password: "deadbeefdeadbeef".to_string(),
    };
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["superuser_email"], json!("admin@app-abc123.local"));
    assert_eq!(json["superuser_password"], json!("deadbeefdeadbeef"));
}
```

- [ ] **Step 2: 同步修改 `model_test.rs` 已有测试的字面量**

把 `crates/server/src/app/model_test.rs:5-19`（`test_app_序列化包含全部字段` 函数体里的 `App { ... }`）替换为：

```rust
    let app = App {
        id: "app-abc123".to_string(),
        name: "my-app".to_string(),
        port: 9001,
        status: AppStatus::Running,
        created_at: "2026-06-19T10:00:00Z".to_string(),
        updated_at: "2026-06-19T10:00:00Z".to_string(),
        superuser_email: String::new(),
        superuser_password: String::new(),
    };
```

- [ ] **Step 3: 跑测试验证失败**

```bash
cargo test -p agent-sites --lib app::model_test
```
预期：编译失败（`App { ... }` 缺新字段）

- [ ] **Step 4: 在 `model.rs` 加字段**

把 `crates/server/src/app/model.rs:25-33`（`App` 结构体定义）替换为：

```rust
/// App 实体（一个 App = 一个 PocketBase 进程）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct App {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub status: AppStatus,
    pub created_at: String,
    pub updated_at: String,
    /// PocketBase superuser 邮箱（RFC 格式，如 admin@app-xxx.local）。
    /// `#[serde(default)]` 保证加载旧 apps.json（pivot 之前的格式）不炸。
    #[serde(default)]
    pub superuser_email: String,
    /// PocketBase superuser 密码（明文，与 apps.json 同级保护）。
    #[serde(default)]
    pub superuser_password: String,
}
```

- [ ] **Step 5: 修 `store_test.rs::make_app` helper**

把 `crates/server/src/app/store_test.rs:4-13`（`make_app` 函数体）替换为：

```rust
fn make_app(id: &str, port: u16, status: AppStatus) -> App {
    App {
        id: id.to_string(),
        name: format!("name-{}", id),
        port,
        status,
        created_at: "2026-06-19T10:00:00Z".to_string(),
        updated_at: "2026-06-19T10:00:00Z".to_string(),
        superuser_email: String::new(),
        superuser_password: String::new(),
    }
}
```

- [ ] **Step 6: 跑全部测试验证通过**

```bash
cargo test -p agent-sites --lib app::
```
预期：app 模块下所有测试通过

- [ ] **Step 7: 提交**

```bash
git add crates/server/src/app/model.rs crates/server/src/app/model_test.rs crates/server/src/app/store_test.rs
git commit -m "$(cat <<'EOF'
feat(app): App 加 superuser_email/password 字段

#[serde(default)] 保证旧 apps.json 向后兼容（反序列化为空字符串）。
store_test::make_app helper 同步补默认值。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: create_app 接入 init_superuser（spawn 前预置）

**Files:**
- Modify: `crates/server/src/api/apps.rs:58-143`（`create_app` 整个函数）

**目的：** App 创建流程：分配 id → create_dir → **预置 superuser** → spawn PB → 失败回滚。预置在 spawn 前完成，确保 PB 进程一启动就没有抢注窗口。

- [ ] **Step 1: 在 `apps_test.rs` 写失败测试（凭证可见 + 可换 token）**

把以下内容追加到 `crates/server/src/api/apps_test.rs` 末尾：

```rust
#[tokio::test]
async fn test_create_app_返回_superuser_凭证() {
    if !pb_binary_available() {
        eprintln!("跳过");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    // 用独立端口范围避免与其它 spawn 测试并行冲突
    let state = make_app_state_with_range(&tmp, 20200, 20300).await;
    let app = make_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/apps")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name":"cred-test"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let data = &val["data"];
    let email = data["superuser_email"].as_str().expect("必须有 email");
    let password = data["superuser_password"].as_str().expect("必须有 password");
    let app_id = data["id"].as_str().unwrap();
    // email 必须是 RFC 格式（含 . 后缀）
    assert!(email.contains('@'), "email 必须有 @: {}", email);
    assert!(email.ends_with(".local"), "email 后缀应为 .local: {}", email);
    // email 里应包含 app_id
    assert!(email.contains(app_id), "email 应包含 app_id");
    // password 必须够长（32 hex = 32 字符）
    assert!(password.len() >= 32, "password 至少 32 字符: {}", password.len());
}

#[tokio::test]
async fn test_create_app_预置_superuser_可换token() {
    if !pb_binary_available() {
        eprintln!("跳过");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let state = make_app_state_with_range(&tmp, 20300, 20400).await;
    let app = make_router(state.clone());
    // 1. 创建 App
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/apps")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name":"token-test"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let app_id = val["data"]["id"].as_str().unwrap().to_string();
    let email = val["data"]["superuser_email"].as_str().unwrap().to_string();
    let password = val["data"]["superuser_password"].as_str().unwrap().to_string();

    // 2. 通过网关代理调 PB superuser auth-with-password
    let auth_uri = format!("/{}/api/collections/_superusers/auth-with-password", app_id);
    let auth_body = serde_json::json!({
        "identity": email,
        "password": password,
    });
    let auth_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(&auth_uri)
                .header("content-type", "application/json")
                .body(Body::from(auth_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(auth_resp.status(), StatusCode::OK, "auth 必须成功");
    let auth_bytes = to_bytes(auth_resp.into_body(), 1024 * 1024).await.unwrap();
    let auth_val: serde_json::Value = serde_json::from_slice(&auth_bytes).unwrap();
    assert!(auth_val["token"].as_str().is_some(), "response 必须含 token");
}
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cargo test -p agent-sites --lib api::apps_test::test_create_app_返回_superuser_凭证
cargo test -p agent-sites --lib api::apps_test::test_create_app_预置_superuser_可换token
```
预期：失败（`superuser_email` 字段不在 response 里；老 `AppResponse` 编译错）

- [ ] **Step 3: 改 `apps.rs::AppResponse`（删 `admin_path`、加 2 字段）**

把 `crates/server/src/api/apps.rs:15-38`（`AppResponse` 结构 + `From<&App>` impl）替换为：

```rust
#[derive(Debug, Serialize)]
pub struct AppResponse {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub status: String,
    pub api_path: String,
    pub superuser_email: String,
    pub superuser_password: String,
    pub created_at: String,
}

impl From<&App> for AppResponse {
    fn from(a: &App) -> Self {
        Self {
            id: a.id.clone(),
            name: a.name.clone(),
            port: a.port,
            status: a.status.as_str().to_string(),
            api_path: format!("/{}/api", a.id),
            superuser_email: a.superuser_email.clone(),
            superuser_password: a.superuser_password.clone(),
            created_at: a.created_at.clone(),
        }
    }
}
```

- [ ] **Step 4: 改 `apps.rs::create_app`（补字段 + 接入 init_superuser）**

把 `crates/server/src/api/apps.rs:58-143`（整个 `create_app` 函数）替换为：

```rust
pub async fn create_app(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAppRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 上限检查
    let current_count = state.store.list().await.len();
    if current_count >= state.max_apps {
        return Err(AppError::Conflict(format!(
            "App 数量已达上限 {}",
            state.max_apps
        )));
    }

    // 名字
    let name = match req.name {
        Some(n) => normalize_name(&n)?,
        None => String::new(),
    };

    // 分配 id（Issue #5：用 add_if_absent 原子 check+insert，避免 TOCTOU）
    let allocator = PortAllocator::new(state.port_min, state.port_max);
    let make_placeholder = |id: &str| -> App {
        let now = chrono::Utc::now().to_rfc3339();
        App {
            id: id.to_string(),
            name: if name.is_empty() {
                id.to_string()
            } else {
                name.clone()
            },
            port: 0,
            status: AppStatus::Starting,
            created_at: now.clone(),
            updated_at: now,
            superuser_email: String::new(),
            superuser_password: String::new(),
        }
    };
    let mut id = App::generate_id();
    let mut app = make_placeholder(&id);
    while !state.store.add_if_absent(app.clone()).await {
        id = App::generate_id();
        app = make_placeholder(&id);
    }

    // 持久化占位（让其他请求可见到 Starting 记录）
    state
        .store
        .flush()
        .await
        .map_err(|e| AppError::Internal(format!("持久化失败: {e}")))?;

    // 数据目录 + superuser 凭证
    let data_dir = state.data_dir.join(&id);
    let superuser_email = format!("admin@{}.local", id);
    let superuser_password = uuid::Uuid::new_v4().simple().to_string();

    // 1. 创建目录（init_superuser 不创建父目录）
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|e| AppError::Internal(format!("创建数据目录失败: {e}")))?;

    // 2. 预置 superuser（spawn 前）
    //    用 spawn_blocking 包装同步 std::process::Command 调用，
    //    避免阻塞 tokio runtime。
    let pb_binary = state.pb_binary.clone();
    let data_dir_clone = data_dir.clone();
    let email_clone = superuser_email.clone();
    let password_clone = superuser_password.clone();
    let init_result = tokio::task::spawn_blocking(move || {
        crate::process::pocketbase::init_superuser(
            &pb_binary,
            &data_dir_clone,
            &email_clone,
            &password_clone,
        )
    })
    .await
    .map_err(|e| AppError::Internal(format!("init_superuser 任务 panic: {e}")))?;
    if let Err(e) = init_result {
        // 预置失败：清理占位记录
        state.store.remove(&app.id).await;
        state.store.flush().await.ok();
        return Err(AppError::Internal(format!("预置 superuser 失败: {e}")));
    }

    // 3. spawn PB（沿用现有 PM.start，含端口分配 + 健康检查）
    let cookie_path = format!("/{}/", id);
    let result = state
        .process_manager
        .start(&id, &data_dir, &cookie_path, &allocator)
        .await;

    match result {
        Ok(actual_port) => {
            // Issue #10：用实际 port + Running + 凭证持久化
            app.port = actual_port;
            app.status = AppStatus::Running;
            app.updated_at = chrono::Utc::now().to_rfc3339();
            app.superuser_email = superuser_email;
            app.superuser_password = superuser_password;
            state.store.update(app.clone()).await;
            state
                .store
                .flush()
                .await
                .map_err(|e| AppError::Internal(format!("持久化失败: {e}")))?;
            let resp = AppResponse::from(&app);
            Ok(Json(serde_json::json!({ "data": resp, "error": null })))
        }
        Err(e) => {
            // Issue #10：start 失败时移除占位记录，不留 Error 记录
            state.store.remove(&app.id).await;
            state.store.flush().await.ok();
            Err(e)
        }
    }
}
```

- [ ] **Step 5: 跑新测试验证通过**

```bash
cargo test -p agent-sites --lib api::apps_test::test_create_app_返回_superuser_凭证
cargo test -p agent-sites --lib api::apps_test::test_create_app_预置_superuser_可换token
```
预期：两个测试通过（如 PB 可用）

- [ ] **Step 6: 跑全 apps_test + process 测试套件，确认没破坏旧测试**

```bash
cargo test -p agent-sites --lib api::apps_test
```
预期：所有 apps 测试通过

- [ ] **Step 7: 提交**

```bash
git add crates/server/src/api/apps.rs crates/server/src/api/apps_test.rs
git commit -m "$(cat <<'EOF'
feat(apps): create_app spawn 前预置 superuser

- AppResponse 删 admin_path，加 superuser_email/password（agent 用凭证换 token）
- create_app 流程：分配 id → create_dir → init_superuser → spawn PB
- init_superuser 用 spawn_blocking 包装同步 CLI 调用，避免阻塞 runtime
- 失败时清理占位记录（沿用现有回滚逻辑）

预置 superuser 后 PB 进程一启动就没有首次注册抢注窗口。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: 屏蔽 `/_/` 路由（删 `serve_admin_proxy` + `constant_time_eq`）

**Files:**
- Modify: `crates/server/src/lib.rs:35-56`（删 admin proxy route 块）
- Modify: `crates/server/src/lib.rs:87-134`（删 `serve_admin_proxy` handler）
- Modify: `crates/server/src/lib.rs:155-165`（删 `constant_time_eq`）
- Modify: `crates/server/src/lib_test.rs`（删 4 个 admin_proxy 测试，加 `/_/` 404 测试）

**目的：** 移除 `/_/` Admin UI 代理路由。未匹配的 `/app-{id}/_/...` 会落到 `/app-{id}/{*path}` 静态文件 handler，因 `public_dir` 下没 `_` 目录 → 自然 404。

- [ ] **Step 1: 在 `lib_test.rs` 写失败测试（`/_/` 现在应返回 404）**

把以下内容追加到 `crates/server/src/lib_test.rs` 末尾：

```rust
// ============ Admin UI 路由已删除 ============

#[tokio::test]
async fn test_admin_path_已屏蔽_返回404() {
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    let app = create_app(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/app-testid/_/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // _/ 路由删除后落到静态文件 handler，public_dir 下无 _ 目录 → 404
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
```

同时，把 `crates/server/src/lib_test.rs:166-263`（4 个 `test_admin_proxy_*` 测试）**整段删除**：

- `test_admin_proxy_admin_token_未配置_返回403`
- `test_admin_proxy_token_不匹配_返回401`
- `test_admin_proxy_token_匹配后继续路由_非_app_前缀_404`
- `test_admin_proxy_非_app_前缀_返回404`

（这些测试在 `lib_test.rs` 第 166 行到第 263 行之间，连同它们前面的 `// ============ Issue #2：Admin UI 代理保护 ============` 注释行）

- [ ] **Step 2: 跑测试验证编译错误**

```bash
cargo build -p agent-sites
```
预期：编译仍通过（测试改动），但下面的步骤会引入编译错误。先运行确认基线。

```bash
cargo test -p agent-sites --lib lib_test::test_admin_path_已屏蔽_返回404
```
预期：失败（403 ≠ 404，因为路由还指向 `serve_admin_proxy`）

- [ ] **Step 3: 在 `lib.rs::create_app` 删 `/_/` 路由块**

把 `crates/server/src/lib.rs:36-43`（含注释 + route）替换为：

```rust
        // 管理 API
        .nest("/api", api::routes())
        // PocketBase Client API 代理：/app-{id}/api/* → localhost:{port}/api/*
        .route(
            "/{app_id}/api/{*path}",
            get(serve_api_proxy)
                .post(serve_api_proxy)
                .put(serve_api_proxy)
                .delete(serve_api_proxy)
                .patch(serve_api_proxy),
        )
```

即：删除原来的 `PocketBase Admin UI 代理` route 块（5 行 method chain）和注释。

- [ ] **Step 4: 删 `serve_admin_proxy` handler 函数**

把 `crates/server/src/lib.rs:87-134`（整个 `serve_admin_proxy` 函数，从 `async fn serve_admin_proxy(` 到对应 `}`）删除。

- [ ] **Step 5: 删 `constant_time_eq` 函数**

把 `crates/server/src/lib.rs:155-165`（`constant_time_eq` 函数 + 上方注释）删除：

```rust
/// 常量时间字节比较，防止计时侧信道攻击。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
```

- [ ] **Step 6: 跑测试验证通过 + 确认 admin_proxy 测试已删**

```bash
cargo test -p agent-sites --lib lib_test
```
预期：剩下的非 admin_proxy 测试 + 新 `/_/` 404 测试全过；admin_proxy 相关函数不再被引用

- [ ] **Step 7: 跑 clippy 验证无 dead code 警告**

```bash
cargo clippy -p agent-sites -- -D warnings 2>&1 | tail -20
```
预期：无 `constant_time_eq is never used` 或类似 dead_code 警告

- [ ] **Step 8: 提交**

```bash
git add crates/server/src/lib.rs crates/server/src/lib_test.rs
git commit -m "$(cat <<'EOF'
refactor(routing): 删除 /_/ Admin UI 代理路由

- 删 serve_admin_proxy handler + constant_time_eq（dead code）
- /_/ 路径落到静态文件 handler 自然 404（public_dir 下无 _ 目录）
- 删 4 个 admin_proxy 测试，新增 _/ 404 测试

预置 superuser 后抢注窗口已堵死，Admin UI 不再需要。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: 移除 `admin_token` 配置（state + main）

**Files:**
- Modify: `crates/server/src/state.rs`
- Modify: `crates/server/src/main.rs`
- Modify: `crates/server/src/lib_test.rs::make_state_with_token`
- Modify: `crates/server/src/api/apps_test.rs::make_app_state_with_range`

**目的：** `admin_token` 失去防御对象（`/_/` 已删），清除配置项 + state 字段 + CLI 参数。

- [ ] **Step 1: 跑现有测试建立基线**

```bash
cargo test -p agent-sites --lib
```
预期：当前全过（基线）

- [ ] **Step 2: 改 `state.rs` 删 `admin_token`**

把 `crates/server/src/state.rs` **整体替换**为：

```rust
use crate::process::PocketBaseProcessManager;
use std::path::PathBuf;

/// 全局共享状态（硬切换后无 sqlx）
pub struct AppState {
    pub pb_binary: PathBuf,
    pub data_dir: PathBuf,
    pub public_dir: PathBuf,
    pub store: crate::app::store::AppStore,
    pub process_manager: PocketBaseProcessManager,
    pub max_apps: usize,
    pub port_min: u16,
    pub port_max: u16,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pb_binary: PathBuf,
        data_dir: PathBuf,
        public_dir: PathBuf,
        store: crate::app::store::AppStore,
        process_manager: PocketBaseProcessManager,
        max_apps: usize,
        port_min: u16,
        port_max: u16,
    ) -> Self {
        Self {
            pb_binary,
            data_dir,
            public_dir,
            store,
            process_manager,
            max_apps,
            port_min,
            port_max,
        }
    }

    /// 测试用：覆盖默认端口范围
    #[cfg(test)]
    pub fn with_port_range(mut self, min: u16, max: u16) -> Self {
        self.port_min = min;
        self.port_max = max;
        self
    }
}
```

- [ ] **Step 3: 改 `main.rs` 删 `--admin-token` CLI 参数 + 警告日志 + AppState 构造实参**

把 `crates/server/src/main.rs:35-38`（CLI 参数 doc 注释 + 字段）删除：

```rust
    /// Admin UI 代理访问令牌（/app-{id}/_/* 需要请求头 X-Admin-Token 匹配）。
    /// 不设置时 Admin UI 代理完全禁用（返回 403），避免 superuser 抢注。
    #[arg(long, env = "ADMIN_TOKEN", default_value = "")]
    admin_token: String,
```

把 `crates/server/src/main.rs:56-63`（token 转换 + 警告日志）删除：

```rust
    let admin_token = if cli.admin_token.is_empty() {
        None
    } else {
        Some(cli.admin_token.clone())
    };
    if admin_token.is_none() {
        tracing::warn!("ADMIN_TOKEN 未设置：Admin UI 代理 (/app-{{id}}/_/*) 将被完全禁用");
    }
```

把 `crates/server/src/main.rs:65-75`（`AppState::new` 调用）替换为：

```rust
    let state = Arc::new(AppState::new(
        pb_binary,
        data_dir,
        public_dir,
        store,
        process_manager,
        cli.max_apps,
        cli.pb_port_min,
        cli.pb_port_max,
    ));
```

- [ ] **Step 4: 改 `lib_test.rs::make_state_with_token`**

把 `crates/server/src/lib_test.rs:11-34`（`make_state` + `make_state_with_token`）整体替换为：

```rust
async fn make_state(tmp: &tempfile::TempDir) -> Arc<AppState> {
    let data_dir = tmp.path().join("data");
    let public_dir = tmp.path().join("public");
    tokio::fs::create_dir_all(&data_dir).await.unwrap();
    tokio::fs::create_dir_all(&public_dir).await.unwrap();
    let store = AppStore::new(data_dir.join("apps.json"), 20000, 20100);
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    Arc::new(AppState::new(
        pb_binary_path(),
        data_dir,
        public_dir,
        store,
        pm,
        50,
        // 用独立端口范围避免与 process::mod_test（19000/19200/19400）并行测试端口冲突
        20000,
        20100,
    ))
}
```

- [ ] **Step 5: 改 `apps_test.rs::make_app_state_with_range`**

把 `crates/server/src/api/apps_test.rs:28-39`（`Arc::new(AppState::new(...))` 调用）替换为：

```rust
    Arc::new(AppState::new(
        pb_binary_path(),
        data_dir,
        public_dir,
        store,
        pm,
        50,
        port_min,
        port_max,
    ))
```

- [ ] **Step 6: 跑全测试验证通过**

```bash
cargo test -p agent-sites --lib
cargo test -p agent-sites --bins
```
预期：全过

- [ ] **Step 7: 跑 clippy 验证无警告**

```bash
cargo clippy -p agent-sites -- -D warnings 2>&1 | tail -20
```
预期：无警告

- [ ] **Step 8: 验证 cargo run 不再输出 ADMIN_TOKEN 警告**

```bash
cargo run -- --help 2>&1 | grep -i admin_token
```
预期：无输出（CLI 参数已删）

- [ ] **Step 9: 提交**

```bash
git add crates/server/src/state.rs crates/server/src/main.rs crates/server/src/lib_test.rs crates/server/src/api/apps_test.rs
git commit -m "$(cat <<'EOF'
refactor(state): 移除 ADMIN_TOKEN 配置

- state.rs: 删 admin_token 字段 + with_admin_token 测试 helper
- main.rs: 删 --admin-token CLI 参数 + 未设置警告
- lib_test.rs / apps_test.rs: AppState::new 调用去掉 token 实参

/_/ 路由已删 + superuser 预置后，ADMIN_TOKEN 防御对象消失。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: 文档同步（CLAUDE.md / README.md / architecture.md）

**Files:**
- Modify: `CLAUDE.md`（删 `ADMIN_TOKEN` 行）
- Modify: `README.md`（删 `ADMIN_TOKEN` 行）
- Modify: `docs/architecture.md`（§4.1/§4.2/§7.1/§7.2 改 superuser 凭证流程）

**目的：** 让文档反映新行为：删 `ADMIN_TOKEN` 配置说明、删 `/_/` 路径、说明 Agent 通过 superuser 凭证换 token 调 Admin API。

- [ ] **Step 1: 删 `CLAUDE.md` 的 `ADMIN_TOKEN` 行**

在 `CLAUDE.md` 找到「环境变量」表，删除最后一行（`| ADMIN_TOKEN | ... |`）。

- [ ] **Step 2: 删 `README.md` 的 `ADMIN_TOKEN` 行**

在 `README.md` 找到对应的环境变量表，删除 `ADMIN_TOKEN` 行。

- [ ] **Step 3: 改 `docs/architecture.md` §4.1 + §4.2 删 `/_/` 路径**

在 `docs/architecture.md:53-69` 找到 §4.1（路由示例）和 §4.2（路由规则表），按以下修改：

§4.1 删除「Admin UI」相关示例行：
```
https://vibe.example.com/app-a/_/      → App A PocketBase Admin UI
https://vibe.example.com/app-b/_/      → App B PocketBase Admin UI
```

§4.2 表格删除「`/app-{id}/_/*`」行：
```
| `/app-{id}/_/*` | PocketBase Admin UI | 代理到 `localhost:{port}/_/*` |
```

在 §4.2 表格下方追加：

```markdown
> 注：PocketBase Admin UI (`/_/`) 已不通过网关暴露。每个 App 的 superuser 在 spawn 前预置（详见 §5.2），Agent 通过 `/api/collections/_superusers/auth-with-password` 拿 token 后操作 collections。
```

- [ ] **Step 4: 改 `docs/architecture.md` §5.2 加预置 superuser 说明**

在 §5.2「PocketBase 启动参数」末尾追加：

```markdown
### 5.2.1 Superuser 预置

PocketBase 进程 spawn **之前**，平台调用 `pocketbase superuser upsert` 子命令预置 superuser，避免任何 App 出现「首次注册」抢注窗口。

- 邮箱：`admin@{app_id}.local`（如 `admin@app-abc12345.local`）
- 密码：32 字符 hex（uuid v4 simple）
- 凭证存入 `AppStore`，与 App 元数据同级序列化到 `apps.json`（明文）
- App 创建响应里返回 `superuser_email` + `superuser_password` 给调用方（agent）

Agent 调用 Admin API 流程：

```
POST /{app_id}/api/collections/_superusers/auth-with-password
  body: { "identity": "<email>", "password": "<password>" }
→ response: { "token": "...", "record": { ... } }

# 用 token 调 Admin API
POST /{app_id}/api/collections
  header: Authorization = <token>
  body: { "name": "posts", "schema": [...] }
```
```

- [ ] **Step 5: 改 `docs/architecture.md` §7.1 + §7.2**

把 `docs/architecture.md:152-173`（§7.1 + §7.2 标题）替换为：

```markdown
### 7.1 认证

**App 创建后返回 superuser 凭证**：

- `POST /api/apps` 创建 App → 响应含 `superuser_email` + `superuser_password`
- Agent 自行管理凭证（持久化到 agent 自己的存储或环境变量）
- 网关不再额外引入 API Key 或 Token 机制——superuser 凭证即身份

### 7.2 Schema 变更（agent 调 Admin API）

Agent 用 superuser 凭证换 token，通过标准 PocketBase Admin API 操作 collection：

```
# 1. 换 token
POST /app-{id}/api/collections/_superusers/auth-with-password
  body: { "identity": "<superuser_email>", "password": "<superuser_password>" }

# 2. 用 token 操作 collections
POST   /app-{id}/api/collections            创建 collection
PATCH  /app-{id}/api/collections/:id        修改 collection
DELETE /app-{id}/api/collections/:id        删除 collection
```

- Rust 网关 **不封装、不拦截、不校验**——透传到 PocketBase
- Agent 全权负责数据完整性
- Schema 变更导致的数据丢失由 agent 自行承担
```

- [ ] **Step 6: 改 `docs/architecture.md` §6.1（Auth Cookie 行保留但补说明）**

在 `docs/architecture.md:128-148`（§6 数据隔离），保留所有现有行。不需要修改（cookie 隔离由 proxy 层负责，与此改动无关）。

- [ ] **Step 7: 验证文档无残留 `/_/` 路径**

```bash
grep -n "/_/" CLAUDE.md README.md docs/architecture.md
```
预期：architecture.md 中应该没有 `/_/` 路径作为路由出现（可能在 §7.2.1 介绍里有 `/api/collections/_superusers` 但那是 API 路径不是 Admin UI）

- [ ] **Step 8: 验证文档无残留 `ADMIN_TOKEN`**

```bash
grep -rn "ADMIN_TOKEN" CLAUDE.md README.md docs/
```
预期：无输出

- [ ] **Step 9: 提交**

```bash
git add CLAUDE.md README.md docs/architecture.md
git commit -m "$(cat <<'EOF'
docs: 同步 superuser 预置 + 删 Admin UI 路由

- CLAUDE.md / README.md: 删 ADMIN_TOKEN 环境变量
- architecture.md §4.1/§4.2: 删 /_/ Admin UI 路径
- architecture.md §5.2.1: 新增 Superuser 预置小节
- architecture.md §7.1/§7.2: 改为 agent 用凭证换 token 调 Admin API

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 7: 全套验收（测试 + clippy + fmt + e2e）

**Files:** 无文件修改

**目的：** 跑全套测试 + 静态检查 + 端到端验证，确认 spec §8 验收标准全过。

- [ ] **Step 1: 跑全量 lib + bin 测试**

```bash
cargo test -p agent-sites
```
预期：所有测试通过。如 PB 可用，e2e 测试（含 `test_端到端_预置_superuser_可换token`）也通过。

- [ ] **Step 2: 跑 clippy 严格模式**

```bash
cargo clippy -p agent-sites --all-targets -- -D warnings
```
预期：无警告

- [ ] **Step 3: 跑 fmt 检查**

```bash
cargo fmt -p agent-sites -- --check
```
预期：无 diff（输出空）

- [ ] **Step 4: 端到端手动验证**

```bash
# 启动服务
cargo run &
SERVER_PID=$!
sleep 3

# 创建 App
RESP=$(curl -s -X POST http://localhost:3000/api/apps \
  -H 'Content-Type: application/json' \
  -d '{"name":"manual-e2e"}')
echo "$RESP" | python3 -m json.tool

# 抽取凭证
APP_ID=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")
EMAIL=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_email'])")
PASSWORD=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_password'])")
echo "App: $APP_ID, Email: $EMAIL"

# 验证 /_/ 屏蔽（应 404，不是 403）
echo "--- 验证 /_/ 屏蔽 ---"
curl -s -o /dev/null -w "Status: %{http_code}\n" "http://localhost:3000/$APP_ID/_/"

# 验证凭证换 token
echo "--- 验证 superuser auth ---"
AUTH=$(curl -s -X POST "http://localhost:3000/$APP_ID/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$AUTH" | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])")
echo "Token: ${TOKEN:0:30}..."

# 用 token 创建 collection
echo "--- 创建 collection ---"
curl -s -X POST "http://localhost:3000/$APP_ID/api/collections" \
  -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"posts","type":"base","schema":[{"name":"title","type":"text"}]}'

# 清理
kill $SERVER_PID
wait 2>/dev/null
```

预期输出关键断言：
- App 创建响应含 `superuser_email` 和 `superuser_password` 字段
- `/$APP_ID/_/` 返回 `Status: 404`
- Token 不为空
- Collection 创建成功

- [ ] **Step 5: 更新 memory 文档**

更新 `/Users/konghayao/.claude/projects/-Users-konghayao-code-ai-agent-sites/memory/project_pocketbase_pivot.md`，在「5 个 minor 残留」前追加一段：

```markdown
**后续修复（2026-06-19 superuser-init plan）**：
1. ✅ App 创建时预置 PocketBase superuser（spawn 前 `pocketbase superuser upsert`），消除首次注册抢注窗口
2. ✅ 删除 `/_/` Admin UI 代理路由（落到静态文件 handler 自然 404）
3. ✅ 删除 `ADMIN_TOKEN` 配置（state 字段 + CLI 参数 + 文档），预置 superuser 后无防御对象
4. ✅ AppResponse 删 `admin_path`，加 `superuser_email`/`superuser_password` 给 agent
5. ✅ 文档同步（CLAUDE.md / README.md / architecture.md）
```

注意：原 5 个 minor 残留**仍然存在**（与本 plan 改动正交，不重复报告）。

- [ ] **Step 6: 全部提交完成（如 memory 文件有改动）**

memory 文件不在 git 仓库内（在 `~/.claude/projects/...`），无需 git 提交。

- [ ] **Step 7: 最终提交 log 检查**

```bash
git log --oneline -10
```
预期：看到 6 个本 plan 的提交（Task 1-6 各一个）+ 之前的提交

---

## Self-Review

### Spec 覆盖性

| Spec 章节 | 对应任务 | 状态 |
|---|---|---|
| §4.1 init_superuser 函数 | Task 1 | ✅ |
| §4.2 create_app 接入 | Task 3 | ✅ |
| §4.3 App 模型加字段 | Task 2 | ✅ |
| §4.4 AppResponse 调整 | Task 3 Step 3 | ✅ |
| §4.5 屏蔽 /_/ 路由 | Task 4 | ✅ |
| §4.6 移除 admin_token | Task 5 | ✅ |
| §4.7 测试改动 | Task 1/3/4/5（分散） | ✅ |
| §4.8 文档同步 | Task 6 | ✅ |
| §5 错误处理 | Task 3 Step 4（init 失败回滚） | ✅ |
| §6 安全考量 | 不需代码任务，文档已说 | ✅ |
| §8 验收标准 | Task 7 | ✅ |

### Type 一致性检查

- `init_superuser(binary: &Path, data_dir: &Path, email: &str, password: &str) -> std::io::Result<()>` —— Task 1 定义，Task 3 调用 ✅
- `App { superuser_email: String, superuser_password: String, #[serde(default)] }` —— Task 2 定义，Task 3 使用 ✅
- `AppResponse { superuser_email, superuser_password, 删 admin_path }` —— Task 3 定义，无后续依赖 ✅
- `AppState::new` 签名（去 admin_token）—— Task 5 定义，Task 5 调用 ✅

### 占位符扫描

无 TBD/TODO/「实现细节自定」/「similar to Task N」。每个 Step 都有完整代码或完整命令。

### 跨任务依赖

- Task 1（init_superuser）→ Task 3（create_app 用）: Task 3 依赖 Task 1 函数已存在
- Task 2（App 字段）→ Task 3（create_app 写入字段）: Task 3 依赖 Task 2 字段已加
- Task 4（删 /_/ 路由）→ Task 5（删 admin_token）: 都改 state/lib，**必须串行**
- Task 6（文档）独立，可在任何时间做，但放最后避免中间状态
- Task 7（验收）必须最后

执行顺序：**Task 1 → 2 → 3 → 4 → 5 → 6 → 7**（严格串行）
