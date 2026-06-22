> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# Phase 3+4 打磨计划：文档同步 + 安全增强 + 运维完善

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 补充 Phase 3+4 实现后的打磨工作——README 文档同步、Turso token 加密存储、优雅降级、Docker 配置更新。

**Architecture:** 各 Task 独立，互不依赖。Token 加密使用 AES-256-GCM（通过 `aes-gcm` crate），密钥从环境变量 `DATA_ENCRYPTION_KEY` 注入，加密/解密在 models 层 CRUD 函数和 env 注入处透明完成。

**Tech Stack:** aes-gcm 0.10, sha2 0.10（已有）, hex

**Spec:** 无独立 spec，依据 Phase 3+4 最终代码审查报告。

---

## 文件结构总览

```
crates/server/src/
├── crypto/                     # [新建] 加密工具模块
│   ├── mod.rs                  # Encryptor (encrypt/decrypt)
│   └── mod_test.rs             # 加密往返测试
├── db/
│   └── models.rs               # [修改] create_database 加密 token，list_database_details_for_site 解密
├── api/
│   └── databases.rs            # [修改] 检测 turso_token 为空时返回明确错误
├── process/
│   └── mod.rs                  # [修改] 解密 token 后再注入 env
├── lib.rs                      # [修改] AppState 新增 crypto_encryptor
├── main.rs                     # [修改] Cli 新增 encryption_key 参数
├── config.rs                   # [修改] Config 新增 data_encryption_key
├── error.rs                    # [修改] 新增 Crypto 错误变体
├── README.md                   # [修改] 阶段 3+4 标记完成 + 新环境变量
Dockerfile                      # [修改] 新增环境变量声明
docker-compose.yml              # [修改] 新增环境变量声明
.gitignore                      # [修改] 移除 .claude/skills/ 排除
Cargo.toml                      # [修改] 新增 aes-gcm + hex 依赖
crates/server/Cargo.toml        # [修改] 引用新依赖
```

---

## Task 1: 新增加密依赖 + Crypto 模块

**Files:**
- Modify: `Cargo.toml`（workspace deps）
- Modify: `crates/server/Cargo.toml`（crate deps）
- Create: `crates/server/src/crypto/mod.rs`
- Create: `crates/server/src/crypto/mod_test.rs`
- Modify: `crates/server/src/lib.rs`（注册模块）

### Step 1: 新增 workspace 依赖

Modify `Cargo.toml`，在 `sha2 = "0.10"` 之后新增：

```toml
aes-gcm = "0.10"
hex = "0.4"
```

### Step 2: crate 引用

Modify `crates/server/Cargo.toml`，新增：

```toml
aes-gcm.workspace = true
hex.workspace = true
```

### Step 3: 编写测试

Create `crates/server/src/crypto/mod_test.rs`:

```rust
use crate::crypto::Encryptor;

#[test]
fn test_encrypt_decrypt_往返一致() {
    // 32 字节 AES-256 密钥
    let key = b"abcdefghijklmnopqrstuvwxyz123456";
    let encryptor = Encryptor::new(key);

    let plaintext = "my-secret-token-value";
    let encrypted = encryptor.encrypt(plaintext);
    assert_ne!(encrypted, plaintext); // 加密后不等于原文

    let decrypted = encryptor.decrypt(&encrypted).unwrap();
    assert_eq!(decrypted, plaintext);
}

#[test]
fn test_decrypt_错误密文返回_err() {
    let key = b"abcdefghijklmnopqrstuvwxyz123456";
    let encryptor = Encryptor::new(key);
    let result = encryptor.decrypt("not-a-valid-ciphertext");
    assert!(result.is_err());
}
```

### Step 4: 运行测试确认失败

Run: `cargo test -p agent-sites -- crypto::mod_test`
Expected: FAIL

### Step 5: 编写 Crypto 模块

Create `crates/server/src/crypto/mod.rs`:

