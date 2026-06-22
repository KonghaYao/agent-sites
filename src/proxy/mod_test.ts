// 反向代理单测，迁移自 crates/server/src/proxy/mod_test.rs
// 被测: src/proxy/mod.ts forward / rewriteCookiePath
//
// 测试隔离要点:
// - 端口隔离:mod_test 使用 23000-23799 段（apps_test 19000-20999 / mod_test 23000-23799 / lib_test 24000+）
// - 不涉及 PocketBase spawn:用 Deno.serve 起本地上游 HTTP（等价 Rust axum spawn_upstream）
// - 故无需 withTestSpawnLock / pbBinaryAvailable skip / init_superuser
// - 超大 body / 上游不存在 等纯逻辑路径不依赖网络
import { assertEquals } from "jsr:@std/assert@^1";
import { AppError } from "../error.ts";
import { DEFAULT_MAX_BODY_BYTES, forward, rewriteCookiePath } from "./mod.ts";

const MAX_BODY: number = DEFAULT_MAX_BODY_BYTES;

/** 起一个简单的上游 HTTP 服务，返回固定 JSON。
 *  等价 Rust spawn_upstream。返回 abort 供测试结束关闭。 */
function make_upstream(
  port: number,
  body: string,
  contentType = "application/json",
): { abort: AbortController } {
  const abort = new AbortController();
  Deno.serve({
    hostname: "127.0.0.1",
    port,
    signal: abort.signal,
    onListen: () => {},
  }, (_req) => {
    return new Response(body, {
      headers: { "content-type": contentType },
    });
  });
  return { abort };
}

/** 等上游 listener 就绪（Deno.serve 异步绑定）。
 *  等价 Rust tokio::sleep(100ms)。轮询 TCP 连通即可。 */
async function wait_upstream_ready(port: number, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  throw new Error(`上游 127.0.0.1:${port} 未在 ${timeoutMs}ms 内就绪`);
}

Deno.test("test_forward_get_透传响应", async () => {
  const port = 23001;
  const upstream = make_upstream(port, `{"hello":"world"}`);
  await wait_upstream_ready(port);
  try {
    const resp = await forward(
      port,
      "/api/echo",
      "GET",
      new Headers(),
      new Uint8Array(),
      MAX_BODY,
    );
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(text, `{"hello":"world"}`);
  } finally {
    upstream.abort.abort();
  }
});

Deno.test("test_forward_上游不存在_返回502", async () => {
  // 选一个几乎肯定没占用的端口；连接失败应抛 AppError(code=INTERNAL_ERROR)
  let caught: unknown;
  try {
    await forward(
      23999,
      "/api/whatever",
      "GET",
      new Headers(),
      new Uint8Array(),
      MAX_BODY,
    );
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof AppError)) {
    throw new Error(`连接失败应抛 AppError，实际 ${caught}`);
  }
  if (caught.code !== "INTERNAL_ERROR") {
    throw new Error(`期望 code=INTERNAL_ERROR，实际 ${caught.code}`);
  }
});

Deno.test("test_forward_透传查询参数", async () => {
  const port = 23002;
  const abort = new AbortController();
  Deno.serve(
    { hostname: "127.0.0.1", port, signal: abort.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      const id = url.searchParams.get("id") ?? "";
      return new Response(`{"id":"${id}"}`);
    },
  );
  await wait_upstream_ready(port);
  try {
    const resp = await forward(
      port,
      "/api/items?id=42",
      "GET",
      new Headers(),
      new Uint8Array(),
      MAX_BODY,
    );
    const text = await resp.text();
    assertEquals(text, `{"id":"42"}`);
  } finally {
    abort.abort();
  }
});

// Issue #3：body 大小限制测试
Deno.test("test_forward_请求体超过上限_返回413", async () => {
  const port = 23003;
  const upstream = make_upstream(port, `{"hello":"world"}`);
  await wait_upstream_ready(port);
  try {
    // 限制为 10 字节，发送 100 字节
    const bigBody = new Uint8Array(100).fill("a".charCodeAt(0));
    let caught: unknown;
    try {
      await forward(
        port,
        "/api/echo",
        "POST",
        new Headers(),
        bigBody,
        10,
      );
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof AppError)) {
      throw new Error("超大 body 应抛 AppError");
    }
    if (caught.code !== "PAYLOAD_TOO_LARGE") {
      throw new Error(`期望 code=PAYLOAD_TOO_LARGE，实际 ${caught.code}`);
    }
  } finally {
    upstream.abort.abort();
  }
});

