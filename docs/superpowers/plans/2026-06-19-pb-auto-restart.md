# PocketBase 进程崩溃自愈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 PocketBase 子进程退出/僵死时的被动检测 + 自动重启 + 单次重试，把 HTTP 500 改为透明恢复（最坏 503 PB_UNAVAILABLE）。

**Architecture:** 在 `PocketBaseProcessManager` 加 `is_alive` / `restart_if_needed` 两个方法 + `RestartCounter` 滑动窗口限流；`lib.rs::serve_api_proxy` 两道关：转发前 try_wait 检测、forward 失败回退到 restart + 重试；自愈失败时同步 `app.status=Error` + apps.json。错误返回通过新增 `AppError::ServiceUnavailable`（503）。

**Tech Stack:** Rust 2021 + axum 0.8 + tokio + reqwest + parking_lot + std::process::Command（调 lsof/ps 做端口冲突检测）

**Spec:** `docs/superpowers/specs/2026-06-19-pb-auto-restart-design.md`

---

## File Structure

| 文件 | 改动 |
|---|---|
| `crates/server/src/error.rs` | 加 `ServiceUnavailable(String)` 变体 + IntoResponse 分支（503 SERVICE_UNAVAILABLE + code="PB_UNAVAILABLE"） |
| `crates/server/src/process/mod.rs` | 加 `RestartOutcome` 枚举、`RestartCounter` 结构、`PocketBaseProcessManager::is_alive`/`restart_if_needed` 方法、`PocketBaseProcessManager.restart_counter` 字段 |
| `crates/server/src/process/mod_test.rs` | 6 个新单元测试 |
| `crates/server/src/proxy/mod.rs` | 加 `is_recoverable_error` 公开函数，分类 connect refused / timeout |
| `crates/server/src/lib.rs` | `serve_api_proxy` 改造：status=Error 短路 + is_alive + restart_if_needed + 重试 + status 同步；新增私有 `handle_proxy_with_recovery` 辅助函数 |
| `crates/server/src/lib_test.rs` | 4 个新集成测试 |
| `docs/architecture.md` | §9.3「进程僵死检测 + 自动重启」从「后续 plan」改标「已实现（详见 spec）」 |

---

## Task 1: 扩展 AppError::ServiceUnavailable

**Files:**
- Modify: `crates/server/src/error.rs:5-27`（enum 定义）
- Modify: `crates/server/src/error.rs:47-76`（IntoResponse impl）
- Test: `crates/server/src/error.rs`（新增 `#[cfg(test)]` 模块，无 _test.rs 是因为该文件目前无测试，沿用现状；< 30 行可内联）

- [ ] **Step 1: 在 `crates/server/src/error.rs` 末尾加测试模块（写失败测试）**

在文件末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    #[tokio::test]
    async fn test_service_unavailable_返回503和pb_unavailable() {
        let err = AppError::ServiceUnavailable(
            "PocketBase 后端多次重启失败，已停止自愈".to_string(),
        );
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p agent-sites --lib error::tests 2>&1 | tail -20`
Expected: 编译错误 `No variant or associated item named ServiceUnavailable found`

- [ ] **Step 3: 在 enum AppError 加 ServiceUnavailable 变体**

修改 `crates/server/src/error.rs`，在 `Internal(String)` 变体后追加：

```rust
    #[error("服务暂不可用: {0}")]
    ServiceUnavailable(String),
```

- [ ] **Step 4: 在 IntoResponse impl 加 ServiceUnavailable 分支**

修改 `crates/server/src/error.rs:49-68`，在 `AppError::Internal(m) => {...}` 分支后追加：

```rust
            AppError::ServiceUnavailable(m) => {
                tracing::warn!(reason = %m, "PocketBase 后端不可用");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "PB_UNAVAILABLE",
                    m.clone(),
                )
            }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test -p agent-sites --lib error::tests 2>&1 | tail -10`
Expected: `test result: ok. 1 passed`

- [ ] **Step 6: Commit**

```bash
git add crates/server/src/error.rs
git commit -m "$(cat <<'EOF'
feat(error): 加 AppError::ServiceUnavailable (503 PB_UNAVAILABLE)

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 2: 实现 RestartCounter（滑动窗口限流）

**Files:**
- Modify: `crates/server/src/process/mod.rs`（在文件顶部加 `RestartCounter` 定义）
- Test: `crates/server/src/process/mod_test.rs`（追加测试）

- [ ] **Step 1: 在 `process/mod_test.rs` 追加 RestartCounter 测试**

在文件末尾追加：

