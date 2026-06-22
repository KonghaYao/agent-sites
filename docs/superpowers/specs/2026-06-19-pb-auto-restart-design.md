# PocketBase 进程崩溃自愈设计

> 2026-06-19 · 针对 pre-existing bug #5：PocketBase 子进程退出后，Rust 网关内存中 `app.status` 仍标记 `running`，代理请求返回 HTTP 500，用户看到「加载失败：Error: HTTP 500」。

## 1. 问题

当前架构（`crates/server/src/process/mod.rs`、`crates/server/src/proxy/mod.rs`、`crates/server/src/lib.rs`）：

- `PocketBaseProcessManager.processes` 是 `Arc<RwLock<HashMap<app_id, ManagedProcess>>>`，spawn 时插入、stop 时移除，**无任何存活监控**
- `proxy::forward(port, ...)` 直接 `reqwest` 连 `http://localhost:{port}`，connect refused → `AppError::Internal` → HTTP 500
- `serve_api_proxy` 用 `app.port` 直接转发，**不检查 pb 存活**
- `AppStatus` 有 `Starting/Running/Stopped/Error` 四态，但运行时不更新

崩溃场景：
- **进程退出**：pb 子进程崩溃、被 `kill -9`、OOM
- **进程僵死**：进程在但不响应 HTTP（SQLite WAL 死锁、GC 长暂停、文件描述符耗尽）

观察实例：`data/app-82c07339/` 的 pb 被 kill 后，前端调 `/api/collections/posts/records` 收到 HTTP 500。

## 2. 目标与非目标

**目标**：
- pb 进程退出或僵死时，**首次出错请求自动恢复**，用户视角无感（最多等几秒）
- 防止 pb 反复崩溃导致无限重启循环
- 状态一致性：自愈失败时同步更新 `app.status=Error` + apps.json

**非目标（YAGNI）**：
- 启动时一致性修复（apps.json 里 running 的 app 启动时未 spawn）—— 用户明确只要运行时自愈，本 spec 不做
- 后台心跳监控（持续开销，MVP 不必要）
- status=Error 的重置 API（用户可手动 DELETE + 重新创建）
- 数据备份 / SQLite 修复（架构 §9.4 待定项）

## 3. 触发与检测

代理 handler 两道关：

**第一关（轻量）：进程存活检测**
请求进入 `serve_api_proxy` 后，转发前调 `process_manager.is_alive(app_id)`：
- write lock + `child.try_wait()`（`tokio::process::Child::try_wait` 签名要求 `&mut self`，故 write lock）→ `Some(_)` 表示进程已退出 → 触发自愈
- `None` 表示进程还在 → 进入第二关（直接 forward）

**第二关（探测僵死）：forward 失败回退**
`proxy::forward` 返回 `AppError::Internal` 且错误信息含 `connect refused` / `connection refused` / `timed out` / timeout 关键字时，认为是僵死或刚退出 → 触发自愈

**自愈流程**（在 `restart_if_needed` 内）：
1. 拿 `processes` 的 write lock
2. 二次确认：再 `try_wait()`，如果 `None`（还活着），返回 `StillHealthy`（防 race，调用方直接重试 forward）
3. 检查滑动窗口重启计数（独立锁）：5 分钟内 >= 3 次 → 返回 `RateLimited`（调用方返回 503）
4. 端口冲突处理（端口仍被占用）：
   - `lsof -ti :{port}` 拿占用 pid
   - 读 `/proc/{pid}/cmdline`（Unix）/ `wmic process`（Windows），验证含 `pocketbase serve` + `--dir=.../{app_id}`
   - 匹配 → SIGKILL 该 pid
   - 不匹配（可能是无关服务）→ 放弃，返回 `GiveUp`（避免误杀用户其他服务）
5. 用原端口 spawn pb（kill_on_drop=true）
6. 释放 write lock
7. 锁外 `wait_for_health(port, 10)`，超时 → 返回 `GiveUp`
8. 返回 `Restarted`

**第一关零开销**（try_wait 是微秒级 syscall）；**第二关只在 forward 失败时触发**，正常路径无影响。

## 4. 模块边界与并发

**新增 / 修改**：

