// App 实体与状态定义（一个 App = 一个 PocketBase 进程）
// 由 crates/server/src/app/model.rs 1:1 迁移而来。

/**
 * App 运行状态。
 *
 * Rust 端为 `#[serde(rename_all = "lowercase")]` 枚举，序列化结果为
 * `"starting" | "running" | "stopped" | "error"`。TS 端用字面量联合类型 +
 * 常量值数组保证 JSON 往返等价。
 */
export type AppStatus = "starting" | "running" | "stopped" | "error";

export const APP_STATUS_VALUES: readonly AppStatus[] = [
  "starting",
  "running",
  "stopped",
  "error",
] as const;

/**
 * 等价 `AppStatus::as_str` —— 返回状态的字符串表示。
 * 由于 TS 字面量联合本身就是字符串，这里仅做透传，保留 API 形态对齐 Rust。
 */
export function appStatusAsStr(status: AppStatus): AppStatus {
  return status;
}

/**
 * App 实体（一个 App = 一个 PocketBase 进程）。
 *
 * `superuser_email` / `superuser_password` 在 Rust 端带 `#[serde(default)]`，
 * 保证加载旧 `apps.json`（pivot 之前的格式）不炸。TS 端在反序列化层
 * （store）负责填补缺省值，这里仅声明字段。
 */
export interface App {
  id: string;
  name: string;
  port: number;
  status: AppStatus;
  created_at: string;
  updated_at: string;
  /** PocketBase superuser 邮箱（RFC 格式，如 admin@app-xxx.local）。 */
  superuser_email: string;
  /** PocketBase superuser 密码（明文，与 apps.json 同级保护）。 */
  superuser_password: string;
}

/** app_id 后缀允许的字符：小写 ASCII 字母或数字（显式避免 `\w` Unicode 陷阱）。 */
const APP_ID_REST_RE = /^[a-z0-9]+$/;

/**
 * 校验 ID 格式：`app-{4..20个小写字母/数字}`（model.rs:44-54）。
 *
 * 实现：先 `strip_prefix("app-")`，再校验后缀非空、长度 ≤ 20、
 * 全部为 ASCII 小写字母或数字。用正则 `/^[a-z0-9]+$/` 显式 ASCII 范围，
 * 避免 `\w` 在 JS 端是 Unicode-aware 的陷阱。
 */
export function isValidId(id: string): boolean {
  const rest = id.startsWith("app-") ? id.slice("app-".length) : null;
  if (rest === null) return false;
  // Rust 原版仅要求 !rest.is_empty() && rest.len() <= 20，
  // 实际效果即 slug 长度 ∈ [1, 20]。文档标注的 4 位下限来自调用方约定。
  return rest.length >= 1 && rest.length <= 20 && APP_ID_REST_RE.test(rest);
}

/**
 * 生成新 ID：`app-{8位 hex}`（model.rs:57-62）。
 *
 * Rust 用 `uuid::Uuid::new_v4().as_simple().to_string()` 取前 8 位 hex；
 * TS 端用 `crypto.randomUUID()` 去掉连字符取前 8 位等价实现
 * （v4 即可，无需 v7）。
 */
export function generateId(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `app-${hex.slice(0, 8)}`;
}