```rust
use crate::process::RestartCounter;
use std::time::{Duration, Instant};

#[tokio::test]
async fn test_restart_counter_首次记录_返回true() {
    let counter = RestartCounter::new(Duration::from_secs(300), 3);
    assert!(counter.record_and_check("app-a"));
}

#[tokio::test]
async fn test_restart_counter_短窗口内第三次_返回true_第四次返回false() {
    let counter = RestartCounter::new(Duration::from_secs(300), 3);
    assert!(counter.record_and_check("app-a"));
    assert!(counter.record_and_check("app-a"));
    assert!(counter.record_and_check("app-a"));
    // 第四次：超限
    assert!(!counter.record_and_check("app-a"));
}

#[tokio::test]
async fn test_restart_counter_不同app_id独立计数() {
    let counter = RestartCounter::new(Duration::from_secs(300), 3);
    assert!(counter.record_and_check("app-a"));
    assert!(counter.record_and_check("app-a"));
    assert!(counter.record_and_check("app-a"));
    // app-b 独立
    assert!(counter.record_and_check("app-b"));
}

#[tokio::test]
async fn test_restart_counter_窗口过期后_旧记录清理() {
    let counter = RestartCounter::new(Duration::from_millis(50), 2);
    assert!(counter.record_and_check("app-a"));
    assert!(counter.record_and_check("app-a"));
    // 等待窗口过期
    tokio::time::sleep(Duration::from_millis(80)).await;
    // 现在应该允许（旧记录被清理）
    assert!(counter.record_and_check("app-a"));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p agent-sites --lib process::mod_test::test_restart_counter 2>&1 | tail -10`
Expected: 编译错误 `cannot find type RestartCounter in this scope`

- [ ] **Step 3: 在 `process/mod.rs` 加 RestartCounter 定义**

修改 `crates/server/src/process/mod.rs`，在 `use std::time::Duration;` 后追加：

```rust
/// PocketBase 自愈限流计数器（按 app_id 滑动窗口）。
///
/// 每次 `record_and_check` 推入当前时间戳，清理已过期记录后判断是否超限。
/// 不与 `processes` HashMap 锁耦合（单独 RwLock），避免嵌套。
pub struct RestartCounter {
    window: Duration,
    max_attempts: usize,
    inner: parking_lot::RwLock<std::collections::HashMap<String, Vec<std::time::Instant>>>,
}

impl RestartCounter {
    pub fn new(window: Duration, max_attempts: usize) -> Self {
        Self {
            window,
            max_attempts,
            inner: parking_lot::RwLock::new(std::collections::HashMap::new()),
        }
    }

    /// 记录一次重启尝试 + 返回是否仍允许（true=未超限）。
    /// 在同一个 write guard 内完成清理 + 推入 + 判断。
    pub fn record_and_check(&self, app_id: &str) -> bool {
        let now = std::time::Instant::now();
        let mut guard = self.inner.write();
        let entry = guard.entry(app_id.to_string()).or_default();
        entry.retain(|t| now.duration_since(*t) < self.window);
        if entry.len() >= self.max_attempts {
            return false;
        }
        entry.push(now);
        true
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p agent-sites --lib process::mod_test::test_restart_counter 2>&1 | tail -15`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Commit**

```bash
git add crates/server/src/process/mod.rs crates/server/src/process/mod_test.rs
git commit -m "$(cat <<'EOF'
feat(process): RestartCounter 滑动窗口限流（5min×3）

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: 实现 PocketBaseProcessManager::is_alive

**Files:**
- Modify: `crates/server/src/process/mod.rs`（加 `is_alive` 方法）
- Modify: `crates/server/src/process/mod_test.rs`（追加测试）

- [ ] **Step 1: 在 `process/mod_test.rs` 追加 is_alive 测试**

在文件末尾追加（3 个测试：无记录、存活、被外部 kill）：

```rust
#[tokio::test]
async fn test_is_alive_无记录_返回false() {
    // PM 中没记录该 app_id 时，is_alive 应返回 false（视为不存活）
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    assert!(!pm.is_alive("app-not-registered"));
}

#[tokio::test]
async fn test_is_alive_进程存在_返回true() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    let allocator = crate::process::port_allocator::PortAllocator::new(19600, 19700);
    let data_dir = tmp.path().join("app-alive");
    tokio::fs::create_dir_all(&data_dir).await.unwrap();
    pm.start("app-alive", &data_dir, "/app-alive/", &allocator).await.unwrap();

    assert!(pm.is_alive("app-alive"), "刚启动的 pb 应存活");

    pm.stop("app-alive").await.unwrap();
}

