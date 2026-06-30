// App 管理 REST API handler（/apps 端点的 CRUD）。
//
// 由 crates/server/src/api/apps.rs 1:1 迁移而来。
// 对应 Rust api/mod.rs 中的路由声明：
//   POST   /apps        → createApp
//   GET    /apps        → listApps
//   GET    /apps/{id}   → getApp
//   DELETE /apps/{id}   → deleteApp
//
// 翻译决策（DESIGN CONTEXT）：
// - axum `State<Arc<AppState>>` + `Json<T>` extractor → 统一 Handler 签名
//   `(req: Request, ctx: Ctx) => Promise<Response>`，ctx 携带 AppState 引用 +
//   URL 路径参数 + requestId。这里只读 ctx.state（list/get/delete 还会读
//   ctx.params.id）。
// - axum::Json(serde_json::json!) → Response.json(body)
// - chrono::Utc::now().to_rfc3339() → new Date().toISOString()（同样是 RFC3339）
// - uuid::Uuid::new_v4().simple() → crypto.randomUUID().replace(/-/g, "")
// - spawn_blocking(init_superuser) → 直接同步调用 initSuperuser（Deno 单线程
//   事件循环，子进程 outputSync 不阻塞其他异步任务的进度推进）
// - Result<Json<Value>, AppError> → 成功 return Response；失败 throw AppError
//   （由 lib.ts 的 makeTraceMiddleware 统一 catch → toResponse()）
// - tokio::fs::create_dir_all / remove_dir_all → await Deno.mkdir / Deno.remove
// - PathBuf.join → 模板字符串拼路径
// - tracing::warn! → console.warn（CLAUDE.md 禁 println!/eprintln!）
// - normalize_name：字符级校验用 [...trimmed].length <= 32（CJK 安全，
//   CLAUDE.md 字符级操作要求）+ ASCII 范围显式判断避免 \w Unicode 陷阱

import type { App } from "../app/model.ts";
import { generateId } from "../app/model.ts";
import type { AppStore } from "../app/store.ts";
import { AppError } from "../error.ts";
import { initSuperuser } from "../process/pocketbase.ts";
import { PortAllocator } from "../process/port_allocator.ts";
import type { AppState } from "../state.ts";
import { revokeAllTokensByApp } from "./tokens.ts";

// ---------------------------------------------------------------------------
// Ctx / Handler 公共类型（与 lib.ts 共享，本模块先定义并 export）
// ---------------------------------------------------------------------------

/**
 * Handler 调用上下文（DESIGN CONTEXT）。
 *
 * 携带 AppState 引用 + URL 路径参数 + requestId。
 * Deno 单线程事件循环天然共享，无需 Arc clone；ctx 通过引用传递。
 */
export interface Ctx {
  /** 全局共享状态引用 */
  state: AppState;
  /** URL 路径参数（如 { id: "app-abcd1234" }） */
  params: Record<string, string>;
  /** 本次请求 ID（trace middleware 注入，crypto.randomUUID().slice(0,8)） */
  requestId: string;
}

/** 统一 Handler 签名：(req, ctx) => Promise<Response> */
export type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** 创建 App 请求体（对应 Rust CreateAppRequest）。 */
export interface CreateAppRequest {
  name?: string;
  type?: "pocketbase" | "custom";
}

/** App 响应体（不含任何敏感字段——凭证仅存内部 store，不外露）。 */
export interface AppResponse {
  id: string;
  name: string;
  type: string;
  port: number;
  status: string;
  api_path: string;
  created_at: string;
}

/**
 * 把内部 App 实体转成对外 AppResponse（对应 Rust `impl From<&App> for AppResponse`）。
 *
 * api_path 按 type 区分：
 * - pocketbase → `/{id}/api`（PB API 入口）
 * - custom → `/{id}`（自定义应用根路径）
 * status 取字符串形式（Rust as_str → TS 字面量本身就是 string）。
 * 注意：superuser_email/password 不外露——凭证代换走 platform token，
 * 由 /api/tokens 签发，凭证本身只在内部 store 中。
 */
export function toAppResponse(a: App): AppResponse {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    port: a.port,
    status: a.status,
    api_path: a.type === "custom" ? `/${a.id}` : `/${a.id}/api`,
    created_at: a.created_at,
  };
}

