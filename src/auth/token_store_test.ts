// TokenStore 单测
// 被测：src/auth/token_store.ts（参考 AppStore 模式）
import { assertEquals } from "jsr:@std/assert@^1";
import { TokenStore } from "./token_store.ts";

async function withStore<T>(
  fn: (store: TokenStore) => Promise<T>,
): Promise<T> {
  const tmp = await Deno.makeTempDir();
  const path = `${tmp}/tokens.json`;
  const store = new TokenStore(path);
  try {
    return await fn(store);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test({
  name: "test_add_and_get_token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      const added = await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      assertEquals(added, true);
      const got = await store.get("tok-abc");
      assertEquals(got?.app_id, "app-xyz");
      assertEquals(got?.status, "active");
    });
  },
});

Deno.test({
  name: "test_add_duplicate_returns_false",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const second = await store.add({
        token_id: "tok-abc",
        app_id: "app-different",
        status: "active",
        issued_at: "2026-06-19T11:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      assertEquals(second, false);
    });
  },
});

Deno.test({
  name: "test_revoke_marks_status_revoked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const ok = await store.revoke("tok-abc", "2026-06-19T12:00:00Z");
      assertEquals(ok, true);
      const got = await store.get("tok-abc");
      assertEquals(got?.status, "revoked");
      assertEquals(got?.revoked_at, "2026-06-19T12:00:00Z");
    });
  },
});

Deno.test({
  name: "test_revoke_unknown_returns_false",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      const ok = await store.revoke("tok-not-exist", "2026-06-19T12:00:00Z");
      assertEquals(ok, false);
    });
  },
});

Deno.test({
  name: "test_revoke_all_by_app_revokes_every_token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      for (const tid of ["tok-1", "tok-2", "tok-3"]) {
        await store.add({
          token_id: tid,
          app_id: "app-xyz",
          status: "active",
          issued_at: "2026-06-19T10:00:00Z",
          revoked_at: null,
          last_used_at: null,
        });
      }
      await store.add({
        token_id: "tok-other",
        app_id: "app-other",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const n = await store.revokeAllByApp("app-xyz", "2026-06-19T12:00:00Z");
      assertEquals(n, 3);
      // app-other 不受影响
      const other = await store.get("tok-other");
      assertEquals(other?.status, "active");
    });
  },
});

Deno.test({
  name: "test_list_returns_all",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-1",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      await store.add({
        token_id: "tok-2",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T11:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const list = await store.list();
      assertEquals(list.length, 2);
    });
  },
});

Deno.test({
  name: "test_list_by_app_filters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-1",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      await store.add({
        token_id: "tok-2",
        app_id: "app-other",
        status: "active",
        issued_at: "2026-06-19T11:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const list = await store.listByApp("app-xyz");
      assertEquals(list.length, 1);
      assertEquals(list[0].token_id, "tok-1");
    });
  },
});

Deno.test({
  name: "test_flush_persists_across_instances",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const tmp = await Deno.makeTempDir();
    const path = `${tmp}/tokens.json`;
    try {
      const store1 = new TokenStore(path);
      await store1.add({
        token_id: "tok-persist",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      await store1.flush();
      // 新实例加载
      const store2 = new TokenStore(path);
      const got = await store2.get("tok-persist");
      assertEquals(got?.app_id, "app-xyz");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "test_update_last_used",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withStore(async (store) => {
      await store.add({
        token_id: "tok-abc",
        app_id: "app-xyz",
        status: "active",
        issued_at: "2026-06-19T10:00:00Z",
        revoked_at: null,
        last_used_at: null,
      });
      const ok = await store.updateLastUsed("tok-abc", "2026-06-19T11:30:00Z");
      assertEquals(ok, true);
      const got = await store.get("tok-abc");
      assertEquals(got?.last_used_at, "2026-06-19T11:30:00Z");
    });
  },
});