#[tokio::test]
async fn test_is_alive_进程被外部kill_返回false() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    let allocator = crate::process::port_allocator::PortAllocator::new(19800, 19900);
    let data_dir = tmp.path().join("app-killed");
    tokio::fs::create_dir_all(&data_dir).await.unwrap();
    pm.start("app-killed", &data_dir, "/app-killed/", &allocator).await.unwrap();
    let port = pm.get_port("app-killed").unwrap();

    // 模拟外部 kill：用 lsof 找 pid 然后 SIGKILL（不通过 PM.stop）
    let output = std::process::Command::new("lsof")
        .arg("-ti")
        .arg(format!(":{}", port))
        .output()
        .expect("lsof 应可用");
    let pids: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    for pid in pids {
        let _ = std::process::Command::new("kill").arg("-9").arg(&pid).output();
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    assert!(!pm.is_alive("app-killed"), "被外部 kill 的 pb 应判为不存活");

    // 清理 PM 内部记录（避免 child drop 时重复 kill 报错）
    pm.stop("app-killed").await.ok();
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p agent-sites --lib process::mod_test::test_is_alive 2>&1 | tail -10`
Expected: 编译错误 `no method named is_alive found for PocketBaseProcessManager`

- [ ] **Step 3: 在 `PocketBaseProcessManager` impl 块加 is_alive 方法**

修改 `crates/server/src/process/mod.rs`，在 `pub fn get_port(...)` 方法后追加：

```rust
    /// 检测 app_id 对应的 PocketBase 进程是否存活。
    ///
    /// - 未在 PM 中注册 → false（视为不存活）
    /// - 注册了但 child.try_wait() 返回 Some → false（进程已退出）
    /// - try_wait() 返回 None → true（仍存活）
    ///
    /// 零开销：try_wait 是非阻塞 syscall，不持 await。
    pub fn is_alive(&self, app_id: &str) -> bool {
        let procs = self.processes.read();
        match procs.get(app_id) {
            None => false,
            Some(p) => p.child.try_wait().ok().flatten().is_none(),
        }
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p agent-sites --lib process::mod_test::test_is_alive 2>&1 | tail -15`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add crates/server/src/process/mod.rs crates/server/src/process/mod_test.rs
git commit -m "$(cat <<'EOF'
feat(process): PM::is_alive 检测子进程存活（try_wait 零开销）

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: 实现 RestartOutcome 枚举 + restart_if_needed 基本路径 + StillHealthy 分支

**Files:**
- Modify: `crates/server/src/process/mod.rs`（加 `RestartOutcome`、`restart_if_needed` 方法、`PocketBaseProcessManager.restart_counter` 字段）
- Modify: `crates/server/src/process/mod_test.rs`（追加测试）

- [ ] **Step 1: 在 `process/mod_test.rs` 追加 restart 测试**

```rust
use crate::process::RestartOutcome;

#[tokio::test]
async fn test_restart_if_needed_进程还活着_返回StillHealthy() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    let allocator = crate::process::port_allocator::PortAllocator::new(21000, 21100);
    let data_dir = tmp.path().join("app-healthy");
    tokio::fs::create_dir_all(&data_dir).await.unwrap();
    pm.start("app-healthy", &data_dir, "/app-healthy/", &allocator).await.unwrap();

    // 进程还活着 → restart_if_needed 应返回 StillHealthy，不重启
    let outcome = pm.restart_if_needed("app-healthy", &data_dir, &allocator).await.unwrap();
    assert!(matches!(outcome, RestartOutcome::StillHealthy), "应返回 StillHealthy，实际: {:?}", outcome);

    // 验证没产生新进程（端口仍相同）
    assert!(pm.is_alive("app-healthy"));
    pm.stop("app-healthy").await.unwrap();
}

#[tokio::test]
async fn test_restart_if_needed_进程死了_返回Restarted() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    let allocator = crate::process::port_allocator::PortAllocator::new(21200, 21300);
    let data_dir = tmp.path().join("app-dead");
    tokio::fs::create_dir_all(&data_dir).await.unwrap();
    pm.start("app-dead", &data_dir, "/app-dead/", &allocator).await.unwrap();
    let port = pm.get_port("app-dead").unwrap();

    // 外部 kill pb 进程
    let output = std::process::Command::new("lsof")
        .arg("-ti").arg(format!(":{}", port)).output().unwrap();
    for pid in String::from_utf8_lossy(&output.stdout).lines().filter(|s| !s.is_empty()) {
        let _ = std::process::Command::new("kill").arg("-9").arg(pid).output();
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // restart_if_needed 应重启
    let outcome = pm.restart_if_needed("app-dead", &data_dir, &allocator).await.unwrap();
    assert!(matches!(outcome, RestartOutcome::Restarted), "应返回 Restarted，实际: {:?}", outcome);
    assert!(pm.is_alive("app-dead"), "重启后应存活");

    pm.stop("app-dead").await.unwrap();
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p agent-sites --lib process::mod_test::test_restart_if_needed 2>&1 | tail -10`
Expected: 编译错误 `cannot find type RestartOutcome` / `no method named restart_if_needed`

- [ ] **Step 3: 在 `process/mod.rs` 加 RestartOutcome 枚举**

在 `RestartCounter` 定义后追加：

```rust
/// restart_if_needed 的返回结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartOutcome {
    /// 成功重启了进程，调用方应重试请求
    Restarted,
    /// 二次检查发现进程还活着（race），调用方直接重试请求
    StillHealthy,
    /// 5min×3 次重启上限触发，调用方应返回 503
    RateLimited,
    /// health check 失败或端口冲突无法解决，调用方应返回 503
    GiveUp,
}
```

- [ ] **Step 4: 在 `PocketBaseProcessManager` 加 restart_counter 字段**

修改 `crates/server/src/process/mod.rs:27-30`：

```rust
pub struct PocketBaseProcessManager {
    pub(crate) binary: PathBuf,
    pub(crate) processes: Arc<RwLock<HashMap<String, ManagedProcess>>>,
    // pub 是为测试预填方便（lib_test 直接调 record_and_check）
    pub restart_counter: RestartCounter,
}
```

修改 `new` 构造函数：

```rust
    pub fn new(binary: PathBuf) -> Self {
        Self {
            binary,
            processes: Arc::new(RwLock::new(HashMap::new())),
            restart_counter: RestartCounter::new(
                std::time::Duration::from_secs(300),
                3,
            ),
        }
    }
```

- [ ] **Step 5: 在 `PocketBaseProcessManager` impl 加 restart_if_needed 方法**

在 `is_alive` 方法后追加：

```rust
    /// 检查并按需重启 PocketBase 进程。
    ///
    /// 调用前提：调用方已经判断需要自愈（is_alive=false 或 forward 失败）。
    ///
    /// 流程：
    /// 1. 写锁内：二次确认（try_wait）。还活着 → StillHealthy
    /// 2. 限流检查：5min×3 次超限 → RateLimited
    /// 3. 端口冲突处理（如果端口被占）→ 验证 cmdline 是 pocketbase 才 kill
    /// 4. 用原端口 spawn → 写入 processes map
    /// 5. 锁外 wait_for_health，超时 → GiveUp（回滚 kill + remove）
    /// 6. 返回 Restarted
    pub async fn restart_if_needed(
        &self,
        app_id: &str,
        data_dir: &Path,
        allocator: &PortAllocator,
    ) -> Result<RestartOutcome, AppError> {
        // === 1. 限流检查（不持 processes 锁，独立锁） ===
        if !self.restart_counter.record_and_check(app_id) {
            tracing::warn!(app_id = %app_id, "5min 内重启超限，RateLimited");
            return Ok(RestartOutcome::RateLimited);
        }

        // === 2. 拿原端口 ===
        let port = match self.processes.read().get(app_id) {
            Some(p) => p.port,
            None => {
                // PM 没记录该 app_id：分配新端口
                let used: std::collections::HashSet<u16> =
                    self.processes.read().values().map(|p| p.port).collect();
                let new_port = allocator.allocate(&used);
                if new_port == 0 {
                    return Err(AppError::Internal("端口范围耗尽".to_string()));
                }
                new_port
            }
        };

        // === 3. 写锁内：二次确认 + 清理旧记录 + spawn ===
        {
            let mut procs = self.processes.write();
            if let Some(existing) = procs.get(app_id) {
                // 二次确认
                if existing.child.try_wait().ok().flatten().is_none() {
                    // 还活着（race）→ 不重启
                    return Ok(RestartOutcome::StillHealthy);
                }
                // 已退出 → 尝试 wait 一下回收 zombie，然后从 map 移除
                let mut to_remove = procs.remove(app_id).unwrap();
                let _ = to_remove.child.wait().await;
            }
            // 端口冲突处理（端口被外部进程占用）
            if Self::is_port_in_use(port).await {
                match Self::find_and_kill_conflicting_pb(port, app_id).await {
                    Ok(true) => { /* 已 kill，继续 spawn */ }
                    Ok(false) => {
                        // 不是 pocketbase → 不误杀
                        tracing::error!(
                            app_id = %app_id,
                            port = port,
                            "端口被非 pocketbase 进程占用，放弃重启避免误杀"
                        );
                        return Ok(RestartOutcome::GiveUp);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, port = port, "端口冲突检测失败，继续尝试 spawn");
                    }
                }
            }
            // spawn
            let args = build_serve_args(data_dir, port, &format!("/{}/", app_id));
            tracing::info!(app_id = %app_id, port = port, args = ?args, "重启 PocketBase 进程");
            let mut command = tokio::process::Command::new(&self.binary);
            command.args(&args);
            command.stdin(std::process::Stdio::null());
            command.stdout(std::process::Stdio::null());
            command.stderr(std::process::Stdio::null());
            command.kill_on_drop(true);
            let child = command
                .spawn()
                .map_err(|e| AppError::Internal(format!("PocketBase 重启 spawn 失败: {e}")))?;
            procs.insert(app_id.to_string(), ManagedProcess { child, port });
        } // 写锁释放

        // === 4. 锁外 health check ===
        let healthy = wait_for_health(port, 10).await;
        if !healthy {
            tracing::error!(app_id = %app_id, port = port, "重启后健康检查失败，GiveUp");
            self.stop(app_id).await.ok();
            return Ok(RestartOutcome::GiveUp);
        }
        tracing::info!(app_id = %app_id, port = port, "PocketBase 重启成功");
        Ok(RestartOutcome::Restarted)
    }

    /// 检测端口是否被占用（尝试 bind）
    async fn is_port_in_use(port: u16) -> bool {
        tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_err()
    }

    /// 检测端口占用者是否为当前 app_id 对应的 pocketbase 进程。
    /// 是 → kill + 返回 true；不是 → 返回 false（不误杀）。
    async fn find_and_kill_conflicting_pb(port: u16, app_id: &str) -> std::io::Result<bool> {
        let output = std::process::Command::new("lsof")
            .arg("-ti")
            .arg(format!(":{}", port))
            .output()?;
        let pids: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        if pids.is_empty() {
            return Ok(false); // 无占用者
        }
        for pid in pids {
            // 读 cmdline：优先 /proc（Linux），失败用 ps（macOS/Linux 通用）
            let cmdline_result = std::fs::read(format!("/proc/{}/cmdline", pid))
                .map(|b| String::from_utf8_lossy(&b).replace('\0', " ").trim().to_string())
                .or_else(|_| {
                    std::process::Command::new("ps")
                        .args(["-p", &pid, "-o", "command="])
                        .output()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                });
            let cmdline = match cmdline_result {
                Ok(c) if !c.is_empty() => c,
                _ => {
                    tracing::warn!(port = port, pid = %pid, "无法读取进程 cmdline，跳过端口冲突处理");
                    continue;
                }
            };
            let is_pb = cmdline.contains("pocketbase") && cmdline.contains("serve");
            // 匹配 data_dir（如 `--dir=/path/to/app-xxx` 或 `--dir=data/app-xxx`）
            let matches_app = cmdline.contains(app_id);
            if is_pb && matches_app {
                let _ = std::process::Command::new("kill")
                    .arg("-9")
                    .arg(&pid)
                    .output();
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                return Ok(true);
            }
            // 不论是其他 app 的 pocketbase 还是无关进程，都不误杀
            tracing::warn!(
                port = port,
                pid = %pid,
                expected_app = %app_id,
                cmdline = %cmdline,
                is_pocketbase = is_pb,
                "端口被非当前 app 进程占用，不误杀"
            );
            return Ok(false);
        }
        Ok(false)
    }
