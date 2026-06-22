> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 日志丰富计划 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Agent Sites 平台添加结构化、可追踪的日志体系：HTTP 请求自动追踪 + API 操作审计 + 进程生命周期记录 + Turso 调用耗时 + 巡检心跳。

**Architecture:** 两层日志——基础设施层（tower-http TraceLayer 自动记录所有 HTTP 请求的 method/path/status/latency/request_id）和应用层（tracing::info!/warn!/error! 宏在关键路径埋点）。request_id 通过 Span 贯穿全链路。

**Tech Stack:** tower-http 0.6 (TraceLayer), tracing 0.1, tracing-subscriber 0.3

---

## 文件结构总览

```
crates/server/src/
├── lib.rs                       # [修改] create_app 添加 TraceLayer 中间件
├── logging.rs                   # [新建] 日志工具函数 (request_id 提取等)
├── main.rs                      # [修改] 格式化配置（JSON 模式下保持结构化）
├── api/
│   ├── databases.rs             # [修改] 创建/删除数据库日志
│   ├── bindings.rs              # [修改] 绑定/解绑日志
│   └── deploy.rs                # [修改] 部署步骤日志
├── process/
│   └── mod.rs                   # [修改] Deno 生命周期日志增强
├── turso/
│   └── mod.rs                   # [修改] Turso API 调用耗时日志
Cargo.toml                       # [不变] (tower-http trace feature 已启用)
```

---

## Task 1: TraceLayer 中间件 — 自动 HTTP 请求日志

**Files:**
- Create: `crates/server/src/logging.rs`
- Modify: `crates/server/src/lib.rs` (create_app)

### Step 1: 编写 logging 工具模块

Create `crates/server/src/logging.rs`:

```rust
use tower_http::classify::{ServerErrorsAsFailures, SharedClassifier};
use tower_http::trace::{self, TraceLayer};
use tracing::Span;
use uuid::Uuid;

/// 创建带 request_id 的 TraceLayer
pub fn make_trace_layer() -> TraceLayer<SharedClassifier<ServerErrorsAsFailures>> {
    TraceLayer::new_for_http()
        .make_span_with(|request: &axum::http::Request<_>| {
            let request_id = Uuid::now_v7().to_string();
            tracing::info_span!(
                "request",
                request_id = %&request_id[..8],            // 短 ID 用于日志可读性
                method = %request.method(),
                uri = %request.uri().path(),
            )
        })
        .on_request(trace::DefaultOnRequest::default())
        .on_response(
            trace::DefaultOnResponse::new()
                .level(tracing::Level::INFO)
                .latency_unit(tower_http::LatencyUnit::Millis),
        )
        .on_failure(
            trace::DefaultOnFailure::new()
                .level(tracing::Level::ERROR)
                .latency_unit(tower_http::LatencyUnit::Millis),
        )
}
```

### Step 2: 注册模块并集成 TraceLayer

Modify `crates/server/src/lib.rs`:

在 `pub mod` 声明区域新增：
```rust
pub mod logging;
```

在 `create_app` 函数中，在 `router.with_state(state)` 之前添加 TraceLayer：

```rust
use tower_http::trace::TraceLayer;
use crate::logging;

pub fn create_app(state: Arc<AppState>) -> axum::Router {
    // ... existing route registration ...

    router
        .layer(logging::make_trace_layer())
        .with_state(state)
}
```

### Step 3: 验证

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: PASS

启动服务后，访问任意端点，应看到类似输出：
```
2026-06-13T10:00:00.000Z  INFO request{request_id=019ec3cd method=GET uri=/api/sites}: tower_http::trace::on_response: finished processing request latency=2 ms status=200
```

### Step 4: 提交

```bash
git add crates/server/src/logging.rs crates/server/src/lib.rs
git commit -m "feat: TraceLayer 中间件 — HTTP 请求自动日志（method/path/status/latency/request_id）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 2: API 操作审计日志

**Files:**
- Modify: `crates/server/src/api/databases.rs`
- Modify: `crates/server/src/api/bindings.rs`
- Modify: `crates/server/src/api/deploy.rs`
- Modify: `crates/server/src/api/sites.rs`

### Step 1: databases.rs — 创建/删除数据库日志

Modify `crates/server/src/api/databases.rs`，在 `create_database` handler 中，Turso 调用成功后添加：

```rust
    tracing::info!(
        db_name = %input.name,
        turso_db = %turso_db_name,
        region = %input.region,
        "数据库创建成功"
    );
