// 批量前端文件上传 POST /api/apps/{id}/files/bundle 单测
// 被测：src/api/files_bundle.ts + src/lib.ts 路由
//
// 测试隔离：
//   - 端口段 27200-27999（与 files_test.ts 的 26xxx 互不重叠）
//   - 涉及真实 PB spawn 用 withTestSpawnLock + pbBinaryAvailable skip
//   - 每用例独立 Deno.makeTempDir()，结束 Deno.remove(recursive)
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@^0.1.10/tar-stream";
import { AppStore } from "../app/store.ts";
import { TokenStore } from "../auth/token_store.ts";
import { PbTokenCache } from "../auth/pb_token_cache.ts";
import { PocketBaseProcessManager } from "../process/mod.ts";
import { AppState } from "../state.ts";
import { createApp as makeRouter } from "../lib.ts";
import { pbBinaryAvailable, pbBinaryPath, withTestSpawnLock } from "../process/pocketbase.ts";

const MASTER_KEY = "test-master-key-fixed-0123456789abcdef";

async function makeState(
  tmp: string,
  portMin = 27200,
  portMax = 27300,
): Promise<AppState> {
  const dataDir = `${tmp}/data`;
  const publicDir = `${tmp}/public`;
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.mkdir(publicDir, { recursive: true });
  return new AppState(
    pbBinaryPath(),
    dataDir,
    publicDir,
    new AppStore(`${dataDir}/apps.json`, portMin, portMax),
    new PocketBaseProcessManager(pbBinaryPath()),
    50,
    portMin,
    portMax,
    MASTER_KEY,
    new TokenStore(`${dataDir}/tokens.json`),
    new PbTokenCache(),
  );
}

function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn,
  });
}

/** 构造 gzip 压缩 tar 归档（Uint8Array）。 */
async function makeTarGz(
  files: { path: string; content: Uint8Array }[],
): Promise<Uint8Array> {
  const inputs: TarStreamInput[] = files.map((f) => ({
    type: "file" as const,
    path: f.path,
    size: f.content.byteLength,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(f.content);
        controller.close();
      },
    }),
  }));
  const compressed = ReadableStream.from<TarStreamInput>(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const c of compressed) chunks.push(c);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const enc = new TextEncoder();
function b(s: string): Uint8Array {
  return enc.encode(s);
}

/** 通过 handler 建一个 app，返回 appId。 */
async function createApp(
  handler: (req: Request) => Promise<Response>,
  name: string,
): Promise<string> {
  const resp = await handler(
    new Request("http://x/api/apps", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Master-Key": MASTER_KEY,
      },
      body: JSON.stringify({ name }),
    }),
  );
  const j = await resp.json();
  if (!j.data) {
    throw new Error(`createApp 失败 name=${name} status=${resp.status} body=${JSON.stringify(j)}`);
  }
  return j.data.id;
}

// ---------------------------------------------------------------------------
// 成功场景
// ---------------------------------------------------------------------------

test("test_upload_bundle_成功_解压多个文件", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 27200, 27300);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle1");

      const tarGz = await makeTarGz([
        { path: "index.html", content: b("<h1>home</h1>") },
        { path: "assets/app.js", content: b("console.log('app')") },
        { path: "assets/style.css", content: b("body{color:red}") },
      ]);

      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 200);
      const body = await resp.json();
      assertEquals(body.error, null);
      assertEquals(body.data.total_files, 3);
      assertEquals(body.data.files.length, 3);
      const totalExpected = "<h1>home</h1>".length + "console.log('app')".length +
        "body{color:red}".length;
      assertEquals(body.data.total_bytes, totalExpected);

      // 落盘验证：GET 静态文件能读到上传内容
      // HTML 会注入 fetch shim，故用 includes 校验
      const idx = await handler(new Request(`http://x/${appId}/index.html`));
      assertEquals(idx.status, 200);
      const idxText = await idx.text();
      assert(
        idxText.includes("<h1>home</h1>"),
        `HTML GET 应含上传内容: ${idxText}`,
      );
      assert(
        idxText.includes("window.fetch = function"),
        `HTML GET 应注入 fetch shim: ${idxText}`,
      );
      const js = await handler(new Request(`http://x/${appId}/assets/app.js`));
      assertEquals(js.status, 200);
      assertEquals(await js.text(), "console.log('app')");
      const css = await handler(new Request(`http://x/${appId}/assets/style.css`));
      assertEquals(css.status, 200);
      assertEquals(await css.text(), "body{color:red}");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 错误场景（不依赖 PB，直接构造 store 中的 app 记录省略 spawn）
