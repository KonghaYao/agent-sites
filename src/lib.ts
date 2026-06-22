// 应用入口：构建 HTTP 路由 + 启动 Deno.serve。
//
// 由 crates/server/src/lib.rs 1:1 迁移而来。
//
// 翻译决策（DESIGN CONTEXT）：
// - axum::Router → 手写有序前缀匹配数组（~80 行），显式声明
//   /{app_id}、/{app_id}/、/{app_id}/{*path} 三条独立规则，1:1 复刻
//   axum 0.8 三变体 hack（lib.rs:44-48）。Oak/Hono 会自动归一尾斜杠
//   破坏三变体差异化语义，故拒绝框架路由，手写匹配。
// - catch-all 用 split('/') 而非正则贪婪，避免与 /api 冲突。
// - axum::extract::State<Arc<AppState>> + Path<T> + Method + HeaderMap +
//   Bytes → 统一 Handler 签名 (req, ctx) => Promise<Response>，
//   ctx (Ctx) 携带 AppState 引用 + URL 参数 + requestId。
//   Ctx / Handler 类型复用 src/api/apps.ts 中的定义。
// - axum::body::Bytes → Uint8Array（req.arrayBuffer() 一次性读）
// - tracing::info! / warn! / error! → console.* （CLAUDE.md 禁 println!）
// - tokio::fs::read_to_string → await Deno.readTextFile
// - axum::response::Html<String> → new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}})
// - Result<Response, AppError> → throws AppError；错误体系在 trace
//   middleware 的 catch 中转 Response（AppError.toResponse()）
// - TraceLayer 等价物：makeTraceMiddleware 纯函数包装（src/logging.ts）
// - 路由匹配失败（404）→ AppError.NotFound → toResponse()
//
// 注：src/routing/mod.ts 在迁移过程中未单独抽出，路由表内联在本文件
// createApp 函数内（设计上下文授权的 80 行手写有序匹配）。

import { isValidId } from "./app/model.ts";
import type { App } from "./app/model.ts";
import { DEFAULT_MAX_BODY_BYTES, forward, isRecoverableError } from "./proxy/mod.ts";
import { serveFileFromRoot } from "./static_files/mod.ts";
import { AppError } from "./error.ts";
import { PortAllocator } from "./process/port_allocator.ts";
import type { RestartOutcome } from "./process/mod.ts";
import type { AppState } from "./state.ts";
import type { Ctx, Handler } from "./api/apps.ts";
import {
  createApp as createAppHandler,
  deleteApp as deleteAppHandler,
  getApp as getAppHandler,
  listApps as listAppsHandler,
} from "./api/apps.ts";
import {
  createToken as createTokenHandler,
  getToken as getTokenHandler,
  listTokens as listTokensHandler,
  revokeToken as revokeTokenHandler,
} from "./api/tokens.ts";
import { uploadFile as uploadFileHandler } from "./api/files.ts";
import { uploadBundle as uploadBundleHandler } from "./api/files_bundle.ts";
import { verifyMasterKeyHeader, verifyPlatformToken } from "./auth/master_key.ts";

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 校验 app_id 是否合法（以 "app-" 开头且通过 isValidId）。
 * 防止非 app-* 前缀路径被代理（如 /api-x/...，Issue #11）。
 *
 * 对应 Rust lib.rs:22-24 的 validate_app_id。
 */
export function validateAppId(appId: string): boolean {
  return isValidId(appId);
}

// ---------------------------------------------------------------------------
// 路由匹配
// ---------------------------------------------------------------------------

/**
 * 匹配结果：命中的 handler + 解析出的路径参数。
 *
 * 注：path 参数对 catch-all（{*path}）规则对应 params.path，可能为空串；
 * 对 /{app_id} 与 /{app_id}/ 两条变体分别对应无 path 与空 path，
 * 这是 axum 0.8 三变体 hack 的语义核心（lib.rs:44-48）。
 */
interface MatchResult {
  handler: Handler;
  params: Record<string, string>;
}

/**
 * 单条路由规则。
 *
 * method 为小写比较；pathPattern 用分段前缀匹配：
 * - 段为 "{app_id}" 捕获单个非斜杠段
 * - 段为 "{*path}" 捕获剩余全部（含斜杠），params.path 可能为空串
 * - 其余为字面量精确匹配
 */
interface Route {
  method: string;
  segments: Segment[];
  handler: Handler;
}