```

在 `delete_database` handler 中，软删除成功后添加：

```rust
    tracing::info!(
        db_id = %id,
        turso_db = %db_record.turso_db_name,
        "数据库已标记删除"
    );
```

### Step 2: bindings.rs — 绑定/解绑日志

Modify `crates/server/src/api/bindings.rs`，在 `bind_database` handler 成功返回前添加：

```rust
    tracing::info!(
        site_id = %site_id,
        database_id = %input.database_id,
        "数据库绑定成功"
    );
```

在 `unbind_database` handler 成功返回前添加：

```rust
    tracing::info!(
        site_id = %site_id,
        database_id = %database_id,
        "数据库解绑成功"
    );
```

### Step 3: deploy.rs — 部署步骤日志

Modify `crates/server/src/api/deploy.rs`，在关键步骤添加日志。

验证 main.ts 存在后：
```rust
    tracing::info!(
        site_id = %site_id,
        filename = %filename,
        size_bytes = tar_gz_data.len(),
        "部署包校验通过"
    );
```

版本创建后：
```rust
    tracing::info!(
        site_id = %site_id,
        version_id = %version.id,
        code_dir = %version.code_dir,
        "版本创建成功"
    );
```

激活成功后：
```rust
    tracing::info!(
        site_id = %site_id,
        version_id = %version.id,
        "版本已激活"
    );
```

停止旧进程时（如有）：
```rust
    if state.process_manager.is_running(&site_id) {
        tracing::info!(
            site_id = %site_id,
            "正在停止旧 Deno 进程"
        );
        state.process_manager.stop(&state.db, &site_id).await?;
    }
```

### Step 4: sites.rs — Deno 启停操作日志

Modify `crates/server/src/api/sites.rs`，在 `start_deno` handler 中：

```rust
    tracing::info!(site_id = %site_id, "收到手动启动 Deno 请求");
    let port = state.process_manager.start(...).await?;
    tracing::info!(site_id = %site_id, port = port, "Deno 手动启动成功");
```

在 `stop_deno` handler 中：
```rust
    tracing::info!(site_id = %site_id, "收到手动停止 Deno 请求");
    state.process_manager.stop(...).await?;
    tracing::info!(site_id = %site_id, "Deno 已停止");
```

### Step 5: 构建 + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: PASS

### Step 6: 提交

```bash
git add crates/server/src/api/
git commit -m "feat: API 操作审计日志（部署/数据库/绑定/Deno 启停）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 3: Deno 进程生命周期日志

**Files:**
- Modify: `crates/server/src/process/mod.rs`
- Modify: `crates/server/src/process/deno.rs`
- Modify: `crates/server/src/proxy/mod.rs`

### Step 1: process/mod.rs — start/stop 日志增强

Modify `crates/server/src/process/mod.rs`，在 `start()` 函数中。

获取活跃版本后：
```rust
    tracing::debug!(
        site_id = %site_id,
        version_id = %version_id,
        "准备冷启动 Deno"
    );
```

分配端口后：
```rust
    tracing::debug!(
        site_id = %site_id,
        port = port,
        "分配端口"
    );
```

启动进程后：
```rust
    tracing::info!(
        site_id = %site_id,
        port = port,
        main_ts = %main_ts_str,
        "Deno 进程已启动，等待健康检查"
    );
```

健康检查成功：
```rust
    tracing::info!(
        site_id = %site_id,
        port = port,
        "Deno 健康检查通过，进程就绪"
    );
```

健康检查失败：
```rust
    tracing::warn!(
        site_id = %site_id,
        port = port,
        timeout_secs = 10,
        "Deno 健康检查超时，进程已终止"
    );
```

在 `stop()` 函数中：
```rust
    tracing::info!(
        site_id = %site_id,
        "停止 Deno 进程"
    );
```

### Step 2: deno.rs — spawn 日志

Modify `crates/server/src/process/deno.rs`，在 `wait_for_health` 函数中，健康检查开始时：

