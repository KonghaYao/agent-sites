> ⚠️ **已归档**（历史文档，2026-06-13）
>
> 本文档描述的 **Rust + axum + sqlx/sqld + Turso** 架构已删除。
> 当前实现是 **Deno + PocketBase**，权威参考：
> - 架构：`docs/architecture.md`
> - 部署/使用：`README.md`
> - 三层鉴权：`docs/superpowers/specs/2026-06-19-token-only-access-design.md`
>
> 本文件保留作历史记录，**不要作为当前实现参考**。

# 📋 agent-sites 后续修复计划

> 基于 3 维度 E2E 测试（边界/安全/并发）发现的全部剩余问题

---

## 概览

| 优先级 | 待修复 | 已修复 |
|--------|--------|--------|
| 🔴 高 | 0 | 4 |
| 🟡 中 | 1 | 4 |
| 🟢 低 | 5 | 0 |
| **合计** | **6** | **8** |

---

## 🟡 中危

### I-001: 输入字段无长度/范围校验

**文件**: `crates/server/src/api/sites.rs`, `crates/server/src/api/databases.rs`

**现状**:
- 站点名/数据库名无长度上限，100KB 字符串可写入
- `idle_timeout_secs` 接收负数（如 `-1`）
- `keep_alive=false` + `idle_timeout_secs=0` 逻辑矛盾无校验

**建议修复**:
- 站点名/数据库名添加 1-255 字符限制
- `idle_timeout_secs` 范围 `[10, 86400]`（10秒~24小时）
- 空名称 (`""`) 和纯空白名称应拒绝

---

## 🟢 低危

### I-002: 名称可包含特殊 Unicode 控制字符

**文件**: 输入校验层（目前无集中校验）

**现状**: 零宽空格 (`\u200B`)、RTL override (`\u202E`)、null 字节 (`\u0000`) 均可写入站点名/数据库名，可能导致前端展示混淆或下游截断。

**建议修复**: 在 `CreateSiteInput`/`CreateDatabaseInput` 的 `Deserialize` 或 handler 层过滤控制字符：
```rust
fn sanitize_name(name: &str) -> Result<String, AppError> {
    if name.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(AppError::BadRequest("名称包含非法字符"));
    }
    // ...
}
```

### I-003: JSON `\u0000` null 字节被 Serde 接受

**文件**: 无集中层

**现状**: `{"name":"test\u0000evil"}` 被 Serde 反序列化成功，null 字节被写入 SQLite。

**建议修复**: 同 I-002，在名称校验中拒绝 null 字节。

### I-004: 缺少 Content-Type 严格校验

**文件**: `crates/server/src/api/deploy.rs` 等

**现状**: multipart 上传通过 `axum` 自动处理，但其他端点依赖 Serde 反序列化。缺少对 `Content-Type: application/json` 的显式要求（axum 的 `Json` extractor 若收到非 JSON 返回 500）。

**建议修复**: 利用 axum 的 `Json` extractor（当前已有），但建议添加 response mapper 将非 JSON Content-Type 的 500 转为 415 Unsupported Media Type。

### I-005: 暂无请求频率限制

**文件**: `crates/server/src/lib.rs`

**现状**: 无速率限制，理论上可被 DoS（大量创建站点/数据库）或暴力扫描 UUID。

**建议修复**: 添加 `tower_http::limit::RateLimitLayer` 或 `tower::limit::ConcurrencyLimit`（按 IP 或全局）。

### I-006: 健康检查端点无认证保护

**文件**: `crates/server/src/lib.rs:55`

**现状**: `/health` 端点公开暴露，泄露服务状态（虽然目前只返回 "ok"）。

**建议修复**: 当前阶段风险低（仅返回固定字符串），后续若添加详细信息则需考虑认证。