```

**注意：** macOS 无 `/proc`，会自动 fallback 到 `ps -p {pid} -o command=`。两个平台都能跑。

- [ ] **Step 6: 运行测试确认通过**

Run: `cargo test -p agent-sites --lib process::mod_test::test_restart_if_needed 2>&1 | tail -20`
Expected: `test result: ok. 2 passed`

- [ ] **Step 7: Commit**

```bash
git add crates/server/src/process/mod.rs crates/server/src/process/mod_test.rs
git commit -m "$(cat <<'EOF'
feat(process): restart_if_needed 基本路径（StillHealthy/Restarted）

含 RestartOutcome 枚举、PM.restart_counter 字段、端口冲突检测（lsof
+ /proc 或 ps cmdline 验证避免误杀）、health check 失败 GiveUp。
RateLimited 分支已包含（限流前置检查）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: restart_if_needed RateLimited 分支测试（实现已在 Task 4 含）

**Files:**
- Modify: `crates/server/src/process/mod_test.rs`（追加 RateLimited 测试）

实现已在 Task 4 完成，本任务只补测试覆盖。

- [ ] **Step 1: 在 `process/mod_test.rs` 追加 RateLimited 测试**

```rust
#[tokio::test]
async fn test_restart_if_needed_短窗口内超过3次_RateLimited() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pm = PocketBaseProcessManager::new(pb_binary_path());
    let allocator = crate::process::port_allocator::PortAllocator::new(21400, 21500);
    let data_dir = tmp.path().join("app-ratelimit");
    tokio::fs::create_dir_all(&data_dir).await.unwrap();
    pm.start("app-ratelimit", &data_dir, "/app-ratelimit/", &allocator).await.unwrap();
    let port = pm.get_port("app-ratelimit").unwrap();

    // 主动触发 3 次 kill+restart（占满计数）
    for i in 0..3 {
        let output = std::process::Command::new("lsof")
            .arg("-ti").arg(format!(":{}", port)).output().unwrap();
        for pid in String::from_utf8_lossy(&output.stdout).lines().filter(|s| !s.is_empty()) {
            let _ = std::process::Command::new("kill").arg("-9").arg(pid).output();
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if i < 2 {
            // 前 2 次重启成功
            let outcome = pm.restart_if_needed("app-ratelimit", &data_dir, &allocator).await.unwrap();
            assert_eq!(outcome, RestartOutcome::Restarted, "第 {} 次应 Restarted", i + 1);
        }
    }
    // 第 3 次（第 4 次尝试） → RateLimited（计数已 = 3）
    let outcome = pm.restart_if_needed("app-ratelimit", &data_dir, &allocator).await.unwrap();
    assert_eq!(outcome, RestartOutcome::RateLimited, "第 4 次应 RateLimited");

    pm.stop("app-ratelimit").await.ok();
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cargo test -p agent-sites --lib process::mod_test::test_restart_if_needed_短窗口内超过3次_RateLimited 2>&1 | tail -10`
Expected: `test result: ok. 1 passed`

