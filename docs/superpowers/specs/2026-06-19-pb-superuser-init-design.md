# PocketBase 预置 Superuser + 屏蔽 Admin UI 设计

> 2026-06-19
> 分支：`feat/pocketbase-pivot`
> 目标：消除 PocketBase Admin UI 首次注册抢注窗口，简化凭证管理

## 1. 背景

当前 `feat/pocketbase-pivot` 分支的实现里，每个 App 创建后 spawn 一个裸 PocketBase 进程，**不预置 superuser**。这导致：

1. 任何能访问 `/_/` 的人看到「创建首个超级管理员」表单 → 抢注风险
2. 现有防御手段是 `ADMIN_TOKEN` 网关层校验（`/app-{id}/_/*` 需 `X-Admin-Token`），但：
   - 增加配置项和运维复杂度
   - 即便配了 token，能访问 `/_/` 的人看到登录页才有效；没有 superuser 时仍是注册页
3. Agent 想操作 collection（schema 变更）时没有标准 superuser 凭证，无路可走

## 2. 目标与非目标

### 目标

- App 创建时自动预置 superuser，**杜绝首次注册抢注**
- 删除 `ADMIN_TOKEN` 网关层（连同 `/app-{id}/_/*` 路由一起删除）
- Agent 通过 `/api/collections/_superusers/auth-with-password` 换 token，再用 token 操作 `/api/collections/*` 等 Admin API 端点（已有 `/api/*` 代理覆盖）
- App 重启（崩溃恢复）后凭证不变、仍有效

### 非目标

- 不实现 7 天删除宽限期（仍属后续 plan）
- 不实现崩溃检测/自动重启
- 不改 PocketBase 二进制升级流程
- 不引入端到端加密存储 superuser 凭证（明文存 `data/apps.json`，与现有 metadata 同级保护）

## 3. 方案概览

**A. 预置 superuser**：spawn PB 之前调 `pocketbase superuser upsert --dir=<data_dir> <email> <password>`，PB 自动初始化 schema + 写入 superuser 行。

**B. 屏蔽 Admin UI 路由**：删除 `lib.rs` 的 `/app-{id}/_/{*path}` 路由 + handler + `constant_time_eq`。`_` 路径落到通用 `/app-{id}/{*path}` 静态文件 handler，因 `data_dir` 下没有 `_` 子目录 → 自然 404。

**C. 移除 ADMIN_TOKEN 防护**：删除 `AppState::admin_token` 字段 + `main.rs::--admin-token` CLI 参数 + `state.rs::with_admin_token` 测试 helper。

**D. 凭证对外暴露**：`AppResponse` 增 `superuser_email` + `superuser_password` 字段，调用方拿凭证自行换 token。

## 4. 详细设计

### 4.1 `process/pocketbase.rs` — 新增 `init_superuser`

```rust
/// 在 spawn PocketBase 之前预置 superuser，避免首次注册页面被抢注。
///
/// 调用 `pocketbase superuser upsert <email> <password>`，操作 SQLite 数据
/// 目录，**不需要 PocketBase 进程在运行**。空目录时 PocketBase 自动初始化
/// schema（生成 data.db / auxiliary.db）。
///
/// `upsert` 幂等：同 email 二次调用更新密码，无副作用。
/// 调用方应保证 email RFC 格式（如 `admin@app-xxx.local`），否则 PocketBase
/// 拒绝并返回错误。
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

### 4.2 `api/apps.rs::create_app` — 在 spawn 前调 `init_superuser`

调用顺序（关键：**先 init，后 spawn**，否则 PB 启动后会暴露注册窗口）：

```rust
// 分配 id（沿用现有逻辑）
let id = ...;
let data_dir = state.data_dir.join(&id);
let superuser_email = format!("admin@{}.local", id);  // 如 admin@app-abc12345.local
let superuser_password = uuid::Uuid::new_v4().simple().to_string();  // 32 hex

// 1. 创建目录
tokio::fs::create_dir_all(&data_dir).await
    .map_err(|e| AppError::Internal(format!("创建数据目录失败: {e}")))?;

// 2. 预置 superuser（spawn 前）
if let Err(e) = crate::process::pocketbase::init_superuser(
    &state.pb_binary,
    &data_dir,
    &superuser_email,
    &superuser_password,
) {
    // 清理占位记录（沿用现有 start 失败回滚逻辑）
    state.store.remove(&app.id).await;
    state.store.flush().await.ok();
    return Err(AppError::Internal(format!("预置 superuser 失败: {e}")));
}