// 但 createApp 需要 spawn PB。对不需要 PB 的错误用例，走"app 不存在 / 鉴权"
// 这类前置校验，避免 spawn 开销。
// ---------------------------------------------------------------------------

test("test_upload_bundle_app_不存在_404", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const tarGz = await makeTarGz([
      { path: "index.html", content: b("<h1>x</h1>") },
    ]);
    const resp = await handler(
      new Request("http://x/api/apps/app-notexist/files/bundle", {
        method: "POST",
        headers: {
          "content-type": "application/gzip",
          "X-Master-Key": MASTER_KEY,
        },
        body: new Blob([tarGz as BlobPart]),
      }),
    );
    assertEquals(resp.status, 404);
    const body = await resp.json();
    assertEquals(body.error.code, "NOT_FOUND");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_upload_bundle_缺_master_key_401", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const state = await makeState(tmp);
    const handler = makeRouter(state);
    const tarGz = await makeTarGz([
      { path: "index.html", content: b("<h1>x</h1>") },
    ]);
    const resp = await handler(
      new Request("http://x/api/apps/app-xxx/files/bundle", {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: new Blob([tarGz as BlobPart]),
      }),
    );
    assertEquals(resp.status, 401);
    const body = await resp.json();
    assertEquals(body.error.code, "UNAUTHORIZED");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

test("test_upload_bundle_非_gzip_400", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 27400, 27500);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-nongz");

      // 普通文本 body（非 gzip）
      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "X-Master-Key": MASTER_KEY,
          },
          body: "this is not gzip",
        }),
      );
      assertEquals(resp.status, 400);
      const body = await resp.json();
      assertEquals(body.error.code, "BAD_REQUEST");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_upload_bundle_路径穿越_400", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 27600, 27700);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-traversal");

      // tar 内 path 直接含 .. 段（不经 URL 归一化）
      const tarGz = await makeTarGz([
        { path: "../evil.txt", content: b("evil") },
      ]);
      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 400);
      const body = await resp.json();
      assertEquals(body.error.code, "BAD_REQUEST");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_upload_bundle_非白名单后缀_400", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 27800, 27900);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-ext");

      const tarGz = await makeTarGz([
        { path: "bad.exe", content: b("MZ") },
      ]);
      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 400);
      const body = await resp.json();
      assertEquals(body.error.code, "BAD_REQUEST");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_upload_bundle_条目过多_400", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 28000, 28100);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-many");

      // 201 个小文件（超过 MAX_BUNDLE_ENTRIES=200）
      const files: { path: string; content: Uint8Array }[] = [];
      for (let i = 0; i < 201; i++) {
        files.push({ path: `f${i}.txt`, content: b("x") });
      }
      const tarGz = await makeTarGz(files);
      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 400);
      const body = await resp.json();
      assertEquals(body.error.code, "BAD_REQUEST");
      // 错误消息应含「已写入 200 个」（前 200 个已写入，第 201 个触发）
      assertEquals(
        typeof body.error.message === "string" && body.error.message.includes("200"),
        true,
        `错误消息应含已写入文件数: ${body.error.message}`,
      );

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_upload_bundle_压缩体超限_413", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 28200, 28300);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-big-compressed");

      // 11 MiB 随机内容（随机不可压缩 → 压缩后仍 > 10 MiB）
      const big = new Uint8Array(11 * 1024 * 1024);
      // 用 crypto 填随机字节（分块绕开 getRandomValues 65536 字节限制）
      for (let off = 0; off < big.byteLength; off += 65536) {
        crypto.getRandomValues(big.subarray(off, Math.min(off + 65536, big.byteLength)));
      }
      const tarGz = await makeTarGz([
        { path: "big.txt", content: big },
      ]);

      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 413);
      const body = await resp.json();
      // 可能是压缩体超限（413）或解压后单文件超限（413，5MiB）
      assertEquals(body.error.code, "PAYLOAD_TOO_LARGE");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_upload_bundle_解压后超限_413", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 28400, 28500);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-zipbomb");

      // zip bomb：高压缩比全 0 字节，解压后超 50 MiB
      // 单文件上限是 5 MiB，故用多个 5 MiB 文件（>10 个 → >50 MiB）
      // 每个文件用独立 buffer，避免 TarStream 内部流复用坑
      const files: { path: string; content: Uint8Array }[] = [];
      for (let i = 0; i < 11; i++) {
        files.push({ path: `z${i}.txt`, content: new Uint8Array(5 * 1024 * 1024) });
      }
      const tarGz = await makeTarGz(files);

      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 413);
      const body = await resp.json();
      assertEquals(body.error.code, "PAYLOAD_TOO_LARGE");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tar -C dir . 标准打包兼容（R2 M1）