- [ ] **Step 3: Commit**

```bash
git add crates/server/src/process/mod_test.rs
git commit -m "$(cat <<'EOF'
test(process): restart_if_needed RateLimited 分支覆盖

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: 接线 serve_api_proxy（status=Error 短路 + is_alive + restart + 重试 + status 同步）

**Files:**
- Modify: `crates/server/src/lib.rs:52-79`（`serve_api_proxy` 改造）
- Modify: `crates/server/src/lib_test.rs`（追加 3 个集成测试）

- [ ] **Step 1: 在 `lib_test.rs` 追加集成测试**

在文件末尾追加：

```rust
// ============ pb 进程崩溃自愈 ============

#[tokio::test]
async fn test_代理_pb进程被外部kill后_自动重启_请求成功() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    let app = create_app(state.clone());

    // 创建 App
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/apps")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name":"auto-heal"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let app_id = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let port = state.process_manager.get_port(&app_id).unwrap();

    // 外部 kill pb
    let output = std::process::Command::new("lsof")
        .arg("-ti")
        .arg(format!(":{}", port))
        .output()
        .unwrap();
    for pid in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|s| !s.is_empty())
    {
        let _ = std::process::Command::new("kill").arg("-9").arg(pid).output();
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // 通过网关代理 → 应自动重启 + 返回 200
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/{}/api/health", app_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "应自动重启 + 200，实际: {}",
        resp.status()
    );

    // 清理
    let _ = app
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/api/apps/{}", app_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
}