// 3. spawn PB（沿用现有 process_manager.start）
let result = state.process_manager
    .start(&id, &data_dir, &cookie_path, &allocator).await;

// 4. start 成功 → 把凭证写入 App，update 到 store
match result {
    Ok(actual_port) => {
        app.port = actual_port;
        app.status = AppStatus::Running;
        app.updated_at = chrono::Utc::now().to_rfc3339();
        app.superuser_email = superuser_email;
        app.superuser_password = superuser_password;
        state.store.update(app.clone()).await;
        // flush（沿用现有逻辑）
    }
    Err(e) => { /* 沿用现有回滚：remove + flush */ }
}
```

注：`process_manager.start` 本身**不变**。它接收 `data_dir`，但 init_superuser 已经把目录创建好了。`start` 内部的 `create_dir_all` 是 no-op（目录已存在）。

### 4.3 `app/model.rs` — 加 2 字段

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct App {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub status: AppStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub superuser_email: String,
    #[serde(default)]
    pub superuser_password: String,
}
```

`#[serde(default)]` 保证加载旧的 `apps.json`（无此字段）时不炸，反序列化为空字符串。后续重启该 App 时 `process_manager.start` 不重新 init（已存在），但元数据空字符串意味着凭证丢失——**接受此限制**（MVP 范围；老的迁移数据可以人工补救）。

`make_placeholder` 闭包（apps.rs）需要补默认值：

```rust
let make_placeholder = |id: &str| -> App {
    let now = chrono::Utc::now().to_rfc3339();
    App {
        id: id.to_string(),
        name: ...,
        port: 0,
        status: AppStatus::Starting,
        created_at: now.clone(),
        updated_at: now,
        superuser_email: String::new(),
        superuser_password: String::new(),
    }
};
```

### 4.4 `AppResponse` 调整

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

`admin_path` 字段删除。Agent 通过 `api_path` + superuser 凭证自行操作：
```
POST /{app_id}/api/collections/_superusers/auth-with-password
  body: { "identity": "<email>", "password": "<password>" }
→ 返回 { "token": "...", "record": { ... } }
```
然后用 `Authorization: <token>` 调 `POST /{app_id}/api/collections` 等。

> 注：路径是 `auth-with-password`，不是 `auth-password`（PB 0.20+ 命名规范）。已在 /tmp/pbtest1 验证返回结构。

### 4.5 屏蔽 `/_/` 路由

`lib.rs::create_app` 删除：

```rust
// 删：
.route(
    "/{app_id}/_/{*path}",
    get(serve_admin_proxy).post(...).put(...).delete(...).patch(...),
)

// 删：serve_admin_proxy 整个函数
// 删：constant_time_eq 函数
```

**未注册的路径自动落到 `/app-{id}/{*path}` 静态文件 handler**。该 handler 检查 `validate_app_id("app-xxx")` ✓ → 检查 `public_dir.join(app_id).join("_/...")` → 不存在 → 404。预期行为符合"屏蔽 Admin UI"。

### 4.6 移除 `admin_token`

**`state.rs`**：删除字段、构造参数、`with_admin_token` 方法。

```rust
pub struct AppState {
    pub pb_binary: PathBuf,
    pub data_dir: PathBuf,
    pub public_dir: PathBuf,
    pub store: crate::app::store::AppStore,
    pub process_manager: PocketBaseProcessManager,
    pub max_apps: usize,
    pub port_min: u16,
    pub port_max: u16,
    // ← admin_token 删除
}

impl AppState {
    pub fn new(
        pb_binary: PathBuf, data_dir: PathBuf, public_dir: PathBuf,
        store: crate::app::store::AppStore,
        process_manager: PocketBaseProcessManager,
        max_apps: usize, port_min: u16, port_max: u16,
        // ← admin_token 参数删除
    ) -> Self { ... }
    // ← with_admin_token 删除
}
```

**`main.rs`**：删除 CLI 参数 + AppState 构造实参。

```rust
// 删：
#[arg(long, env = "ADMIN_TOKEN", default_value = "")]
admin_token: String,

// 删：
let admin_token = if cli.admin_token.is_empty() { ... };
if admin_token.is_none() { tracing::warn!(...) };

// AppState::new 调用去掉最后一个实参
```

### 4.7 测试改动

**删除（lib_test.rs）**：
- `test_admin_proxy_admin_token_未配置_返回403`
- `test_admin_proxy_token_不匹配_返回401`
- `test_admin_proxy_token_匹配后继续路由_非_app_前缀_404`
- `test_admin_proxy_非_app_前缀_返回404`