```rust
use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use hex::{decode, encode};

/// AES-256-GCM 加密器
#[derive(Clone)]
pub struct Encryptor {
    cipher: Aes256Gcm,
}

impl Encryptor {
    /// 从 32 字节密钥创建
    pub fn new(key_bytes: &[u8; 32]) -> Self {
        let key = Key::<Aes256Gcm>::from_slice(key_bytes);
        let cipher = Aes256Gcm::new(key);
        Self { cipher }
    }

    /// 加密明文，返回 hex 编码的 nonce + ciphertext
    pub fn encrypt(&self, plaintext: &str) -> String {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .expect("AES-GCM 加密失败");
        // nonce (12 bytes) + ciphertext → hex
        let mut combined = nonce.to_vec();
        combined.extend_from_slice(&ciphertext);
        encode(combined)
    }

    /// 解密 hex 编码的密文，返回明文字符串
    pub fn decrypt(&self, hex_ciphertext: &str) -> Result<String, String> {
        let combined = decode(hex_ciphertext).map_err(|e| format!("hex 解码失败: {e}"))?;
        if combined.len() < 12 {
            return Err("密文太短".to_string());
        }
        let (nonce_bytes, ciphertext) = combined.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| format!("解密失败: {e}"))?;
        String::from_utf8(plaintext).map_err(|e| format!("UTF-8 解码失败: {e}"))
    }
}
```

### Step 6: 注册模块

Modify `crates/server/src/lib.rs`，在 `pub mod turso;` 之后新增：

```rust
pub mod crypto;
```

### Step 7: 运行测试确认通过

Run: `cargo test -p agent-sites -- crypto::mod_test`
Expected: PASS

### Step 8: 构建验证

Run: `cargo build -p agent-sites`
Expected: PASS

### Step 9: 提交

```bash
git add Cargo.toml crates/server/Cargo.toml crates/server/src/crypto/ crates/server/src/lib.rs
git commit -m "feat: AES-256-GCM 加密模块（token 加密存储用）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 2: Token 加密存储 + 解密注入

**Files:**
- Modify: `crates/server/src/config.rs`（新增 data_encryption_key）
- Modify: `crates/server/src/main.rs`（Cli 新增参数 + 初始化 Encryptor）
- Modify: `crates/server/src/lib.rs`（AppState 新增 encryptor）
- Modify: `crates/server/src/db/models.rs`（create_database 加密存储，list_database_details_for_site 解密返回）
- Modify: `crates/server/src/process/mod.rs`（start 中 env 注入）
- Modify: `crates/server/src/error.rs`（新增 Crypto 变体）
- Modify: 所有测试文件（AppState 构造新增 encryptor 字段）

### Step 1: 配置扩展

Modify `crates/server/src/config.rs`，在 `max_upload_size_mb` 之后新增：

```rust
    /// 数据库 token 加密密钥（32 字节 hex 编码，可选）
    pub data_encryption_key: Option<[u8; 32]>,
```

### Step 2: Cli 新增参数

Modify `crates/server/src/main.rs`，在 `max_upload_size_mb` 之后新增：

```rust
    /// 数据加密密钥（64 字符 hex 字符串，32 字节）
    #[arg(long, env = "DATA_ENCRYPTION_KEY")]
    data_encryption_key: Option<String>,
```

在 main 函数中，TursoClient 初始化之后，新增：

```rust
// 初始化加密器
let encryptor = cli.data_encryption_key.as_ref().map(|hex_key| {
    let bytes = hex::decode(hex_key).expect("DATA_ENCRYPTION_KEY 必须是 64 字符 hex 字符串");
    let key: [u8; 32] = bytes.try_into().expect("DATA_ENCRYPTION_KEY 必须为 32 字节");
    agent_sites::crypto::Encryptor::new(&key)
});
```

### Step 3: AppState 扩展

Modify `crates/server/src/lib.rs`，新增：

```rust
use crate::crypto::Encryptor;
```

在 AppState 中新增：

```rust
    pub encryptor: Option<Encryptor>,
```

更新 `create_app` 中的 `with_state` 不变（编译时不会报错，因为 AppState 只是数据）。

### Step 4: 错误类型扩展

Modify `crates/server/src/error.rs`，在 AppError 枚举中 `PayloadTooLarge` 之后新增：

```rust
    #[error("加密错误: {0}")]
    Crypto(String),
```

在 `into_response` 的 match 分支，`PayloadTooLarge` 之后新增：

```rust
            AppError::Crypto(msg) => {
                tracing::error!(error = %msg, "加密错误");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "服务器内部错误".to_string(),
                )
            }