#[tokio::test]
async fn test_代理_statusError的app_直接返回503_不进自愈() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    let app = create_app(state.clone());

    // 创建 App
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/apps")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name":"err-app"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let app_id = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // 手动把 status 改 Error
    let mut app_record = state.store.get(&app_id).await.unwrap();
    app_record.status = crate::app::model::AppStatus::Error;
    state.store.update(app_record).await;
    state.store.flush().await.unwrap();

    // 代理应直接 503
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/{}/api/health", app_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    // 清理
    let _ = app
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/api/apps/{}", app_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
}

#[tokio::test]
async fn test_代理_RateLimited后_status变Error_返回503() {
    if !pb_binary_available() {
        eprintln!("跳过：pocketbase 不可用");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let state = make_state(&tmp).await;
    let app = create_app(state.clone());

    // 创建 App
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/apps")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name":"rate-app"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let app_id = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let port = state.process_manager.get_port(&app_id).unwrap();

    // 预填 RestartCounter 到上限（直接调 3 次 record_and_check）
    for _ in 0..3 {
        state.process_manager.restart_counter.record_and_check(&app_id);
    }

    // 外部 kill pb
    let output = std::process::Command::new("lsof")
        .arg("-ti")
        .arg(format!(":{}", port))
        .output()
        .unwrap();
    for pid in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|s| !s.is_empty())
    {
        let _ = std::process::Command::new("kill").arg("-9").arg(pid).output();
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // 代理 → 应触发 RateLimited → status=Error → 503
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/{}/api/health", app_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    // status 应同步为 Error
    let updated = state.store.get(&app_id).await.unwrap();
    assert_eq!(updated.status, crate::app::model::AppStatus::Error);

    // 清理
    let _ = app
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/api/apps/{}", app_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p agent-sites --lib lib_test::test_代理 2>&1 | tail -20`
Expected: 编译通过但断言失败（serve_api_proxy 还没改造，pb 被 kill 时直接 forward 失败返回 500 而非 200/503）

- [ ] **Step 3: `restart_counter` 字段可见性已为 pub（Task 4 Step 4 已设置），跳过本步**

- [ ] **Step 4: 在 `lib.rs` 改造 serve_api_proxy + 加 handle_proxy_with_recovery**

修改 `crates/server/src/lib.rs:52-79`，整段替换：

```rust
async fn serve_api_proxy(
    State(state): State<Arc<AppState>>,
    Path((app_id, path)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, error::AppError> {
    // Issue #11：显式校验 app_id 前缀，防止非 app-* 被代理
    if !validate_app_id(&app_id) {
        return Err(error::AppError::NotFound(format!("App 不存在: {}", app_id)));
    }
    let app = state
        .store
        .get(&app_id)
        .await
        .ok_or_else(|| error::AppError::NotFound(format!("App 不存在: {}", app_id)))?;

    // status=Error 直接短路：pb 已知不可达，不再尝试
    if app.status == app::model::AppStatus::Error {
        return Err(error::AppError::ServiceUnavailable(format!(
            "App {} 后端处于 Error 状态，需重新创建",
            app_id
        )));
    }

    let upstream_path = format!("/api/{}", path);

    // 第一关：进程存活检测
    if !state.process_manager.is_alive(&app_id) {
        return handle_proxy_with_recovery(
            &state, &app_id, &app, &upstream_path, method, headers, body,
        )
        .await;
    }

    // 第二关：forward 失败回退
    match forward(
        app.port,
        &upstream_path,
        method.clone(),
        headers.clone(),
        body.clone(),
        proxy::DEFAULT_MAX_BODY_BYTES,
        Some(&app_id),
    )
    .await
    {
        Ok(resp) => Ok(resp),
        Err(e) if proxy::is_recoverable_error(&e) => {
            tracing::warn!(app_id = %app_id, error = %e, "forward 失败，触发自愈");
            handle_proxy_with_recovery(
                &state, &app_id, &app, &upstream_path, method, headers, body,
            )
            .await
        }
        Err(e) => Err(e),
    }
}

/// 自愈路径：调 restart_if_needed，成功则重试 forward，失败则标 status=Error + 返回 503
async fn handle_proxy_with_recovery(
    state: &AppState,
    app_id: &str,
    app: &app::model::App,
    upstream_path: &str,
    method: Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, error::AppError> {
    let data_dir = state.data_dir.join(app_id);
    let allocator = crate::process::port_allocator::PortAllocator::new(state.port_min, state.port_max);

    let outcome = state
        .process_manager
        .restart_if_needed(app_id, &data_dir, &allocator)
        .await?;

    match outcome {
        crate::process::RestartOutcome::Restarted
        | crate::process::RestartOutcome::StillHealthy => {
            // 重试 forward 一次
            forward(
                app.port,
                upstream_path,
                method,
                headers,
                body,
                proxy::DEFAULT_MAX_BODY_BYTES,
                Some(app_id),
            )
            .await
        }
        crate::process::RestartOutcome::RateLimited
        | crate::process::RestartOutcome::GiveUp => {
            // 同步 status=Error + flush
            let mut updated = app.clone();
            updated.status = app::model::AppStatus::Error;
            updated.updated_at = chrono::Utc::now().to_rfc3339();
            state.store.update(updated).await;
            if let Err(e) = state.store.flush().await {
                tracing::error!(error = %e, "flush apps.json 失败（status=Error 未持久化）");
            }
            Err(error::AppError::ServiceUnavailable(format!(
                "App {} 后端多次重启失败，已停止自愈",
                app_id
            )))
        }
    }
}
```

- [ ] **Step 5: 在 `proxy/mod.rs` 加 is_recoverable_error**

修改 `crates/server/src/proxy/mod.rs`，在 `pub const DEFAULT_MAX_BODY_BYTES` 后追加：

```rust
/// 判断 forward 错误是否值得自愈（connect refused / timeout 类）。
///
/// 这些错误暗示 PocketBase 后端可能崩了或僵死，应该尝试重启。
pub fn is_recoverable_error(e: &crate::error::AppError) -> bool {
    let msg = match e {
        crate::error::AppError::Internal(m) => m,
        _ => return false,
    };
    let lower = msg.to_lowercase();
    lower.contains("connection refused")
        || lower.contains("connect error")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("broken pipe")
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cargo test -p agent-sites --lib lib_test::test_代理 2>&1 | tail -30`
Expected: `test result: ok. 3 passed`

如果失败，常见原因：
- `record_and_check_for_test` 还没加 → 检查 Step 3
- `restart_counter` 字段不可见 → 检查 Step 3 的 `pub`
- forward 用 `app.port` 而非新分配端口 → 因为 restart_if_needed 优先用原端口，所以应该一致

- [ ] **Step 7: clippy + fmt**

Run: `cargo clippy -p agent-sites -- -D warnings 2>&1 | tail -20`
Expected: 0 warnings

Run: `cargo fmt`
Expected: 无输出

- [ ] **Step 8: Commit**

```bash
git add crates/server/src/lib.rs crates/server/src/lib_test.rs crates/server/src/proxy/mod.rs crates/server/src/process/mod.rs
git commit -m "$(cat <<'EOF'
feat(routing): serve_api_proxy pb 自愈接线

两道关：转发前 is_alive 检测、forward 失败回退到 restart_if_needed。
RateLimited/GiveUp → status=Error 同步 + flush + 503。status=Error
短路直接 503。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 7: 完整测试套件 + 手动验证脚本

**Files:**
- Test only：跑完整测试 + 手动验证

- [ ] **Step 1: 跑全量测试**

Run: `cargo test -p agent-sites 2>&1 | tail -10`
Expected: `test result: ok. 80+ passed; 0 failed`（之前 70 + 新增 ~10）

- [ ] **Step 2: clippy/fmt 终检**

Run: `cargo clippy --workspace -- -D warnings 2>&1 | tail -5 && cargo fmt --check && echo "OK"`
Expected: 0 warnings + fmt OK

- [ ] **Step 3: 手动端到端验证**

在 plan 文档同目录写一个手动验证脚本（无需 commit，仅供执行）：

```bash
# 1. 清理 + 启动
pkill -9 -f 'pocketbase serve' 2>/dev/null
pkill -9 -f 'target/debug/agent-sites' 2>/dev/null
rm -rf data public/app-*

cargo run &
sleep 3
scripts/install-demo.sh

# 2. 拿 app_id（从 /api/apps）
APP_ID=$(curl -sf localhost:3000/api/apps | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print([a['id'] for a in d if a['name']=='demo'][0])")
PORT=$(curl -sf localhost:3000/api/apps | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print([a['port'] for a in d if a['name']=='demo'][0])")
echo "APP_ID=$APP_ID PORT=$PORT"

# 3. 验证可用
curl -sf "localhost:3000/$APP_ID/api/collections/posts/records?sort=-created" | python3 -m json.tool | head -10

# 4. kill pb（模拟崩溃）
pkill -9 -f "pocketbase serve --dir=data/$APP_ID"
sleep 1

# 5. 再次请求，应自动重启 + 200
curl -sv "localhost:3000/$APP_ID/api/collections/posts/records?sort=-created" 2>&1 | grep -E 'HTTP/|<' | head -5
# 期望：< HTTP/1.1 200 OK

# 6. 连续 kill 3 次，第 4 次应 503
for i in 1 2 3; do
    pkill -9 -f "pocketbase serve --dir=data/$APP_ID"
    sleep 1
    curl -s -o /dev/null -w "attempt %{$i}: %{http_code}\n" "localhost:3000/$APP_ID/api/collections/posts/records"
done
# 第 4 次
curl -s -o /dev/null -w "attempt 4: %{http_code}\n" "localhost:3000/$APP_ID/api/collections/posts/records"
# 期望：attempt 4: 503

# 7. 验证 status=Error 持久化
curl -sf localhost:3000/api/apps/$APP_ID | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('status:', d['status'])"
# 期望：status: error
```

- [ ] **Step 4: 如果手动验证某步失败，回到对应 Task 修复**

如 attempt 4 不是 503，说明 RestartCounter 没正常工作（检查 Task 4/5）。
如 status 不是 error，说明同步逻辑有问题（检查 Task 6 Step 4）。

---

## Task 8: 文档更新

**Files:**
- Modify: `docs/architecture.md:269-272`（§9.3 进程监控）
- Modify: `memory/project_pocketbase_pivot.md`（5 个 minor 残留 #5 标记已修）

- [ ] **Step 1: 更新 architecture.md §9.3**

修改 `docs/architecture.md` §9.3 章节：

```markdown
### 9.3 进程监控

- Rust 充当代理时被动检测 PocketBase 进程存活：
  - 转发前 `try_wait()` 检测进程是否已退出（零开销）
  - forward 失败（connect refused / timeout）回退到自愈
- 自愈流程（详见 `docs/superpowers/specs/2026-06-19-pb-auto-restart-design.md`）：
  - 二次确认 → 滑动窗口限流（5min×3 次）→ 端口冲突检测（lsof + cmdline 验证避免误杀）→ 用原端口 spawn → health check
  - 成功 → 重试原请求一次（透明恢复）
  - 失败 → `app.status=Error` + flush + 503 PB_UNAVAILABLE
- status=Error 的 app 代理直接返回 503，不进自愈路径（需 DELETE + 重新创建恢复）
```

- [ ] **Step 2: 更新 memory**

修改 `/Users/konghayao/.claude/projects/-Users-konghayao-code-ai-agent-sites/memory/project_pocketbase_pivot.md`：

把第 48 行的 5 个 minor 残留 #5：

```
5. `api/apps.rs` `port=0` 占位记录过早 flush，崩溃恢复时静默丢失
```

改为：

```
5. ~~`api/apps.rs` `port=0` 占位记录过早 flush，崩溃恢复时静默丢失~~ → **2026-06-19 已部分修复**：pb 崩溃后通过 `restart_if_needed` 自动重启（5min×3 次上限），不再静默丢失。`port=0` 占位本身仍存在但不再导致状态不一致。详见 spec `docs/superpowers/specs/2026-06-19-pb-auto-restart-design.md`。
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "$(cat <<'EOF'
docs(arch): §9.3 进程监控从「后续 plan」改为已实现

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

memory 文件不在仓库内，单独保存即可（不需要 git add）。

---

## Self-Review 检查表

- [x] **Spec 覆盖**：
  - §3 触发与检测 → Task 6（serve_api_proxy 改造）
  - §4 模块边界 → Task 2/3/4（RestartCounter、is_alive、restart_if_needed、RestartOutcome）
  - §5 状态机 → Task 6（status=Error 短路 + 同步）
  - §6 测试 1-6 → Task 2/3/4/5
  - §6 测试 7-10 → Task 6
  - §8 验收标准 → Task 7 全部覆盖
- [x] **无占位符**：所有代码块完整，无 TBD/TODO
- [x] **类型一致性**：`RestartOutcome` 在 Task 4 定义，Task 6 使用变体名 `Restarted`/`StillHealthy`/`RateLimited`/`GiveUp` 一致；`is_alive`/`restart_if_needed` 签名跨任务一致
- [x] **TDD 顺序**：每个 Task 都是「写测试 → 跑失败 → 实现 → 跑通过 → commit」
- [x] **DRY**：端口冲突处理、forward 调用都封装在 handle_proxy_with_recovery 内部
- [x] **YAGNI**：不做后台心跳监控、不做重置 API、不做启动时一致性修复

## 已知测试 gap

- §6 测试 8「pb 僵死（health 检查超时）」：纯僵死难稳定模拟（依赖 SQLite 锁死），spec 已声明作为已知 gap 接受。本 plan 不写此测试，但 `is_recoverable_error` 的 timeout 分支保证 forward 失败时仍触发自愈路径。

## 端到端验收（用户视角）

执行 Task 7 Step 3 的脚本，应得到：
- 第 1 次 kill + 请求 → 200（自动重启）
- 第 4 次 kill + 请求 → 503（RateLimited）
- /api/apps/{id} 返回 status="error"
