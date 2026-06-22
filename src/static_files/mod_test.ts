// 静态文件服务单测，迁移自 crates/server/src/static_files/mod_test.rs
// 被测: src/static_files/mod.ts serveFileFromRoot
// 说明: 纯文件系统操作，无 spawn/PocketBase/端口分配，无需 TEST_SPAWN_LOCK 或 pbBinaryAvailable skip
// tempfile 用 Deno.makeTempDir()，测试结束 Deno.remove recursive 清理（对应 tempfile::TempDir 析构）
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { AppError } from "../error.ts";
import { serveFileFromRoot } from "./mod.ts";

/** 创建临时目录并返回清理函数。对应 Rust tempfile::tempdir()。 */
async function makeTempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir();
  return {
    root,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("test_读取存在的文件_返回内容", async () => {
  // Arrange: root/index.html + root/assets/main.js
  const { root, cleanup } = await makeTempRoot();
  try {
    await Deno.writeTextFile(`${root}/index.html`, "<h1>hi</h1>");
    await Deno.mkdir(`${root}/assets`, { recursive: true });
    await Deno.writeTextFile(`${root}/assets/main.js`, "console.log(1)");
    // Act
    const resp = await serveFileFromRoot(root, "index.html");
    // Assert
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(text, "<h1>hi</h1>");
  } finally {
    await cleanup();
  }
});

Deno.test("test_读取子目录文件", async () => {
  // Arrange: root/assets/main.js
  const { root, cleanup } = await makeTempRoot();
  try {
    await Deno.mkdir(`${root}/assets`, { recursive: true });
    await Deno.writeTextFile(`${root}/assets/main.js`, "console.log(1)");
    // Act
    const resp = await serveFileFromRoot(root, "assets/main.js");
    // Assert
    const text = await resp.text();
    assertEquals(text, "console.log(1)");
  } finally {
    await cleanup();
  }
});

Deno.test("test_文件不存在_返回_not_found_错误", async () => {
  // Arrange
  const { root, cleanup } = await makeTempRoot();
  try {
    // Act + Assert: 应抛 NotFound（AppError 实例，code/status 正确）
    let thrown: unknown;
    try {
      await serveFileFromRoot(root, "missing.html");
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof AppError, "应为 AppError 实例");
    assertEquals((thrown as AppError).code, "NOT_FOUND");
    assertEquals((thrown as AppError).status, 404);
  } finally {
    await cleanup();
  }
});

Deno.test("test_路径穿越攻击_拒绝", async () => {
  // Arrange: root 外放敏感文件，尝试 ../ 读取
  const { root, cleanup } = await makeTempRoot();
  try {
    // root 形如 /tmp/.tmpXXXX，parent 即 /tmp/.tmpXXXX 的父目录
    const parent = root.substring(0, root.lastIndexOf("/"));
    await Deno.writeTextFile(`${parent}/.static_files_secret.txt`, "topsecret");
    // Act + Assert: 穿越路径必须被拒绝
    let threw = false;
    try {
      await serveFileFromRoot(root, "../.static_files_secret.txt");
    } catch {
      threw = true;
    }
    assert(threw, "穿越路径必须被拒绝");
    // 清理父目录里创建的敏感文件，避免污染 /tmp
    await Deno.remove(`${parent}/.static_files_secret.txt`).catch(() => {});
  } finally {
    await cleanup();
  }
});

Deno.test("test_空路径_默认_index_html", async () => {
  // Arrange: root/index.html
  const { root, cleanup } = await makeTempRoot();
  try {
    await Deno.writeTextFile(`${root}/index.html`, "<h1>root</h1>");
    // Act
    const resp = await serveFileFromRoot(root, "");
    // Assert
    const text = await resp.text();
    assertEquals(text, "<h1>root</h1>");
  } finally {
    await cleanup();
  }
});

Deno.test("test_html_文件_content_type_正确", async () => {
  // Arrange
  const { root, cleanup } = await makeTempRoot();
  try {
    await Deno.writeTextFile(`${root}/page.html`, "<p>x</p>");
    // Act
    const resp = await serveFileFromRoot(root, "page.html");
    // Assert
    const ct = resp.headers.get("content-type");
    assert(ct !== null, "content-type 头应存在");
    assert(ct.includes("text/html"), `期望包含 text/html，实际 ${ct}`);
  } finally {
    await cleanup();
  }
});

Deno.test("test_js_文件_content_type_正确", async () => {
  // Arrange
  const { root, cleanup } = await makeTempRoot();
  try {
    await Deno.writeTextFile(`${root}/app.js`, "// x");
    // Act
    const resp = await serveFileFromRoot(root, "app.js");
    // Assert
    const ct = resp.headers.get("content-type");
    assert(ct !== null, "content-type 头应存在");
    assert(ct.includes("javascript"), `期望包含 javascript，实际 ${ct}`);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// fetch shim 注入（agent-pov R2 B1）
// ---------------------------------------------------------------------------

Deno.test("test_serve_html_注入 fetch shim", async () => {
  // Arrange: HTML 含 <head>，serve 时传 appId
  const { root, cleanup } = await makeTempRoot();
  try {
    const html = "<html><head></head><body>fetch('/api/x')</body></html>";
    await Deno.writeTextFile(`${root}/index.html`, html);
    // Act
    const resp = await serveFileFromRoot(root, "index.html", {
      appId: "app-abc123",
    });
    // Assert
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assert(
      text.includes("window.fetch = function"),
      `body 应含 fetch shim: ${text}`,
    );
    assert(
      text.includes('"/app-abc123"'),
      `shim 应嵌入 PREFIX=/app-abc123: ${text}`,
    );
    // 原内容应保留
    assert(text.includes("fetch('/api/x')"), `原 HTML 应保留: ${text}`);
    // shim 应位于 <head> 之后
    const headIdx = text.toLowerCase().indexOf("<head>");
    const shimIdx = text.indexOf("window.fetch");
    assert(headIdx >= 0 && shimIdx > headIdx, "shim 应在 <head> 之后");
  } finally {
    await cleanup();
  }
});

Deno.test("test_serve_html_无 head_注入开头", async () => {
  // Arrange: HTML 不含 <head> 标签
  const { root, cleanup } = await makeTempRoot();
  try {
    const html = "<html><body>hi</body></html>";
    await Deno.writeTextFile(`${root}/page.html`, html);
    // Act
    const resp = await serveFileFromRoot(root, "page.html", {
      appId: "app-xyz",
    });
    // Assert
    const text = await resp.text();
    assert(text.includes("window.fetch = function"), "应注入 shim");
    // shim 应在文件开头（<html> 之前）
    const htmlIdx = text.toLowerCase().indexOf("<html>");
    const shimIdx = text.indexOf("window.fetch");
    assert(shimIdx < htmlIdx, `shim 应在 <html> 之前: shimIdx=${shimIdx} htmlIdx=${htmlIdx}`);
  } finally {
    await cleanup();
  }
});

Deno.test("test_serve_non_html_不注入 shim", async () => {
  // Arrange: JS + CSS 文件，传 appId 也不应注入
  const { root, cleanup } = await makeTempRoot();
  try {
    await Deno.writeTextFile(`${root}/app.js`, "fetch('/api/x')");
    await Deno.writeTextFile(`${root}/style.css`, "body{}");
    // Act + Assert: JS
    const jsResp = await serveFileFromRoot(root, "app.js", {
      appId: "app-abc123",
    });
    const jsText = await jsResp.text();
    assertEquals(jsText, "fetch('/api/x')");
    assert(!jsText.includes("window.fetch"), "JS 不应注入 shim");
    // Act + Assert: CSS
    const cssResp = await serveFileFromRoot(root, "style.css", {
      appId: "app-abc123",
    });
    const cssText = await cssResp.text();
    assertEquals(cssText, "body{}");
  } finally {
    await cleanup();
  }
});

Deno.test("test_serve_html_无 appId_不注入 shim", async () => {
  // Arrange: 不传 appId（向后兼容旧调用）
  const { root, cleanup } = await makeTempRoot();
  try {
    const html = "<html><head></head><body>x</body></html>";
    await Deno.writeTextFile(`${root}/index.html`, html);
    // Act
    const resp = await serveFileFromRoot(root, "index.html");
    // Assert
    const text = await resp.text();
    assertEquals(text, html);
    assert(!text.includes("window.fetch"), "无 appId 不应注入");
  } finally {
    await cleanup();
  }
});

Deno.test("test_serve_html_大小写 head 标签_注入", async () => {
  // Arrange: <HEAD> 大写（HTML 不区分大小写）
  const { root, cleanup } = await makeTempRoot();
  try {
    const html = "<html><HEAD></HEAD><body>x</body></html>";
    await Deno.writeTextFile(`${root}/index.html`, html);
    // Act
    const resp = await serveFileFromRoot(root, "index.html", {
      appId: "app-test",
    });
    // Assert
    const text = await resp.text();
    assert(text.includes("window.fetch = function"), "大写 HEAD 也应注入");
    // 注入位置：在 <HEAD> 后
    const headIdx = text.toUpperCase().indexOf("<HEAD>");
    const shimIdx = text.indexOf("window.fetch");
    assert(shimIdx > headIdx, "shim 应在 <HEAD> 之后");
  } finally {
    await cleanup();
  }
});