| 单元 | 文件 | 职责 |
|---|---|---|
| `PocketBaseProcessManager::is_alive(&self, app_id) -> bool` | `crates/server/src/process/mod.rs` | write lock + try_wait（tokio 签名要求），公开方法 |
| `PocketBaseProcessManager::restart_if_needed(&self, app_id, data_dir, allocator) -> Result<RestartOutcome, AppError>` | `crates/server/src/process/mod.rs` | 原子段执行自愈流程 |
| `enum RestartOutcome { Restarted, StillHealthy, RateLimited, GiveUp }` | `crates/server/src/process/mod.rs` | 自愈结果 |
| `struct RestartCounter { inner: Arc<RwLock<HashMap<String, Vec<Instant>>>> }` | `crates/server/src/process/mod.rs`（私有） | 每 app_id 滑动窗口；`record_and_check(app_id) -> bool`（true = 允许重启，false = 超限） |
| `PocketBaseProcessManager::processes` 字段扩展 | `crates/server/src/process/mod.rs` | 加 `restart_counter: RestartCounter` 字段 |
| `serve_api_proxy` | `crates/server/src/lib.rs` | 转发前调 `is_alive`，失败回退到 `restart_if_needed` + 重试一次 |
| `proxy::forward` 错误信息 | `crates/server/src/proxy/mod.rs` | 区分 connect refused / timeout / 其他，供上层判断（不破坏现有 API） |

**关键不变量**：
- `processes` HashMap 仍是单一锁源，restart 在 write lock 内完成 spawn + insert；health check 在锁外（与现有 `start()` 一致），失败时回滚
- `RestartCounter` 用**单独的 RwLock**，不与 processes 锁耦合，避免嵌套锁死锁
- 重启端口冲突检测：通过 `/proc/{pid}/cmdline` 验证占用者确实是当前 app 的 pb 进程

**`lib.rs::serve_api_proxy` 改造伪码**：
```rust
// 第一关
if !state.process_manager.is_alive(&app_id) {
    // 自愈
    return handle_with_recovery(state, app_id, path, method, headers, body).await;
}
// 第二关：forward 失败回退
match forward(...).await {
    Ok(resp) => Ok(resp),
    Err(e) if is_recoverable(&e) => handle_with_recovery(...).await,
    Err(e) => Err(e),
}

async fn handle_with_recovery(...) {
    // status=Error 直接 503
    let app = store.get(&app_id).await;
    if app.status == Error { return Err(503 PB_UNAVAILABLE); }
    match process_manager.restart_if_needed(...).await {
        Ok(Restarted) | Ok(StillHealthy) => forward(...).await, // 重试一次
        Ok(RateLimited) | Ok(GiveUp) => {
            store.update(App{ status: Error, ... }).await;
            store.flush().await;
            Err(503 PB_UNAVAILABLE)
        }
        Err(e) => Err(500),
    }
}
```

## 5. AppStatus 与错误返回

**状态机**：
- 自愈成功（Restarted / StillHealthy）→ `AppStatus::Running` 不变
- 自愈 `RateLimited` / `GiveUp` → `store.update(app{ status: Error })` + `flush`
- `status=Error` 时代理直接 503（不进自愈路径，避免延迟）

**HTTP 返回**：
- 自愈成功 → 重试 forward 一次，把上游响应原样返回（用户视角无感）
- 自愈失败 → `StatusCode::SERVICE_UNAVAILABLE_503` + JSON：
  ```json
  {"data": null, "error": {"code": "PB_UNAVAILABLE", "message": "PocketBase 后端多次重启失败，已停止自愈"}}
  ```
- 启动后 `status=Error` 的 app 代理 → 直接 503（不进自愈路径）

**幂等性**：`status=Error` 后用户可 `DELETE /api/apps/{id}` + 重新创建恢复；本 spec 不加重置 API（YAGNI）。

**日志**：
- 每次自愈尝试：`tracing::warn!(app_id, attempt_count, reason, "PocketBase 自愈尝试")`
- 放弃：`tracing::error!(app_id, reason, "PocketBase 自愈放弃，标记 Error")`

## 6. 测试策略

### 单元测试（`crates/server/src/process/mod_test.rs`）

1. `test_is_alive_进程存在_返回true`：spawn sleep 子进程 → is_alive=true
2. `test_is_alive_进程已退出_返回false`：spawn 后 kill + wait → is_alive=false
3. `test_restart_if_needed_进程死了_重启成功`：手动 kill pb → restart_if_needed → Restarted + 新 child 存在
4. `test_restart_if_needed_进程还在_返回StillHealthy`：pb 正常 → restart_if_needed → StillHealthy，无副作用
5. `test_restart_if_needed_短窗口内超过3次_RateLimited`：预填 RestartCounter 3 个时间戳 → RateLimited
6. `test_restart_if_needed_health_check失败_GiveUp`：用错误 binary 路径让 spawn 后 health 失败 → GiveUp

