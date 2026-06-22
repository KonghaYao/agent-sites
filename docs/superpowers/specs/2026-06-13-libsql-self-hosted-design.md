> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# libSQL 自部署设计：替换 Turso Cloud → 本地 sqld 进程

**日期**: 2026-06-13
**状态**: Draft

---

## 一、目标

将平台从依赖 Turso Cloud API 改为完全自托管——通过 spawn `sqld` 子进程为每个站点数据库提供 libSQL HTTP 服务。数据库懒创建（POST 时不启动进程），绑定站点时冷启动 sqld。JWT 认证，环境变量注入模式不变。

---

## 二、架构概览

```
POST /api/databases → 创建数据库记录（懒创建，status=stopped）
                   ↓
  绑定站点时 → ProcessManager 冷启动 sqld 进程
                   ↓
sqld 进程 :{port} ←── JWT 签名，写入 databases 表（加密存储）
                   ↓
Deno 站点启动时 → 平台注入 TURSO_DB_<name>_URL/TOKEN 环境变量
                   ↓
Deno main.ts → createClient({ url: "http://127.0.0.1:{port}", authToken })
```

---

## 三、ProcessManager 改造

### 3.1 进程类型标记

```rust
enum ProcessKind {
    Deno,   // 站点后端
    Sqld,   // 数据库服务器
}

struct ManagedProcess {
    child: Child,
    port: u16,
    kind: ProcessKind,
}
```

Deno 和 sqld 共用端口池。key 区分：
- Deno：`site_id`
- Sqld：`database_id`

### 3.2 新增方法

```rust
impl ProcessManager {
    // 已有
    async fn start_deno(pool, site_id) -> Result<u16>
    async fn stop_deno(pool, site_id) -> Result<()>

    // 新增
    async fn start_sqld(pool, database_id) -> Result<u16>
    async fn stop_sqld(pool, database_id) -> Result<()>
}
```

### 3.3 sqld 启动参数

```
sqld --no-welcome --http-listen-addr 0.0.0.0:{port} -d {data_dir}/{database_id} --auth-jwt-key {jwt_key}
```

若 `sqld_jwt_key` 未配置，不传 `--auth-jwt-key`（无认证模式）。

---

## 四、数据模型变更

### 4.1 `databases` 表字段变更

| 字段 | 旧含义 | 新含义 |
|------|--------|--------|
| `turso_db_name` | Turso Cloud 数据库名 | 本地数据库名（= id） |
| `turso_url` | `libsql://xxx.turso.io` | `http://127.0.0.1:{port}`（启动后填充） |
| `turso_token` | Cloud API token | JWT token（加密存储） |
| `sqld_port` | 无 | **新增** INTEGER — sqld 进程端口 |
| `status` | active / inactive | stopped / active / inactive |

迁移 SQL 新增 `sqld_port` 列（可空）。

`status` 语义：
- `stopped` — 初始状态（懒创建后，sqld 未启动）
- `active` — sqld 运行中
- `inactive` — 已软删除

### 4.2 `site_database_bindings` 表不变

多对多绑定关系不变。

---

## 五、API 变更

### 5.1 创建数据库

**请求**：`POST /api/databases { "name": "my-db" }`（移除 `region` 字段）

**行为**：
1. 生成 UUID → database_id
2. 签发 JWT token（如有 `sqld_jwt_key`，使用 HS256）
3. 写入 `databases` 表：status=`stopped`，sqld_port=NULL，token 加密存储
4. **不启动 sqld 进程**（懒创建）
5. 返回 `{ id, name, status: "stopped" }`

### 5.2 绑定数据库到站点

**请求**：`POST /api/sites/:id/bindings { "database_id": "..." }`

**行为**：
1. 验证 site 和 database 存在
2. 如 database status 为 `stopped`，**立即启动 sqld** 进程
3. 更新 database 的 `sqld_port` 和 `turso_url`
4. 写入绑定记录
5. 返回 201

### 5.3 删除数据库

**请求**：`DELETE /api/databases/:id`

**行为**：
1. 软删除：`status` → `inactive`
2. 停止 sqld 进程（如有）
3. 清理所有站点绑定
4. 清理 `data_dir/{database_id}` 目录（异步）
5. 返回 204

### 5.4 列出/获取数据库

不变。sqld 进程相关的 `sqld_port` 字段不暴露在响应中（内部使用）。

---

## 六、环境变量注入

Deno 站点启动时，`ProcessManager::start_deno` 查询绑定的数据库：

```rust
for db in list_database_details_for_site(pool, site_id).await? {
    // TURSO_DB_<NAME>_URL = http://127.0.0.1:{sqld_port}
    // TURSO_DB_<NAME>_TOKEN = {decrypted_jwt}
}
```

连接 URL 从 `libsql://` 变为 `http://`，Deno 站点代码无需修改。

---

## 七、配置变更

### 7.1 删除

| 配置项 | 原因 |
|--------|------|
| `turso_api_url` | 不再调 Turso Cloud API |
| `turso_api_token` | 同上 |
| `turso_org` | 同上 |

### 7.2 新增

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `sqld_path` | sqld 二进制路径 | `sqld`（PATH 查找） |
| `sqld_data_dir` | 数据库文件目录 | `{storage_dir}/databases/` |
| `sqld_jwt_key` | JWT HS256 密钥 | 空字符串（无认证） |

### 7.3 保留

`max_upload_size_mb`、`data_encryption_key` 不变。

---

## 八、移除 TursoClient 模块

- 删除 `crates/server/src/turso/` 整个模块（`mod.rs` + `mod_test.rs`）
- `AppState` 移除 `turso_client` 字段
- 移除所有 `TursoClient` import / 引用
- `databases/create_database` handler 改为本地生成 JWT + 写记录

---

## 九、实现任务拆分

| # | Task | 涉及文件 |
|---|------|----------|
| 1 | 移除 TursoClient 模块 | `turso/`、`lib.rs`、`main.rs`、`config.rs`、`api/databases.rs` |
| 2 | 数据库迁移扩展 | `migrations/` — 新增 `sqld_port` 列 |
| 3 | 模型扩展 + JWT 签发 | `models.rs`、`models_test.rs` |
| 4 | ProcessManager: ProcessKind + sqld 启动/停止 | `process/mod.rs`、`process/deno.rs` |
| 5 | 数据库 API 重写 | `api/databases.rs`、`api/databases_test.rs` |
| 6 | 绑定 API 集成（绑定时冷启动 sqld） | `api/bindings.rs`、`api/bindings_test.rs` |
| 7 | 配置 + Cli + AppState 清理 | `config.rs`、`main.rs`、`lib.rs` |
| 8 | Docker + README 更新 | `Dockerfile`、`docker-compose.yml`、`README.md` |

---

## 十、设计决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| sqld 管理方式 | 复用 ProcessManager | 减少重复代码，端口池共享 |
| 数据库创建 | 懒创建 | 创建不启动进程，节省资源 |
| 冷启动时机 | 绑定时立即启动 | Deno 代码 `createClient` 会立即连接 |
| 认证方式 | JWT (HS256) | 标准、SDK 兼容、密钥托管在平台 |
| sqld 二进制来源 | 预装（PATH 查找） | 和 Deno 方式一致 |
| 端口管理 | 和 Deno 共用池 | 简化端口分配逻辑 |
| 连接 URL | `http://127.0.0.1:{port}` | 本地进程，无需 `libsql://` |
