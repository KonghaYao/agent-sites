// pb_token_cache 单测
// 被测：src/auth/pb_token_cache.ts
// 验证：凭证代换 + 缓存 + 过期重新换
import { assertEquals } from "jsr:@std/assert@^1";
import { PbTokenCache } from "./pb_token_cache.ts";

/** 起一个假 PocketBase HTTP 服务，记录被调次数，返回固定 token。 */
// deno-lint-ignore require-await
async function startFakePb(
  responses: { status: number; body: string }[] = [
    { status: 200, body: JSON.stringify({ token: "pb-token-1" }) },
  ],
): Promise<{
  port: number;
  calls: { path: string; body: string }[];
  stop: () => Promise<void>;
}> {
  const calls: { path: string; body: string }[] = [];
  let idx = 0;
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      calls.push({ path: url.pathname, body });
      const resp = responses[Math.min(idx, responses.length - 1)];
      idx++;
      return new Response(resp.body, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    calls,
    stop: async () => {
      controller.abort();
      await server.finished.catch(() => {});
    },
  };
}

Deno.test({
  name: "test_first_call_fetches_pb_token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb();
    try {
      const cache = new PbTokenCache();
      const token = await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      assertEquals(token, "pb-token-1");
      assertEquals(fake.calls.length, 1);
      assertEquals(fake.calls[0].path, "/api/collections/_superusers/auth-with-password");
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "test_second_call_uses_cache_no_fetch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb();
    try {
      const cache = new PbTokenCache();
      await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      assertEquals(fake.calls.length, 1);
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "test_invalidate_forces_refetch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb([
      { status: 200, body: JSON.stringify({ token: "pb-token-1" }) },
      { status: 200, body: JSON.stringify({ token: "pb-token-2" }) },
    ]);
    try {
      const cache = new PbTokenCache();
      const t1 = await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      cache.invalidate(`http://localhost:${fake.port}`);
      const t2 = await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "pw");
      assertEquals(t1, "pb-token-1");
      assertEquals(t2, "pb-token-2");
      assertEquals(fake.calls.length, 2);
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "test_fetch_failure_throws",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakePb([
      { status: 401, body: JSON.stringify({ message: "invalid credentials" }) },
    ]);
    try {
      const cache = new PbTokenCache();
      let threw = false;
      try {
        await cache.get(`http://localhost:${fake.port}`, "admin@x.local", "wrong");
      } catch (_e) {
        threw = true;
      }
      assertEquals(threw, true);
    } finally {
      await fake.stop();
    }
  },
});