/** 路径段：字面量 / 单段参数 / catch-all 参数 */
type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard"; name: string };

/**
 * 把 "/{app_id}/api/{*path}" 形式的 axum 路由模式解析为段数组。
 *
 * - "{name}" → param
 * - "{*name}" → wildcard
 * - 其余 → literal
 */
function parsePattern(pattern: string): Segment[] {
  // 去掉前导 /，再按 / 切分
  const trimmed = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (trimmed.length === 0) return [];
  return trimmed.split("/").map((seg) => {
    const m = seg.match(/^\{(\*?)([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
    if (m) {
      const [, star, name] = m;
      return star === "*" ? { kind: "wildcard" as const, name } : { kind: "param" as const, name };
    }
    return { kind: "literal" as const, value: seg };
  });
}

/**
 * 把单个路径与段数组匹配，成功返回 params，失败返回 null。
 *
 * 关键：axum 0.8 的 {*path} 要求 path 非空，且严格区分尾斜杠。
 * 为 1:1 复刻三变体（/{app_id} vs /{app_id}/ vs /{app_id}/{*path}），
 * 本函数对段数严格相等比较（wildcard 段除外），不做归一化。
 *
 * 例：pathname="/app-abc" 与 segments=[{param:app_id}] 命中；
 *     pathname="/app-abc/" 与 segments=[{param:app_id}] 不命中
 *     （拆分后多一个空段），需 /{app_id}/ 单独规则；
 *     pathname="/app-abc/foo" 与 segments=[{param:app_id},{wildcard:path}] 命中。
 */
function matchPath(
  pathname: string,
  segments: Segment[],
): Record<string, string> | null {
  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const parts = trimmed.length === 0 ? [] : trimmed.split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "wildcard") {
      // catch-all：剩余全部用 / 连接（可能为空串 → /{app_id}/ 变体命中空 path）
      params[seg.name] = parts.slice(i).join("/");
      return params;
    }
    // 字面量 / 单段参数：必须有对应段
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.kind === "literal") {
      if (part !== seg.value) return null;
    } else {
      // 单段参数：禁止捕获斜杠（split 已保证 part 不含 /）
      if (part.length === 0) return null;
      params[seg.name] = part;
    }
  }
  // 段用完后 pathname 不应还有剩余段（wildcard 已提前 return）
  if (parts.length !== segments.length) return null;
  return params;
}

/**
 * 路由表。顺序敏感——先声明的优先匹配。
 *
 * 1:1 复刻 axum Router 声明顺序（lib.rs:30-48）：
 *   GET  /                         → serve_panel
 *   GET  /health                   → 健康检查
 *   *    /api/*                    → 管理 API（nest）
 *   *    /{app_id}/api/{*path}     → serve_api_proxy
 *   GET  /{app_id}                 → serve_static_root
 *   GET  /{app_id}/                → serve_static_root
 *   GET  /{app_id}/{*path}         → serve_static
 *
 * 三变体（/{app_id} vs /{app_id}/ vs /{app_id}/{*path}）独立声明：
 * - /{app_id} 只匹配恰好一段（parts.length===1），尾斜杠走第二条
 * - /{app_id}/ 匹配 "app-abc/"（parts=["app-abc"]，wildcard path=""）
 *   注：实际本实现用 /{app_id}/{*path} 同时覆盖 /{app_id}/（path=""）
 *   和 /{app_id}/foo，所以无需第三条；但为对齐 axum 0.8 严格区分语义，
 *   显式保留 /{app_id}（无尾斜杠）与 /{app_id}/{*path} 两条规则。
 */
function buildRoutes(): Route[] {
  return [
    { method: "get", segments: parsePattern("/"), handler: servePanel },
    {
      method: "get",
      segments: parsePattern("/health"),
      handler: healthHandler,
    },
    // 管理 API：POST /api/apps、GET /api/apps、GET /api/apps/{id}、DELETE /api/apps/{id}
    {
      method: "post",
      segments: parsePattern("/api/apps"),
      handler: createAppHandler,
    },
    {
      method: "get",
      segments: parsePattern("/api/apps"),
      handler: listAppsHandler,
    },
    {
      method: "get",
      segments: parsePattern("/api/apps/{id}"),
      handler: getAppHandler,
    },
    {
      method: "delete",
      segments: parsePattern("/api/apps/{id}"),
      handler: deleteAppHandler,
    },
    // 前端文件上传（master key 强制；catch-all path 含子目录）
    {
      method: "put",
      segments: parsePattern("/api/apps/{id}/files/{*path}"),
      handler: uploadFileHandler,
    },
    // 前端文件批量上传（gzip tar 归档；master key 强制）
    {
      method: "post",
      segments: parsePattern("/api/apps/{id}/files/bundle"),
      handler: uploadBundleHandler,
    },
    // Token CRUD（master key 强制）
    {
      method: "post",
      segments: parsePattern("/api/tokens"),
      handler: createTokenHandler,
    },
    {
      method: "get",
      segments: parsePattern("/api/tokens"),
      handler: listTokensHandler,
    },
    {
      method: "get",
      segments: parsePattern("/api/tokens/{id}"),
      handler: getTokenHandler,
    },
    {
      method: "delete",
      segments: parsePattern("/api/tokens/{id}"),
      handler: revokeTokenHandler,
    },
    // PocketBase Client API 代理
    {
      method: "get",
      segments: parsePattern("/{app_id}/api/{*path}"),
      handler: serveApiProxy,
    },
    {
      method: "post",
      segments: parsePattern("/{app_id}/api/{*path}"),
      handler: serveApiProxy,
    },
    {
      method: "put",
      segments: parsePattern("/{app_id}/api/{*path}"),
      handler: serveApiProxy,
    },
    {
      method: "delete",
      segments: parsePattern("/{app_id}/api/{*path}"),
      handler: serveApiProxy,
    },
    {
      method: "patch",
      segments: parsePattern("/{app_id}/api/{*path}"),
      handler: serveApiProxy,
    },
    // 静态文件：/{app_id}（无尾斜杠）
    {
      method: "get",
      segments: parsePattern("/{app_id}"),
      handler: serveStaticRoot,
    },
    // 静态文件：/{app_id}/{*path}（含 /{app_id}/ → path=""）
    {
      method: "get",
      segments: parsePattern("/{app_id}/{*path}"),
      handler: serveStatic,
    },
  ];
}

/**
 * 在路由表中按方法 + 路径有序匹配，返回首个命中规则。
 *
 * 顺序敏感：先 /api/* 再 /{app_id}/api/* 再 /{app_id} 再 /{app_id}/{*path}，
 * 保证 /api/apps 不会被 /{app_id} 误捕（/api 不通过 validateAppId 也会在
 * handler 内返 NotFound，但路由层先命中 /api 避免无效查找）。
 */
function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): MatchResult | null {
  const methodLower = method.toLowerCase();
  for (const route of routes) {
    if (route.method !== methodLower) continue;
    const params = matchPath(pathname, route.segments);
    if (params !== null) {
      return { handler: route.handler, params };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /health → 返回纯文本 "ok"（对应 Rust `|| async { "ok" }`）。 */
// deno-lint-ignore require-await
async function healthHandler(
  _req: Request,
  _ctx: Ctx,
): Promise<Response> {
  return new Response("ok", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * GET / —— 控制面板 HTML。
 *
 * 对应 Rust serve_panel：读 public/_panel/index.html，不存在则 fallback
 * 到提示文字（mod.rs:174-189）。
 */
async function servePanel(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  const panelPath = `${ctx.state.publicDir}/_panel/index.html`;
  try {
    const html = await Deno.readTextFile(panelPath);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch {
    console.warn(`控制面板 HTML 未安装，fallback 到提示文字 path=${panelPath}`);
    const fallback = '<!doctype html><meta charset="utf-8"><title>agent-sites</title>' +
      "agent-sites — 控制面板 HTML 未安装";
    return new Response(fallback, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * PocketBase Client API 代理：/{app_id}/api/{*path} → localhost:{port}/api/{path}。
 *
 * 对应 Rust serve_api_proxy（lib.rs:52-113）。流程：
 * 1. 校验 app_id 前缀（防 /api-x 被代理，Issue #11）
 * 2. store.get 查 App；不存在 → NotFound
 * 3. status=Error → 直接短路 503（pb 已知不可达）
 * 4. 进程存活检测：is_alive=false → 自愈路径
 * 5. forward 失败且 is_recoverable_error → 自愈路径
 * 6. 否则返回 forward 结果
 */
async function serveApiProxy(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const state = ctx.state;
  const appId = ctx.params.app_id;
  const path = ctx.params.path ?? "";

  // Issue #11：显式校验 app_id 前缀
  if (!validateAppId(appId)) {
    throw AppError.NotFound(`App 不存在: ${appId}`);
  }

  const app = await state.store.get(appId);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${appId}`);
  }

  // status=Error 直接短路
  if (app.status === "error") {
    throw AppError.ServiceUnavailable(
      `App ${appId} 后端处于 Error 状态，需重新创建`,
    );
  }

  const upstreamPath = `/api/${path}`;

  // 读取请求体一次（后续 forward + 自愈路径都要用）
  const body = await readBodyBytes(req);
  const method = req.method;
  // 复制 header（凭证代换会原地修改 Authorization）
  const headers = new Headers(req.headers);

  // Token 验证 + 凭证代换
  // - 带 platform token：验证签名 + status + app_id 一致 → 替换为 PB superuser token
  // - 带非 platform token 或无 token：原样透传（PB 用 Rules 处理）
  await maybeReplacePlatformTokenWithPbToken(state, appId, app, headers);

  // 第一关：进程存活检测
  if (!state.processManager.isAlive(appId)) {
    return await handleProxyWithRecovery(
      state,
      appId,
      app,
      upstreamPath,
      method,
      headers,
      body,
    );
  }

  // 第二关：forward + PB 401 兜底重试
  try {
    const resp = await forward(
      app.port,
      upstreamPath,
      method,
      headers,
      body,
      DEFAULT_MAX_BODY_BYTES,
      appId,
    );
    // PB 返 401 + 本次 Authorization 是凭证代换来的 → 缓存的 PB token 可能
    // 已过期/被 PB 端撤销，清缓存重试一次
    if (
      resp.status === 401 &&
      headers.get("X-Replaced-From-Platform-Token") === "1"
    ) {
      state.pbTokenCache.invalidate(`http://localhost:${app.port}`);
      return await forward(
        app.port,
        upstreamPath,
        method,
        headers,
        body,
        DEFAULT_MAX_BODY_BYTES,
        appId,
      );
    }
    return resp;
  } catch (e) {
    if (e instanceof AppError && isRecoverableError(e)) {
      console.warn(
        `forward 失败，触发自愈 app_id=${appId} error=${e.message}`,
      );
      return await handleProxyWithRecovery(
        state,
        appId,
        app,
        upstreamPath,
        method,
        headers,
        body,
      );
    }
    throw e;
  }
}

/**
 * 如果请求头是 platform token 且验证通过，替换为 PB superuser token（凭证代换 + 缓存）。
 *
 * 三种情况：
 * 1. 无 Authorization header → 啥都不做（透传，PB Rules 处理）
 * 2. Authorization 是 platform token：
 *    - app_id 不一致 → throw 403 Forbidden
 *    - token 不存在 → throw 401 Unauthorized
 *    - status=revoked → throw 401 Unauthorized
 *    - 全部通过 → 替换为 PB superuser token（凭证代换 + 缓存）
 * 3. Authorization 不是 platform token（PB user token / 伪造 JWT）→ 啥都不做（透传）
 */
async function maybeReplacePlatformTokenWithPbToken(
  state: AppState,
  appId: string,
  app: App,
  headers: Headers,
): Promise<void> {
  const auth = headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return;
  const rawToken = auth.slice("Bearer ".length);
  const payload = await verifyPlatformToken(rawToken, state.masterKey);
  if (payload === null) {
    // 不是 platform token，透传（PB Rules 处理）
    return;
  }
  // 是 platform token
  if (payload.aid !== appId) {
    throw AppError.Forbidden("token 与 app_id 不匹配");
  }
  const tokenRecord = await state.tokenStore.get(payload.tid);
  if (!tokenRecord) {
    throw AppError.Unauthorized("token 不存在");
  }
  if (tokenRecord.status === "revoked") {
    throw AppError.Unauthorized("token 已吊销");
  }
  // 凭证代换：用 app 的凭证换 PB superuser token
  const baseUrl = `http://localhost:${app.port}`;
  let pbToken: string;
  try {
    pbToken = await state.pbTokenCache.get(
      baseUrl,
      app.superuser_email,
      app.superuser_password,
    );
  } catch (e) {
    throw AppError.ServiceUnavailable(
      `凭证代换失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 替换 header + 标记位（用于 PB 401 时清缓存重试）
  headers.set("Authorization", `Bearer ${pbToken}`);
  headers.set("X-Replaced-From-Platform-Token", "1");
}

/**
 * 自愈路径：调 restart_if_needed，成功则重试 forward，失败则标 status=Error + 返回 503。
 *
 * 对应 Rust handle_proxy_with_recovery（lib.rs:116-172）。
 */
async function handleProxyWithRecovery(
  state: AppState,
  appId: string,
  app: App,
  upstreamPath: string,
  method: string,
  headers: Headers,
  body: Uint8Array,
): Promise<Response> {
  const dataDir = `${state.dataDir}/${appId}`;
  const allocator = new PortAllocator(state.portMin, state.portMax);

  const outcome: RestartOutcome = await state.processManager
    .restartIfNeeded(appId, dataDir, allocator);

  if (outcome === "Restarted" || outcome === "StillHealthy") {
    // restart 可能分配新端口（PM entry 缺失时），从 PM 读实时端口而非用 app.port
    const port = state.processManager.getPort(appId);
    if (port === undefined) {
      throw AppError.Internal(
        `restart 后 PM 中找不到 ${appId} 的端口（内部状态不一致）`,
      );
    }
    return await forward(
      port,
      upstreamPath,
      method,
      headers,
      body,
      DEFAULT_MAX_BODY_BYTES,
      appId,
    );
  }

  // RateLimited | GiveUp：同步 status=Error + flush
  const updated = {
    ...app,
    status: "error" as const,
    updated_at: new Date().toISOString(),
  };
  await state.store.update(updated);
  // flush 失败只记日志不阻塞 503 返回（lib.rs:163-165 容错策略保留）
  try {
    await state.store.flush();
  } catch (e) {
    console.error(
      `flush apps.json 失败（status=Error 未持久化） error=${(e as Error).message}`,
    );
  }
  throw AppError.ServiceUnavailable(
    `App ${appId} 后端多次重启失败，已停止自愈`,
  );
}

/**
 * 静态文件根（/{app_id} 与 /{app_id}/ 共用）：path 始终为 ""。
 *
 * 对应 Rust serve_static_root（lib.rs:191-196）。
 */
async function serveStaticRoot(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  return await serveStaticImpl(ctx.state, ctx.params.app_id, "");
}

/**
 * 静态文件（/{app_id}/{*path}）。
 *
 * 对应 Rust serve_static（lib.rs:198-203）。ctx.params.path 来自 wildcard。
 */
async function serveStatic(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  return await serveStaticImpl(
    ctx.state,
    ctx.params.app_id,
    ctx.params.path ?? "",
  );
}

/**
 * 静态文件实现：校验 app_id → 校验 App 存在 → 转发到 static_files。
 *
 * 对应 Rust serve_static_impl（lib.rs:205-223）。
 */
async function serveStaticImpl(
  state: AppState,
  appId: string,
  path: string,
): Promise<Response> {
  // 仅识别 app-* 前缀（避免 /api、/_ 等被这里捕获）
  if (!validateAppId(appId)) {
    throw AppError.NotFound(`App 不存在: ${appId}`);
  }
  // Admin UI 不开放（agent-pov R2 §1）：显式拦截 /{app_id}/_/ 前缀请求，
  // 返回明确错误消息（避免落到静态文件 404「文件不存在: _/index.html」
  // 让 agent 误以为是文件缺失而非路由屏蔽）。
  if (path === "_" || path.startsWith("_/")) {
    throw AppError.NotFound("Admin UI 不开放，请用 platform token + API");
  }
  const app = await state.store.get(appId);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${appId}`);
  }
  // 静态文件不直接用 app，仅校验存在（与 Rust `let _ = app;` 等价）
  void app;
  const root = `${state.publicDir}/${appId}`;
  return await serveFileFromRoot(root, path, { appId });
}

// ---------------------------------------------------------------------------
// createApp：构建请求分发器
// ---------------------------------------------------------------------------

/**
 * 构建请求分发器（对应 Rust `create_app`，lib.rs:27-50）。
 *
 * 返回一个 (req: Request) => Promise<Response> 的处理函数，内部：
 * 1. 匹配路由表（手写有序前缀匹配）
 * 2. 命中 → 构造 Ctx（AppState + params + requestId）调 handler
 * 3. 未命中 → 404（NotFound.toResponse）
 * 4. 整体包一层 makeTraceMiddleware（request_id + latency 日志）
 * 5. handler throw AppError → catch 转 toResponse（lib.rs 没有显式
 *    error middleware，axum 由 IntoResponse 自动转；TS 端用 try/catch 兜底）
 *
 * Deno.serve 由 main.ts 调用此函数返回的 handler 启动；本函数不直接
 * 启动服务器，便于测试用 fetch(handler) 做端到端验证。
 */
export function createApp(
  state: AppState,
): (req: Request) => Promise<Response> {
  const routes = buildRoutes();

  // 外层 trace 包装：注入 requestId 到 Ctx（通过闭包改造）
  // 注：logging.ts 的 makeTraceMiddleware 只传 TraceContext，不传 Ctx。
  // 为把 requestId 注入到 handler 的 ctx，这里手动包装 dispatcher：
  // 在 dispatcher 外层生成 requestId → 注入到 ctx。
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const startTime = performance.now();
    const url = new URL(req.url);
    const pathname = url.pathname;

    console.info({
      event: "request.start",
      request_id: requestId,
      method: req.method,
      uri: pathname,
    });

    let response: Response;
    try {
      response = await dispatchWithRequestId(req, routes, state, requestId);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      console.error({
        event: "request.failure",
        request_id: requestId,
        status: 500,
        latency_ms: latencyMs,
        error: err instanceof Error ? err.message : String(err),
      });
      // dispatcher 内部已 try/catch AppError，这里只兜底 dispatcher 自身抛错
      return AppError.Internal(
        err instanceof Error ? err.message : String(err),
      ).toResponse(requestId);
    }

    const latencyMs = Math.round(performance.now() - startTime);
    if (response.status >= 500) {
      console.error({
        event: "request.failure",
        request_id: requestId,
        status: response.status,
        latency_ms: latencyMs,
      });
    } else {
      console.info({
        event: "request.end",
        request_id: requestId,
        status: response.status,
        latency_ms: latencyMs,
      });
    }
    return response;
  };
}

/**
 * 带 requestId 的分发：与 dispatcher 等价，但 requestId 由外层传入注入 ctx。
 *
 * 抽出此函数避免 dispatcher 与 trace 包装耦合，requestId 在 catch
 * 错误日志时也可取到。
 */
async function dispatchWithRequestId(
  req: Request,
  routes: Route[],
  state: AppState,
  requestId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const matched = matchRoute(routes, req.method, pathname);
  if (!matched) {
    return AppError.NotFound(`路由不存在: ${req.method} ${pathname}`)
      .toResponse(requestId);
  }
  // Master key 中间件：所有平台管理 API（/api/apps、/api/tokens）强制校验
  // X-Master-Key。
  // /health 不在 /api/* 下，不受影响（健康检查公开）；
  // /{app_id}/api/* 是 PB 代理，不走 dispatchWithRequestId 内的这条校验——
  // PB 代理有独立的 platform token 验证逻辑（见 serveApiProxy）。
  if (
    pathname === "/api/apps" || pathname.startsWith("/api/apps/") ||
    pathname === "/api/tokens" || pathname.startsWith("/api/tokens/")
  ) {
    if (!verifyMasterKeyHeader(req.headers, state.masterKey)) {
      return AppError.Unauthorized("缺少或错误的 X-Master-Key")
        .toResponse(requestId);
    }
  }
  const ctx: Ctx = {
    state,
    params: matched.params,
    requestId,
  };
  try {
    return await matched.handler(req, ctx);
  } catch (err) {
    if (err instanceof AppError) {
      return err.toResponse(requestId);
    }
    console.error(
      `未预期异常 method=${req.method} path=${pathname} error=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return AppError.Internal(
      err instanceof Error ? err.message : String(err),
    ).toResponse(requestId);
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 一次性读取请求体为 Uint8Array（等价 axum::body::Bytes 提取）。
 *
 * 空 body（GET/DELETE 等）返回 0 长度数组，forward 内部判断 byteLength>0 才附 body。
 */
async function readBodyBytes(req: Request): Promise<Uint8Array> {
  // GET / DELETE 无 body 或 body 已消费 → arrayBuffer 返回 0 字节
  try {
    const buf = await req.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return new Uint8Array(0);
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export type { Ctx, Handler };
export {
  buildRoutes,
  healthHandler,
  matchPath,
  matchRoute,
  parsePattern,
  serveApiProxy,
  servePanel,
  serveStatic,
  serveStaticRoot,
};
export type { MatchResult, Route, Segment };