// Issue #1：cookie 路径隔离测试
Deno.test("test_forward_上游_set_cookie_被改写到_app_前缀", async () => {
  const port = 23004;
  const abort = new AbortController();
  Deno.serve(
    { hostname: "127.0.0.1", port, signal: abort.signal, onListen: () => {} },
    () => {
      return new Response("ok", {
        headers: {
          "set-cookie": "session=abc123; Path=/; HttpOnly; SameSite=Lax",
        },
      });
    },
  );
  await wait_upstream_ready(port);
  try {
    const resp = await forward(
      port,
      "/api/login",
      "GET",
      new Headers(),
      new Uint8Array(),
      MAX_BODY,
      "app-abcdef12",
    );
    const setCookie = resp.headers.get("set-cookie") ?? "";
    assertEquals(
      setCookie.includes("Path=/app-abcdef12"),
      true,
      `Path 应被改写到 app 前缀，实际: ${setCookie}`,
    );
    assertEquals(
      setCookie.includes("Path=/;"),
      false,
      `原 Path=/ 不应残留，实际: ${setCookie}`,
    );
    assertEquals(
      setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"),
      true,
      `其余 cookie 属性应保留，实际: ${setCookie}`,
    );
  } finally {
    abort.abort();
  }
});

// cookie 改写器单元测试（不依赖网络）
Deno.test("test_rewrite_cookie_path_替换已有_path", () => {
  const raw = "session=abc123; Path=/; HttpOnly";
  const out = rewriteCookiePath(raw, "app-abc111");
  assertEquals(out.includes("Path=/app-abc111"), true, `out = ${out}`);
  assertEquals(out.includes("Path=/;"), false, `out = ${out}`);
  assertEquals(out.includes("HttpOnly"), true, `out = ${out}`);
});

Deno.test("test_rewrite_cookie_path_无_path_补一个", () => {
  const raw = "session=abc123; HttpOnly";
  const out = rewriteCookiePath(raw, "app-abc111");
  assertEquals(out.includes("Path=/app-abc111"), true, `out = ${out}`);
  assertEquals(out.includes("HttpOnly"), true, `out = ${out}`);
});

// Issue agent-pov B1：上游返 204/304 时不附 body
Deno.test("test_forward_上游_204_无_body", async () => {
  const port = 23010;
  const abort = new AbortController();
  Deno.serve(
    { hostname: "127.0.0.1", port, signal: abort.signal, onListen: () => {} },
    () => new Response(null, { status: 204 }),
  );
  await wait_upstream_ready(port);
  try {
    const resp = await forward(
      port,
      "/api/items/1",
      "DELETE",
      new Headers(),
      new Uint8Array(),
      MAX_BODY,
    );
    assertEquals(resp.status, 204);
    const text = await resp.text();
    assertEquals(text, "", "204 响应必须无 body");
  } finally {
    abort.abort();
  }
});

Deno.test("test_forward_上游_304_无_body", async () => {
  const port = 23011;
  const abort = new AbortController();
  Deno.serve(
    { hostname: "127.0.0.1", port, signal: abort.signal, onListen: () => {} },
    () =>
      new Response(null, {
        status: 304,
        headers: { etag: '"abc"' },
      }),
  );
  await wait_upstream_ready(port);
  try {
    const resp = await forward(
      port,
      "/api/items/1",
      "GET",
      new Headers(),
      new Uint8Array(),
      MAX_BODY,
    );
    assertEquals(resp.status, 304);
    const text = await resp.text();
    assertEquals(text, "", "304 响应必须无 body");
    assertEquals(resp.headers.get("etag"), '"abc"');
  } finally {
    abort.abort();
  }
});

Deno.test("test_rewrite_cookie_path_大小写无关", () => {
  const raw = "session=abc123; path=/; HttpOnly";
  const out = rewriteCookiePath(raw, "app-abc111");
  assertEquals(out.includes("Path=/app-abc111"), true, `out = ${out}`);
});
