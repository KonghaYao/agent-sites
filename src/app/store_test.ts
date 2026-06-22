// AppStore 单元测试（JSON 持久化 + 内存 CRUD + SFRF 端口越界防护）。
// 由 crates/server/src/app/store_test.rs 1:1 迁移而来。
//
// 迁移说明：
// - 本模块为纯单元测试，无 PocketBase spawn，故不需要 pbBinaryAvailable /
//   withTestSpawnLock / 端口隔离（spawn 测试在 apps_test.ts / mod_test.ts）。
// - tempfile::TempDir → Deno.makeTempDir() + 测试末尾 Deno.remove(recursive:true)。
// - Rust AppStore::new(path, 9000, 11000) → new AppStore(path, 9000, 11000)。
// - 方法名沿用 TS camelCase：list/get/add/addIfAbsent/update/remove/usedPorts/flush。
// - assert_eq! → assertEquals；assert!(...) → assert(...) 或断言消息版 assert(...)。
// - HashSet<u16> → Set<number>，用 assertArrayIncludes([...ports], [port]) 校验成员。

import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@^1";
import type { App, AppStatus } from "./model.ts";
import { AppStore } from "./store.ts";

/**
 * 构造测试用 App（对应 Rust make_app）。
 * id / port / status 可定制，其余字段用稳定占位值。
 */
function make_app(id: string, port: number, status: AppStatus): App {
  return {
    id,
    name: `name-${id}`,
    port,
    status,
    created_at: "2026-06-19T10:00:00Z",
    updated_at: "2026-06-19T10:00:00Z",
    superuser_email: "",
    superuser_password: "",
  };
}

/** 生成独立临时目录下的 apps.json 路径，返回 {tempDir, path}。 */
async function makeTempStorePath(): Promise<{ tempDir: string; path: string }> {
  const tempDir = await Deno.makeTempDir();
  const path = `${tempDir}/apps.json`;
  return { tempDir, path };
}

/** 递归删除临时目录（测试清理）。 */
async function cleanup(tempDir: string): Promise<void> {
  await Deno.remove(tempDir, { recursive: true });
}

Deno.test("test_store_新建实例_文件不存在时初始化空", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    const apps = await store.list();
    assert(apps.length === 0, "文件不存在时应初始化为空集合");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_add_后_list_可见", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    await store.add(make_app("app-aaa111", 9001, "running"));
    const apps = await store.list();
    assertEquals(apps.length, 1);
    assertEquals(apps[0].id, "app-aaa111");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_get_返回克隆", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    await store.add(make_app("app-aaa111", 9001, "running"));
    const app = await store.get("app-aaa111");
    assert(app !== undefined, "已存在的 id 应返回 App");
    assertEquals(app.port, 9001);
    const missing = await store.get("app-missing");
    assert(missing === undefined, "不存在的 id 应返回 undefined");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_update_修改字段", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    await store.add(make_app("app-aaa111", 9001, "starting"));
    const current = await store.get("app-aaa111");
    assert(current !== undefined);
    const updated: App = {
      ...current,
      status: "running",
      port: 9005,
    };
    const ok = await store.update(updated);
    assert(ok, "update 命中已存在 id 应返回 true");
    const after = await store.get("app-aaa111");
    assert(after !== undefined);
    assertEquals(after.port, 9005);
    assertEquals(after.status, "running" as AppStatus);
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_remove_删除记录", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    await store.add(make_app("app-aaa111", 9001, "running"));
    const removed = await store.remove("app-aaa111");
    assert(removed, "删除已存在 id 应返回 true");
    const after = await store.get("app-aaa111");
    assert(after === undefined, "删除后 get 应返回 undefined");
    const removedMissing = await store.remove("app-missing");
    assert(!removedMissing, "删除不存在的 id 应返回 false");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_持久化到磁盘_重新加载可见", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    {
      const store = new AppStore(path, 9000, 11000);
      await store.add(make_app("app-aaa111", 9001, "running"));
      await store.add(make_app("app-bbb222", 9002, "stopped"));
      await store.flush();
    }
    // 新实例加载同一路径
    const store2 = new AppStore(path, 9000, 11000);
    const apps = await store2.list();
    assertEquals(apps.length, 2);
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_used_ports_返回所有端口", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    await store.add(make_app("app-aaa111", 9001, "running"));
    await store.add(make_app("app-bbb222", 9005, "running"));
    const ports = await store.usedPorts();
    const arr = [...ports];
    assertArrayIncludes(arr, [9001]);
    assertArrayIncludes(arr, [9005]);
    assertEquals(arr.length, 2);
  } finally {
    await cleanup(tempDir);
  }
});

// Issue #5：add_if_absent 原子 check+insert
Deno.test("test_store_add_if_absent_新id_插入成功返回true", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    const ok = await store.addIfAbsent(
      make_app("app-aaa111", 9001, "running"),
    );
    assert(ok, "首次插入应返回 true");
    const apps = await store.list();
    assertEquals(apps.length, 1);
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_add_if_absent_已存在id_拒绝插入返回false", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    const store = new AppStore(path, 9000, 11000);
    const first = await store.addIfAbsent(
      make_app("app-aaa111", 9001, "running"),
    );
    assert(first, "首次插入应返回 true");
    // 同 id 不同 port：应被拒绝
    const second = await store.addIfAbsent(
      make_app("app-aaa111", 9002, "running"),
    );
    assert(!second, "id 已存在时应返回 false");
    const apps = await store.list();
    assertEquals(apps.length, 1, "重复 id 不应插入");
    assertEquals(apps[0].port, 9001, "原记录端口应保持不变");
  } finally {
    await cleanup(tempDir);
  }
});

// Issue #4：端口越界（SSRF 防护）测试
Deno.test("test_store_加载时_端口低于下限_被跳过", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    {
      const store = new AppStore(path, 9000, 11000);
      await store.add(make_app("app-aaa111", 9001, "running"));
      // 篡改：端口设为 22（SSH）
      await store.add(make_app("app-bad0022", 22, "running"));
      await store.flush();
    }
    // 重新加载：9000-11000 范围外（22）应被跳过
    const store2 = new AppStore(path, 9000, 11000);
    const apps = await store2.list();
    assertEquals(apps.length, 1, "越界端口（22）应被跳过");
    assertEquals(apps[0].id, "app-aaa111");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("test_store_加载时_端口高于上限_被跳过", async () => {
  const { tempDir, path } = await makeTempStorePath();
  try {
    {
      const store = new AppStore(path, 9000, 11000);
      await store.add(make_app("app-aaa111", 9001, "running"));
      // 篡改：端口设为 6379（Redis，在范围外）
      await store.add(make_app("app-bad6379", 6379, "running"));
      await store.flush();
    }
    const store2 = new AppStore(path, 9000, 11000);
    const apps = await store2.list();
    assertEquals(apps.length, 1, "越界端口（6379）应被跳过");
    assertEquals(apps[0].id, "app-aaa111");
  } finally {
    await cleanup(tempDir);
  }
});
