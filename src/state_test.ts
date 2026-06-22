// AppState 新增字段的单测
import { assertEquals } from "jsr:@std/assert@^1";
import { AppState } from "./state.ts";
import { AppStore } from "./app/store.ts";
import { TokenStore } from "./auth/token_store.ts";
import { PbTokenCache } from "./auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "./process/mod.ts";

Deno.test({
  name: "test_appstate_holds_master_key_and_token_store",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const store = new AppStore("/tmp/test-apps.json", 9000, 11000);
    const tokenStore = new TokenStore("/tmp/test-tokens.json");
    const pbTokenCache = new PbTokenCache();
    const pm = new PocketBaseProcessManager("/tmp/pb");
    const state = new AppState(
      "/tmp/pb",
      "/tmp/data",
      "/tmp/public",
      store,
      pm,
      50,
      9000,
      11000,
      "my-master-key",
      tokenStore,
      pbTokenCache,
    );
    assertEquals(state.masterKey, "my-master-key");
    assertEquals(state.tokenStore, tokenStore);
    assertEquals(state.pbTokenCache, pbTokenCache);
  },
});