### 集成测试（`crates/server/src/lib_test.rs`）

7. `test_代理_pb进程被kill后_自动重启_请求成功`：真实 pb spawn app → `kill -9` → curl `/api/.../records` → 自动重启 → 200
8. `test_代理_pb偊死_health检查超时_自动重启`：用 mock TCP server（`tokio::net::TcpListener::bind` 但不读不写）占用 pb 端口，让 `wait_for_health` 永远不响应；触发 `restart_if_needed` 内的端口冲突分支：检测到 cmdline 不含 pocketbase（是测试自己的 mock 进程），返回 GiveUp → 503。**这条测试只验证端口冲突不误杀路径**；真正"pb 还在但 HTTP 不响应"的僵死场景难以稳定模拟（依赖 SQLite 锁死），作为已知测试 gap 接受。
9. `test_代理_RateLimited后_status变Error_503`：在 RestartCounter 上暴露 `#[cfg(test)] fn seed_for_test(app_id, timestamps)` 钩子，预填 3 个时间戳 → 调用 `restart_if_needed` → 返回 RateLimited → 503 + status=Error
10. `test_代理_statusError的app_直接返回503_不进自愈`：手动把 app.status 设为 Error + flush → curl 代理 → 503，且 RestartCounter 计数不变

### 手动验证脚本（写入 plan 文档）

```bash
# 1. 启动服务 + 上线 demo
cargo run &
scripts/install-demo.sh

# 2. 验证可用
curl localhost:3000/app-{id}/api/collections/posts/records

# 3. kill pb（模拟崩溃）
pkill -9 -f 'pocketbase serve --dir=data/app-'

# 4. 再次请求，应自动重启 + 200
curl localhost:3000/app-{id}/api/collections/posts/records

# 5. 连续 kill 3 次（每次 curl 之间），第 4 次应返回 503
```

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 端口冲突检测误杀无关进程 | `/proc/{pid}/cmdline` 验证含 `pocketbase serve` + `--dir=.../{app_id}`，不匹配则 `GiveUp` |
| 滑动窗口计数 race | RestartCounter 单独锁，`record_and_check` 原子（read+clean+push+check 同一 write guard） |
| 重启时 SQLite WAL 文件锁 | pb SIGTERM 时会 checkpoint，但 kill -9 可能留 WAL；spawn 时 pb 自动恢复（设计上不动 data_dir 任何文件） |
| 首次请求延迟感知 | 自愈路径包含 spawn + health check，最坏 ~3-10s。可接受（用户场景为本地开发） |
| 重启循环消耗资源 | 5min×3 次硬上限后标 Error，需人工介入 |

## 8. 验收标准

1. ✅ kill pb 子进程后，下一次 `/api/...` 请求自动重启并返回 200
2. ✅ pb 僵死（端口被占不响应）时，下一次请求自动重启并返回 200
3. ✅ 5 分钟内连续崩溃 3 次后，第 4 次请求返回 503 PB_UNAVAILABLE
4. ✅ status=Error 的 app 代理直接返回 503，不触发自愈
5. ✅ 自愈失败时 app.status 同步更新为 Error 并 flush 到 apps.json
6. ✅ 正常路径（pb 健康）代理零额外开销（is_alive 是 try_wait 微秒级）
7. ✅ 端口被无关进程占用时不误杀，返回 503 + 告警日志
8. ✅ `cargo test -p agent-sites` 全过 + `cargo clippy -- -D warnings` 0 warnings + `cargo fmt --check` exit 0

## 9. 与现有文档的关系

- **architecture.md §9.3**「进程僵死检测 + 自动重启」原标为「后续 plan」—— 本 spec 即为该 plan 的实现
- **memory `project_pocketbase_pivot.md`** 中的 5 个 minor 残留 #5（`port=0` 占位记录过早 flush，崩溃恢复时静默丢失）—— 本 spec 部分覆盖该残留（自动重启使其不再静默），但 `port=0` 占位记录本身的修复属另一议题，不在本 spec 范围
- 不修改 `architecture.md`（本 spec 自身即为 §9.3 的实现说明，无需重复在架构文档展开）

## 10. 实施顺序提示

1. RestartCounter + 单元测试（独立、易测）
2. is_alive + 单元测试
3. restart_if_needed（先不接端口冲突处理，跑通基本路径） + 单元测试
4. 端口冲突处理 + 单元测试
5. lib.rs serve_api_proxy 接线 + 集成测试
6. status=Error 路径 + 集成测试
7. 错误返回 JSON 格式（503 PB_UNAVAILABLE）+ 集成测试