// ---------------------------------------------------------------------------
// 名字规范化
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 name（对应 Rust normalize_name）。
 *
 * - trim 后为空 → 返回 ""（调用方处理为 fallback：用 id 当 name）
 * - 仅允许 a-z / 0-9 / '-'，字符级长度 1..32
 * - 非法 → 抛 AppError.BadRequest
 *
 * 字符级长度用 [...trimmed].length（CJK 安全，CLAUDE.md 字符级操作要求）；
 * 字符校验显式 ASCII 范围，避免 \w 的 Unicode-aware 陷阱。
 */
export function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return ""; // 调用方处理为 fallback
  }
  const chars = [...trimmed];
  const ok = chars.length <= 32 &&
    chars.every((c) => {
      const code = c.charCodeAt(0);
      // a-z
      const isLower = code >= 0x61 && code <= 0x7a;
      // 0-9
      const isDigit = code >= 0x30 && code <= 0x39;
      // '-'
      const isDash = c === "-";
      return isLower || isDigit || isDash;
    });
  if (!ok) {
    throw AppError.BadRequest("name 只允许 a-z 0-9 -，长度 1..32");
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /apps —— 创建 App（含 spawn PocketBase + 预置 superuser）。
 *
 * 流程（与 Rust create_app 1:1）：
 * 1. 上限检查（current >= max_apps → Conflict）
 * 2. normalize name（空则后续用 id 作 fallback）
 * 3. addIfAbsent 原子插入占位（Issue #5：避免 TOCTOU），最多重试若干次
 * 4. flush 占位记录（让其他请求可见到 Starting）
 * 5. 创建数据目录 + initSuperuser（spawn 前）
 * 6. processManager.start（端口分配 + spawn + 健康检查）
 * 7. 成功 → 更新 Running + 凭证 + flush；失败 → 移除占位 + 删目录
 */
export async function createApp(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const state = ctx.state;

  // 上限检查
  const currentCount = (await state.store.list()).length;
  if (currentCount >= state.maxApps) {
    throw AppError.Conflict(`App 数量已达上限 ${state.maxApps}`);
  }

  // 解析请求体 + 规范化 name
  //
  // 兼容矩阵（agent-pov R2 M3）：
  // - Content-Type: application/json + 合法 JSON（含空 {}）→ 正常解析
  // - Content-Type: application/json + 非法 JSON → 400（fail-fast，
  //   避免客户端字段名 typo 被静默吞掉）
  // - 无 Content-Type 或非 JSON（text-plain 等）→ 把 body 当空处理（保持兼容）
  // - 任意 Content-Type + 空 body（GET/无 body POST）→ 当空处理
  //
  // 先读取原始字节判定是否为空 body（Deno Request 不预设 Content-Length，
  // 无法仅靠 header 判定），再决定是否尝试 JSON 解析。
  let requestBody: CreateAppRequest = {};
  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().startsWith("application/json");
  let rawBody: Uint8Array = new Uint8Array(0);
  if (req.body !== null) {
    try {
      const buf = await req.arrayBuffer();
      rawBody = new Uint8Array(buf);
    } catch {
      rawBody = new Uint8Array(0);
    }
  }
  const hasBody = rawBody.byteLength > 0;
  if (hasBody && isJson) {
    try {
      requestBody = JSON.parse(
        new TextDecoder().decode(rawBody),
      ) as CreateAppRequest;
    } catch (e) {
      throw AppError.BadRequest(
        `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const name = requestBody.name !== undefined ? normalizeName(requestBody.name) : "";
  const appType: "pocketbase" | "custom" = requestBody.type === "custom" ? "custom" : "pocketbase";

  // 分配 id（Issue #5：用 addIfAbsent 原子 check+insert，避免 TOCTOU）
  const allocator = new PortAllocator(state.portMin, state.portMax);
  const makePlaceholder = (id: string): App => {
    const now = new Date().toISOString();
    return {
      id,
      name: name.length === 0 ? id : name,
      type: appType,
      port: 0,
      status: "starting",
      created_at: now,
      updated_at: now,
      superuser_email: "",
      superuser_password: "",
    };
  };
  let id = generateId();
  let app = makePlaceholder(id);
  while (!(await state.store.addIfAbsent(app))) {
    id = generateId();
    app = makePlaceholder(id);
  }

  // 持久化占位（让其他请求可见到 Starting 记录）
  try {
    await state.store.flush();
  } catch (e) {
    throw AppError.Internal(`持久化失败: ${e}`);
  }

  // custom 类型：只创建目录 + 标记 running，不需要 PocketBase
  if (appType === "custom") {
    const dataDir = `${state.dataDir}/${id}`;
    await Deno.mkdir(dataDir, { recursive: true });
    await Deno.mkdir(`${dataDir}/runtime`, { recursive: true });

    app.status = "running";
    app.updated_at = new Date().toISOString();
    await state.store.update(app);
    await state.store.flush();

    const resp = toAppResponse(app);
    return Response.json({ data: resp, error: null });
  }

  // 数据目录 + superuser 凭证
  const dataDir = `${state.dataDir}/${id}`;
  const superuserEmail = `admin@${id}.local`;
  const superuserPassword = crypto.randomUUID().replace(/-/g, "");

  // 1. 创建目录（initSuperuser 不创建父目录）
  try {
    await Deno.mkdir(dataDir, { recursive: true });
  } catch (e) {
    // 占位记录清理（容错）
    await state.store.remove(app.id);
    await state.store.flush().catch(() => {});
    throw AppError.Internal(`创建数据目录失败: ${e}`);
  }

  // 2. 预置 superuser（spawn 前）
  //    Rust 用 spawn_blocking 包装同步 std::process::Command 调用，
  //    Deno 单线程事件循环直接同步调用 initSuperuser（outputSync 不阻塞
  //    其他异步任务的微任务推进）。
  try {
    initSuperuser(
      state.pbBinary,
      dataDir,
      superuserEmail,
      superuserPassword,
    );
  } catch (e) {
    // 预置失败：清理占位记录
    await state.store.remove(app.id);
    await state.store.flush().catch(() => {});
    throw AppError.Internal(`预置 superuser 失败: ${e}`);
  }

  // 3. spawn PB（沿用 PM.start，含端口分配 + 健康检查）。
  //    健康检查通过仅表示 PB 进程启动，但 superuser 凭证异步落盘可能在
  //    spawn 后还在 SQLite 异步 commit 阶段——首次代理请求会 503
  //    （凭证代换失败）。createApp 返回 200 前，主动验证一次
  //    auth-with-password 能成功（带重试），消除首次代理竞态
  //    （agent-pov review §3.2 / §4.1）。
  const cookiePath = `/${id}/`;
  let actualPort: number;
  try {
    actualPort = await state.processManager.start(
      id,
      dataDir,
      cookiePath,
      allocator,
    );
  } catch (e) {
    // Issue #10：start 失败时移除占位记录，不留 Error 记录
    await state.store.remove(app.id);
    await state.store.flush().catch(() => {});
    // init 已成功 → data_dir 含预置 superuser 的 SQLite，需一并清理。
    // id 是 uuid v4 随机，重试不会复用同 id，不会发生幂等覆盖，故直接删目录。
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    throw e instanceof AppError ? e : AppError.Internal(`${e}`);
  }

  // 4. 验证 superuser 凭证可用（重试 3 次，每次间隔 500ms）
  try {
    await verifySuperuserReady(actualPort, superuserEmail, superuserPassword);
  } catch (e) {
    console.warn(
      `superuser 凭证验证失败 app_id=${id} error=${(e as Error).message}`,
    );
    // 不阻塞创建流程——保留 PM.start 成功的事实，让后续代理层自愈重试。
    // 此处只记 warn，避免把可恢复的竞态硬升为创建失败。
  }

  // Issue #10：用实际 port + Running + 凭证持久化
  app.port = actualPort;
  app.status = "running";
  app.updated_at = new Date().toISOString();
  app.superuser_email = superuserEmail;
  app.superuser_password = superuserPassword;
  await state.store.update(app);
  try {
    await state.store.flush();
  } catch (e) {
    throw AppError.Internal(`持久化失败: ${e}`);
  }

  // 创建占位 index.html（agent-pov B2）：外部 agent 即使尚未 PUT 上传，
  // 浏览器 GET /{id}/ 也能拿到 200 占位页，提示用 PUT API 发布真实前端。
  // 失败仅记日志（不影响 app 创建成功语义）。
  try {
    await writePlaceholderIndex(state.publicDir, id);
  } catch (e) {
    console.warn(
      `写入占位 index.html 失败 app_id=${id} error=${(e as Error).message}`,
    );
  }

  const resp = toAppResponse(app);
  return Response.json({ data: resp, error: null });
}

/** GET /apps —— 列出所有 App。 */
export async function listApps(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  const apps = await ctx.state.store.list();
  const resp = apps.map(toAppResponse);
  return Response.json({ data: resp, error: null });
}

/** GET /apps/{id} —— 查询单个 App。 */
export async function getApp(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  const id = ctx.params.id;
  const app = await ctx.state.store.get(id);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${id}`);
  }
  const resp = toAppResponse(app);
  return Response.json({ data: resp, error: null });
}

/** DELETE /apps/{id} —— 删除 App（停进程 + 删记录 + 删数据/静态目录）。 */
export async function deleteApp(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  const state = ctx.state;
  const id = ctx.params.id;

  const existed = await state.store.get(id);
  if (!existed) {
    throw AppError.NotFound(`App 不存在: ${id}`);
  }
  // 停进程
  await state.processManager.stop(id);
  // 停 custom 进程（若存在）
  await state.customProcessManager.stop(id);
  // 删记录
  await state.store.remove(id);
  try {
    await state.store.flush();
  } catch (e) {
    throw AppError.Internal(`持久化失败: ${e}`);
  }
  // 吊销该 app 的所有 token（避免悬挂 token 仍可访问）
  // 失败仅记日志，不阻塞删除流程
  try {
    await revokeAllTokensByApp(state, id);
  } catch (e) {
    console.warn(
      `吊销 token 失败 app_id=${id} error=${(e as Error).message}`,
    );
  }
  // 删数据目录（MVP：立即删，无宽限期；后续 plan 实现 7 天宽限）
  const dataDir = `${state.dataDir}/${id}`;
  if (await pathExists(dataDir)) {
    try {
      await Deno.remove(dataDir, { recursive: true });
    } catch (e) {
      console.warn(
        `删除数据目录失败 dir=${dataDir} error=${(e as Error).message}`,
      );
    }
  }
  // 删静态目录
  const publicDir = `${state.publicDir}/${id}`;
  if (await pathExists(publicDir)) {
    await Deno.remove(publicDir, { recursive: true }).catch(() => {});
  }
  return Response.json({ data: { deleted: id }, error: null });
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 判断路径是否存在（对应 Rust PathBuf.exists()，封装成 async）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    // 其他错误（权限等）视为不存在，与 Rust exists() 行为接近
    return false;
  }
}

/** 显式标注 AppStore 类型引用（仅用于文档化 import 关系，便于未来重构）。 */
export type { AppStore };

/**
 * 写入占位 index.html 到 public/{id}/。
 * 幂等：目录已存在不报错；文件已存在则覆盖（占位语义，agent 后续 PUT 会覆盖）。
 */
async function writePlaceholderIndex(
  publicDir: string,
  id: string,
): Promise<void> {
  const dir = `${publicDir}/${id}`;
  await Deno.mkdir(dir, { recursive: true });
  const html = PLACEHOLDER_HTML.replace(/\{id\}/g, id);
  await Deno.writeTextFile(`${dir}/index.html`, html);
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>app {id}</title>
</head>
<body>
<h1>app {id}</h1>
<p>这是平台自动生成的占位页。前端尚未发布。</p>
<p>上传方式：<code>PUT /api/apps/{id}/files/index.html</code>（需 X-Master-Key）。</p>
</body>
</html>
`;

/**
 * 主动验证 superuser 凭证可用（auth-with-password），最多重试 3 次。
 *
 * 用于 createApp 返回前消除"凭证异步落盘"竞态：
 * PocketBase 健康检查通过 ≠ superuser 已落盘生效——SQLite 内部
 * 异步 commit 可能在 spawn 后数百毫秒内才完成。代理层首次凭证代换
 * 在此时窗口会拿到 400 "Failed to authenticate." → 503 PB_UNAVAILABLE。
 *
 * 用 AbortController + 显式 clearTimeout（CLAUDE.md：禁用 AbortSignal.timeout 防止悬挂 timer）。
 */
async function verifySuperuserReady(
  port: number,
  email: string,
  password: string,
): Promise<void> {
  const url = `http://localhost:${port}/api/collections/_superusers/auth-with-password`;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: email, password }),
        signal: controller.signal,
      });
      if (resp.ok) return;
      // 400/401 视为凭证尚未生效，重试
    } catch {
      // 连接拒绝/超时，重试
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `superuser auth-with-password 重试 ${maxAttempts} 次仍未通过`,
  );
}