```

### Step 5: models.rs — 加密存储 / 解密读取

Modify `crates/server/src/db/models.rs`：

在 `create_database` 函数中，存储前加密 token。在 `sqlx::query` 调用前新增：

```rust
    // 如有加密器，加密 token 后存储
    let stored_token = turso_token.to_string();
```

然后把所有 `.bind(turso_token)` 改为 `.bind(&stored_token)`。不——因为 `create_database` 的签名接收 `turso_token: &str`。更好的做法是在持久化之前加密。

实际上需要把 encryptor 传进来。但由于 `create_database` 是纯数据库函数，不持有 state。最简单的方案：在 API 层（`databases.rs` 的 `create_database` handler）加密后传入。

Modify `crates/server/src/api/databases.rs`，在 `create_database` handler 中，`let (turso_db_name, turso_url, turso_token) = ...` 之后：

```rust
    // 如有加密器，加密 token 后存储
    let stored_token = if let Some(ref encryptor) = state.encryptor {
        encryptor.encrypt(&turso_token)
    } else {
        turso_token.clone()
    };
```

然后把 `db::models::create_database(... &turso_token ...)` 改为 `&stored_token`。

### Step 6: process/mod.rs — 解密注入

Modify `crates/server/src/process/mod.rs`，`start()` 函数中环境变量注入部分。

当前代码从 `db_record.turso_token` 直接读取 token。需要解密：

```rust
for db_record in &databases {
    let token_value = if let Some(ref encryptor) = state.encryptor {
        encryptor.decrypt(&db_record.turso_token)
            .map_err(|e| AppError::Internal(format!("token 解密失败: {e}")))?
    } else {
        db_record.turso_token.clone()
    };
    // ... 插入环境变量
}
```

但这里有个问题：`start()` 的签名是 `&self`，而 AppState 不在这个函数的参数中。需要把 `encryptor` 传入 `ProcessManager`。

最简单方案：在 `ProcessManager` 中存储 `encryptor: Option<Encryptor>`。修改：

Modify `crates/server/src/process/mod.rs`：

```rust
use crate::crypto::Encryptor;

pub struct ProcessManager {
    deno_path: String,
    port_min: u16,
    port_max: u16,
    pub(crate) processes: Arc<RwLock<HashMap<String, ManagedProcess>>>,
    encryptor: Option<Encryptor>,
}