// ---------------------------------------------------------------------------

test("test_upload_bundle_接受 tar_C_dir_格式", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 28600, 28700);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundletarc");

      // 模拟 `tar -C dir .` 标准打包：
      //   ./                    （顶层目录 entry，由目录跳过逻辑处理）
      //   ./index.html          （文件 entry，需 . 规范化）
      //   ./sub/app.js          （嵌套子目录）
      //   .                     （理论上罕见，但也应被跳过/规范化）
      const tarGz = await makeTarGz([
        { path: "./", content: new Uint8Array(0) },
        { path: "./index.html", content: b("<h1>home</h1>") },
        { path: "./sub/app.js", content: b("console.log('a')") },
        { path: ".", content: new Uint8Array(0) },
      ]);

      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 200);
      const body = await resp.json();
      assertEquals(body.error, null);
      assertEquals(body.data.total_files, 2);
      // 落盘验证：相对路径不带 ./
      const js = await handler(new Request(`http://x/${appId}/sub/app.js`));
      assertEquals(js.status, 200);
      assertEquals(await js.text(), "console.log('a')");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

test("test_upload_bundle_成功响应含 total_bytes_limit", async () => {
  if (!pbBinaryAvailable()) {
    console.warn("跳过：pocketbase 二进制不可用");
    return;
  }
  await withTestSpawnLock(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const state = await makeState(tmp, 28800, 28900);
      const handler = makeRouter(state);
      const appId = await createApp(handler, "bundle-limit-field");

      const tarGz = await makeTarGz([
        { path: "index.html", content: b("<h1>x</h1>") },
      ]);
      const resp = await handler(
        new Request(`http://x/api/apps/${appId}/files/bundle`, {
          method: "POST",
          headers: {
            "content-type": "application/gzip",
            "X-Master-Key": MASTER_KEY,
          },
          body: new Blob([tarGz as BlobPart]),
        }),
      );
      assertEquals(resp.status, 200);
      const body = await resp.json();
      // total_bytes_limit 字段告知 agent 上限（50 MiB = 52428800）
      assertEquals(body.data.total_bytes_limit, 52428800);
      assertEquals(typeof body.data.total_bytes, "number");

      await handler(
        new Request(`http://x/api/apps/${appId}`, {
          method: "DELETE",
          headers: { "X-Master-Key": MASTER_KEY },
        }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});