**修改（lib_test.rs）**：
- `make_state_with_token` 删除或合并到 `make_state`（不再有 token 参数）

**新增（process/pocketbase_test.rs）**：
- `test_init_superuser_空目录_成功_目录非空`：调 init 后 data_dir 下有 data.db
- `test_init_superuser_幂等更新密码_二次调用成功`：连调两次都不报错
- `test_init_superuser_email非法_返回错误`：传 `admin@local` 应返回 Err
- `test_init_superuser_pb不存在_返回错误`：传不存在的 binary 路径

**新增（lib_test.rs）**：
- `test_admin_path_已屏蔽_返回404`：GET `/app-xxx/_/` 返回 404（落到静态文件 handler）
- `test_端到端_预置_superuser_可换token`：创建 app → 用返回的凭证 POST `/api/collections/_superusers/auth-with-password` → 断言 response 含 `token`

### 4.8 文档同步

- `CLAUDE.md`：删除 `ADMIN_TOKEN` 行（环境变量表）
- `README.md`：同
- `docs/architecture.md`：
  - §4.1/§4.2 删除 `/_/` 路径相关描述
  - §6.1 Auth Cookie 行保留（PB `--cookiePath` 已废弃由 proxy 层改写 Set-Cookie，已有）
  - §7.1 「无需认证」改为「App 创建后返回 superuser 凭证，agent 自行管理 token」
  - §7.2 schema 变更：删除「透传到 PB Admin UI」描述，改为「agent 用 superuser 凭证调 `/api/collections/_superusers/auth-password` 拿 token，再操作 collections」

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| `init_superuser` 失败（email 格式错 / 二进制损坏） | 清理 AppStore 占位记录 + flush + 返回 500 `Internal` |
| `init_superuser` 成功但 `process_manager.start` 失败 | 沿用现有回滚逻辑（remove 占位 + flush），但**预置的 superuser 数据残留在 data_dir**。下次同 id 重试时 init_superuser 是 upsert，幂等覆盖，无副作用 |
| 加载旧 `apps.json`（无 superuser 字段） | `#[serde(default)]` → 空字符串。该 App 重启时不会重新 init（start 函数不调 init），导致凭证永远空白。**接受**：旧迁移数据人工补救（MVP 范围） |
| `superuser upsert` 命令输出包含敏感信息 | stdout 输出 `Successfully saved superuser "<email>"!`，不泄露密码。仍 `Stdio::piped` 抑制到日志 |

## 6. 安全考量

- **凭证泄露面**：superuser 密码以明文存于 `data/apps.json`。与现有 App metadata（id/name/port）同级。如未来需要更强保护，可加对称加密（`--encryptionEnv` 留作后续）
- **Agent 信任假设**：架构文档 §7.1 已规定 agent 全权负责数据完整性。返回凭证给创建 App 的调用方符合此假设
- **网络暴露**：PB 绑定 `localhost`，凭证仅在网关进程内流转，外部网络无法直接访问 PB 端口

## 7. 实施步骤概览（writing-plans 详化）

1. 加 `init_superuser` 函数 + 单元测试（pocketbase_test.rs）
2. App 模型加 2 字段 + 更新 `make_placeholder`（apps.rs）+ 旧字段 `#[serde(default)]`
3. `create_app` 接入 init_superuser 调用 + 错误回滚
4. `AppResponse` 字段调整 + 删 `admin_path`
5. 删 `lib.rs` 的 `serve_admin_proxy` 路由 + handler + `constant_time_eq`
6. 删 `state.rs` 的 `admin_token` + `with_admin_token`
7. 删 `main.rs` 的 CLI 参数 + 调用处
8. 删 4 个 admin_proxy 测试，新增 `/_/` 404 测试 + 端到端凭证换 token 测试
9. 文档同步（CLAUDE.md / README.md / architecture.md）

## 8. 验收标准

- `cargo test -p agent-sites` 全过（含 e2e，PB 可用时）
- `cargo clippy -- -D warnings` 全绿
- `cargo fmt --check` 全绿
- 创建一个 App 后：
  - 返回值含 `superuser_email` + `superuser_password` 字段
  - 用凭证 `POST /api/collections/_superusers/auth-with-password` 拿到 token
  - 用 token `POST /api/collections` 创建 collection 成功
- 访问 `/{app_id}/_/` 返回 404（不是 403，不是登录页）
- `cargo run` 不输出 `ADMIN_TOKEN 未设置` 警告
- 旧的 `apps.json`（无 superuser 字段）能被加载（验证 `#[serde(default)]`）