impl ProcessManager {
    pub fn new(deno_path: String, port_min: u16, port_max: u16, encryptor: Option<Encryptor>) -> Self {
        Self {
            deno_path,
            port_min,
            port_max,
            processes: Arc::new(RwLock::new(HashMap::new())),
            encryptor,
        }
    }
```

然后在 `start()` 中 env 注入处：

```rust
let token_value = if let Some(ref encryptor) = self.encryptor {
    encryptor.decrypt(&db_record.turso_token)
        .map_err(|e| AppError::Internal(format!("token 解密失败: {e}")))?  
} else {
    db_record.turso_token.clone()
};
extra_env.insert(format!("TURSO_DB_{}_TOKEN", prefix), token_value);
```

### Step 7: 更新 ProcessManager 构造调用

Modify `crates/server/src/main.rs`，`ProcessManager::new` 调用：

```rust
let process_manager = ProcessManager::new(
    cli.deno_path.clone(),
    cli.deno_port_min,
    cli.deno_port_max,
    encryptor.clone(),
);
```

同时传递 `encryptor` 到 AppState：

```rust
let state = Arc::new(agent_sites::AppState {
    db: pool.clone(),
    storage_dir: storage_dir.clone(),
    process_manager,
    turso_client,
    max_upload_size_mb: cli.max_upload_size_mb,
    encryptor,
});
```

### Step 8: 更新所有测试中的 ProcessManager 构造

搜索所有 `ProcessManager::new(` 调用，添加第四个参数 `None`（测试中不使用加密）。

涉及文件：
- `crates/server/src/process/mod_test.rs`
- `crates/server/src/api/sites_test.rs`
- `crates/server/src/api/databases_test.rs`
- `crates/server/src/api/bindings_test.rs`
- `crates/server/src/api/deploy_test.rs`
- `crates/server/src/proxy/mod_test.rs`
- `crates/server/src/routing/mod_test.rs`

### Step 9: 运行全量测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: PASS（所有测试通过）

### Step 10: 提交

```bash
git add crates/server/src/
git commit -m "feat: Turso token AES-256-GCM 加密存储 + 启动时解密注入

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 3: 优雅降级 — 空 token 时给出明确错误

**Files:**
- Modify: `crates/server/src/api/databases.rs`

### Step 1: 添加空 token 检测

Modify `crates/server/src/api/databases.rs`，在 `create_database` handler 函数的 Turso API 调用之前新增：

```rust
    // 检测 Turso token 是否配置
    if state.turso_client.api_token.is_empty() {
        return Err(AppError::Internal(
            "Turso API Token 未配置，请设置 TURSO_API_TOKEN 环境变量".to_string(),
        ));
    }
```

### Step 2: 运行测试确认不影响

Run: `cargo test -p agent-sites -- databases_test`
Expected: PASS

### Step 3: 提交

```bash
git add crates/server/src/api/databases.rs
git commit -m "fix: Turso token 为空时返回明确错误信息

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 4: Docker 配置更新

**Files:**
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`

### Step 1: 更新 Dockerfile

Read `Dockerfile` first. 在 ENV 声明区域新增：

```dockerfile
ENV TURSO_API_URL=https://api.turso.tech
ENV TURSO_API_TOKEN=
ENV TURSO_ORG=default
ENV MAX_UPLOAD_SIZE_MB=50
ENV DATA_ENCRYPTION_KEY=
```

### Step 2: 更新 docker-compose.yml

Read `docker-compose.yml` first. 在 environment 区域新增：

```yaml
      - TURSO_API_URL=https://api.turso.tech
      - TURSO_API_TOKEN=
      - TURSO_ORG=default
      - MAX_UPLOAD_SIZE_MB=50
      - DATA_ENCRYPTION_KEY=
```

### Step 3: 提交

```bash
git add Dockerfile docker-compose.yml
git commit -m "chore: Docker 配置新增 Turso + 加密相关环境变量

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 5: .gitignore 修复

**Files:**
- Modify: `.gitignore`

### Step 1: 移除 .claude/skills/ 排除

Read `.gitignore` first. 找到 `.claude/` 或 `.claude/skills/` 相关行，修改为仅排除特定文件而非整个目录，或添加例外：

如果当前是 `.claude/`，改为：

```
.claude/*
!.claude/skills/
```

如果当前是 `.claude/skills/`，移除该行。

### Step 2: 提交

```bash
git add .gitignore
git commit -m "chore: .gitignore 允许 .claude/skills/ 目录提交

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 6: README 更新

**Files:**
- Modify: `README.md`

### Step 1: 更新 README

Read `README.md` first. 做以下修改：

1. **路线图**：阶段 3 ⏳ → ✅，阶段 4 ⏳ → ✅，内容合并为：

```markdown
### 阶段 3+4 ✅ CLI/Skills + Turso 数据库

- tar.gz 上传部署 API（自动解压/版本化/激活）
- Turso/libSQL 数据库管理 API（创建/列出/获取/删除）
- 站点↔数据库绑定管理（多对多）
- Deno 进程启动时环境变量注入（TURSO_DB_*_URL/TOKEN）
- agent-sites-deploy Skill 文件（Agent 交互指南）
- AES-256-GCM token 加密存储
```

2. **项目结构**：新增 `turso/`、`crypto/` 模块，更新 api/ 文件列表

3. **环境变量表**：新增：

```
| `TURSO_API_URL` | Turso API 地址 | `https://api.turso.tech` |
| `TURSO_API_TOKEN` | Turso API Token | （必填） |
| `TURSO_ORG` | Turso 组织名 | `default` |
| `MAX_UPLOAD_SIZE_MB` | 上传文件大小上限 | `50` |
| `DATA_ENCRYPTION_KEY` | Token 加密密钥（64 hex） | （可选） |
```

### Step 2: 提交

```bash
git add README.md
git commit -m "docs: README 更新阶段 3+4 状态 + 环境变量表

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## 总结

| Task | 内容 | 互依赖性 |
|------|------|----------|
| 1 | Crypto 模块（AES-256-GCM） | 无 |
| 2 | Token 加密存储 + 解密注入 | 依赖 Task 1 |
| 3 | 空 token 优雅降级 | 无 |
| 4 | Docker 配置更新 | 无 |
| 5 | .gitignore 修复 | 无 |
| 6 | README 更新 | 无 |

Task 3-6 可并行执行。Task 1→2 串行。
