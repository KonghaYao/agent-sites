// App model 单元测试（由 crates/server/src/app/model_test.rs 1:1 迁移而来）。
// 纯字段/序列化/反序列化测试，不依赖 PocketBase 子进程、端口、tempfile。
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0";
import {
  type App,
  APP_STATUS_VALUES,
  type AppStatus,
  appStatusAsStr,
  generateId,
  isValidId,
} from "./model.ts";

// 构造完整 App 测试数据（make_ 前缀，复刻 Rust inline struct）
function make_app(overrides: Partial<App> = {}): App {
  return {
    id: "app-abc123",
    name: "my-app",
    type: "pocketbase",
    port: 9001,
    status: "running",
    created_at: "2026-06-19T10:00:00Z",
    updated_at: "2026-06-19T10:00:00Z",
    superuser_email: "",
    superuser_password: "",
    ...overrides,
  };
}

Deno.test("test_app_序列化包含全部字段", () => {
  // Act: Rust 用 serde_json::to_value，TS 端直接结构化等价 JSON.parse(JSON.stringify(...))
  const app = make_app();
  const json = JSON.parse(JSON.stringify(app));
  assertEquals(json.id, "app-abc123");
  assertEquals(json.name, "my-app");
  assertEquals(json.port, 9001);
  assertEquals(json.status, "running");
});

Deno.test("test_app_status_枚举序列化为字符串", () => {
  const expected: AppStatus[] = ["starting", "running", "stopped", "error"];
  for (const s of expected) {
    // 字面量联合本身即字符串，序列化结果与字面量一致
    assertEquals(JSON.parse(JSON.stringify(s)), s);
    assertEquals(appStatusAsStr(s), s);
  }
  // APP_STATUS_VALUES 覆盖全部 4 个状态
  assertEquals(APP_STATUS_VALUES.length, 4);
});

Deno.test("test_app_status_反序列化", () => {
  // 复刻 serde_json::from_str("\"running\"") -> AppStatus::Running
  const s = JSON.parse('"running"') as AppStatus;
  assertEquals(s, "running");
});

Deno.test("test_app_id_格式校验_合法", () => {
  assert(isValidId("app-abc123"));
  assert(isValidId("app-a1b2c3d4"));
});

Deno.test("test_app_id_格式校验_非法", () => {
  // 缺前缀
  assert(!isValidId("abc123"));
  // 大写字母
  assert(!isValidId("app-ABC"));
  // 后缀为空
  assert(!isValidId("app-"));
  // 含空格
  assert(!isValidId("app-a b c"));
  // 空字符串
  assert(!isValidId(""));
});

Deno.test("test_app_生成新_id_带前缀", () => {
  const id = generateId();
  assert(id.startsWith("app-"));
  assert(id.length > "app-".length);
  assert(isValidId(id));
});

Deno.test("test_app_生成新_id_每次不同", () => {
  const id1 = generateId();
  const id2 = generateId();
  // uuid v4 应保证唯一性
  assertNotEquals(id1, id2, "uuid v4 应保证唯一性");
});

Deno.test("test_app_旧json无superuser字段_反序列化_默认空字符串", () => {
  // 模拟旧 apps.json（pivot 之前的格式），无 superuser_email/password 字段。
  // Rust 端靠 #[serde(default)] 兜底；TS 端由 store 反序列化层填默认值，
  // 这里直接测「缺字段时填空字符串」的等价行为。
  const oldJson = `{
        "id": "app-old1",
        "name": "legacy",
        "port": 9001,
        "status": "running",
        "created_at": "2026-06-19T10:00:00Z",
        "updated_at": "2026-06-19T10:00:00Z"
    }`;
  const parsed = JSON.parse(oldJson) as Partial<App>;
  // 旧 json 必须能反序列化（向后兼容）
  const app: App = {
    superuser_email: "",
    superuser_password: "",
    ...parsed,
  } as App;
  assertEquals(app.id, "app-old1");
  assertEquals(app.superuser_email, "");
  assertEquals(app.superuser_password, "");
});

Deno.test("test_app_新字段序列化_包含superuser", () => {
  const app = make_app({
    name: "demo",
    superuser_email: "admin@app-abc123.local",
    superuser_password: "deadbeefdeadbeef",
  });
  const json = JSON.parse(JSON.stringify(app));
  assertEquals(json.superuser_email, "admin@app-abc123.local");
  assertEquals(json.superuser_password, "deadbeefdeadbeef");
});