```rust
    tracing::debug!(
        port = port,
        timeout_secs = timeout_secs,
        "开始 Deno 健康检查轮询"
    );
```

### Step 3: proxy/mod.rs — 冷启动触发日志

Modify `crates/server/src/proxy/mod.rs`，在 `serve_api_proxy` handler 中。

在冷启动触发处（`_ => {` 分支）添加：

```rust
    tracing::info!(
        site_id = %site_id,
        deno_status = %site.deno_status,
        "代理请求触发 Deno 冷启动"
    );
```

### Step 4: 构建 + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: PASS

### Step 5: 提交

```bash
git add crates/server/src/process/ crates/server/src/proxy/
git commit -m "feat: Deno 进程生命周期日志（冷启动/健康检查/停止/代理触发）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 4: Turso API 调用日志

**Files:**
- Modify: `crates/server/src/turso/mod.rs`

### Step 1: 添加调用耗时日志

Modify `crates/server/src/turso/mod.rs`，在 `create_database` 方法中。

在调用 Turso API 前后添加计时：

```rust
    let start = std::time::Instant::now();
    let resp = self
        .client
        .post(&create_url)
        // ... existing headers and body ...
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Turso 创建数据库请求失败: {e}")))?;
    let elapsed = start.elapsed();

    tracing::debug!(
        turso_action = "create_database",
        name = %name,
        region = %region,
        latency_ms = elapsed.as_millis(),
        status = %resp.status(),
        "Turso API 调用"
    );
```

同样对 token 创建请求添加计时：

```rust
    let start = std::time::Instant::now();
    let token_resp = self
        .client
        .post(&token_url)
        // ...
        .send()
        .await?;
    let elapsed = start.elapsed();

    tracing::debug!(
        turso_action = "create_token",
        db_name = %turso_db_name,
        latency_ms = elapsed.as_millis(),
        status = %token_resp.status(),
        "Turso token 创建"
    );
```

### Step 2: 构建 + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: PASS

### Step 3: 提交

```bash
git add crates/server/src/turso/
git commit -m "feat: Turso API 调用耗时日志

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## Task 5: 后台巡检日志增强

**Files:**
- Modify: `crates/server/src/main.rs`

### Step 1: 添加巡检心跳 + 跳过信息

Modify `crates/server/src/main.rs`，在 `run_idle_checker` 函数中。

函数开头添加：

```rust
    tracing::info!(interval_secs = interval_secs, "后台空闲巡检已启动");
```

在循环体中，巡检开始时（`interval.tick().await` 之后）：

```rust
    tracing::debug!("执行空闲巡检");
```

对于每个被跳过的热启动站点（`if site.keep_alive { continue; }` 之前），只在 debug 级别：

```rust
    tracing::debug!(
        site_id = %site.id,
        "keep_alive 模式，跳过空闲检查"
    );
```

空闲检查结果汇总（循环结束后）：

```rust
    if !sites.is_empty() {
        let running_count = sites.iter().filter(|s| s.keep_alive).count();
        let idle_count = sites.len() - running_count;
        let stopped_count = /* count of stopped in this iteration */;
        tracing::debug!(
            total_running = sites.len(),
            keep_alive = running_count,
            idle_candidates = idle_count,
            "巡检完成"
        );
    }
```

### Step 2: 构建 + 测试

Run: `cargo build -p agent-sites && cargo test -p agent-sites`
Expected: PASS

### Step 3: 提交

```bash
git add crates/server/src/main.rs
git commit -m "feat: 后台巡检日志增强（启动提示/心跳/debug 详情）

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## 总结

| Task | 内容 | 日志级别 | 依赖 |
|------|------|----------|------|
| 1 | TraceLayer HTTP 自动日志 | INFO/ERROR | 无 |
| 2 | API 操作审计日志 | INFO | 无 |
| 3 | Deno 进程生命周期日志 | INFO/DEBUG/WARN | 无 |
| 4 | Turso API 调用日志 | DEBUG | 无 |
| 5 | 后台巡检日志 | INFO/DEBUG | 无 |

所有 Task 独立，可并行执行。总计 5 个 Task，每个文件修改 ~3-10 行。
