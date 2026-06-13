# CLAUDE.md

## 项目概述

Agent 站点托管平台 — 用于托管、路由和管理多个 Agent Web 站点的 Rust 服务。

| Crate | 职责 |
|-------|------|
| `crates/server` | 核心服务：HTTP 服务器、站点管理、路由分发 |

## 依赖关系

当前为单 crate workspace。后续按需拆分（如 `config`、`db`、`renderer` 等），拆分时保持 workspace resolver = "2"，禁止下层依赖上层。

## 开发命令

```bash
cargo build                          # 构建所有 crate
cargo build -p agent-sites           # 构建指定 crate
cargo run                            # 运行服务（默认 0.0.0.0:3000）
cargo run -- --port 8080             # 指定端口
cargo test                           # 全量测试
cargo test -p agent-sites -- <test_name>  # 单个测试
lefthook install                     # 安装 git hooks
lefthook run pre-commit              # pre-commit（fmt/check/clippy）
```

## 架构要点

### HTTP 服务

使用 `axum` + `tokio`。Router 在 `create_app()` 中构建，所有路由集中声明。中间件通过 `tower-http` 提供（CORS、Trace、ServeDir 等）。

### 数据库

使用 `sqlx` + SQLite。迁移文件放在 `crates/server/migrations/`。

## 编码规范

- Rust 2021 edition，tokio async/await + async-trait
- 库用 `thiserror`，应用层用 `anyhow::Result`
- 日志用 `tracing`，禁止 `println!`/`eprintln!`
- 测试与源码分离为同目录 `_test.rs` 文件（≥30 行必须分离）
- bin crate 集成测试在 `src/` 内（不支持 `tests/` 目录）
- 每模块一目录，`mod.rs` 入口；Workspace resolver = "2"，禁止下层依赖上层
- 禁止 `ℹ`（U+2139）符号和 `[i]` 前缀
- **字符串截断必须用字符级操作**：`s.chars().take(N).collect()` 或 `s.char_indices().nth(N)`，`&s[..N]` 对 CJK 会 panic
- 终端列宽用 `unicode-width` crate（CJK 占 2 列）

## 测试编写风格

- 注释、断言消息用中文；命名 `test_<被测对象>_<场景>`
- Arrange-Act-Assert，无空行分隔
- 断言优先 `assert_eq!`/`assert!`，`.unwrap()` 仅用于构造测试数据
- Mock 命名 `make_` 前缀（函数），`Mock` 前缀（结构体），不跨文件共享
- 最小依赖：`assert!`/`assert_eq!`/`matches!` + `tempfile` + `tokio-test`

## 开发注意事项

- **测试隔离**：禁止写入全局配置或全局状态。测试用临时目录或 mock。
- **`std::sync::RwLockReadGuard` 不是 `Send`**，async 中不能跨 `.await` 持有，用 `parking_lot::RwLock`。
- **跨平台 spawn [TRAP]**：所有子进程 spawn 必须通过统一 wrapper，Windows 用 `cmd /C`、Unix 用 `bash -c`。
- **路径校验**：接收用户侧路径时必须做路径穿越防护（`canonicalize` + prefix 检查）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `RUST_LOG` | 日志级别（默认 info） |
| `RUST_LOG_FORMAT` | `"json"` 时输出 JSON 格式日志 |
| `DATABASE_URL` | SQLite 数据库路径（默认 `sqlite:data/agent-sites.db`） |

## Git Attribution

创建 git commit 时，在 commit message 末尾追加：

```
Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
```
