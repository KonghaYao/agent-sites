// logging.ts — TraceLayer 的 Deno 原生等价物
//
// 对应 Rust: crates/server/src/logging.rs
//
// 设计决策：
// - TraceLayer 是 tower-http 框架 middleware，Deno 原生无框架层。
//   按 DESIGN CONTEXT 用「手写 makeTraceMiddleware 纯函数包装」复刻
//   （非框架 middleware），外层计时 + try/catch + finally 日志，
//   风格借鉴 Koa 洋葱圈结构但实现为纯函数包装。
// - request_id 用 crypto.randomUUID().slice(0,8) 取前 8 字符
//   （Rust 端 Uuid::now_v7 取前 8；TS 端 v4 即可，request_id 仅为日志可读标识）。
// - latency 用 performance.now() 计时（毫秒），对齐 Rust LatencyUnit::Millis。
// - CLAUDE.md 禁 println!/eprintln!，TS 端 console.* 是 tracing 的等价物。
// - 结构化日志：request_id / method / uri / latency_ms / status 字段保留。

/** Trace 上下文，贯穿请求生命周期 */
export interface TraceContext {
  /** 请求 ID，UUID 前 8 字符 */
  requestId: string;
  /** 请求起始高精度时间戳（performance.now()） */
  startTime: number;
}

/** Trace middleware 包装的 handler 类型 */
export type TraceHandler = (
  req: Request,
  ctx: TraceContext,
) => Promise<Response> | Response;

/**
 * 创建 TraceContext：生成 request_id + 记录起始时间。
 *
 * 对应 Rust: make_span() — info_span!("request", request_id, method, uri)
 */
export function makeTraceContext(): TraceContext {
  // v4 UUID 取前 8 字符（Rust 端 v7 取前 8；TS 端 v4 即可）
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = performance.now();
  return { requestId, startTime };
}

/**
 * 请求开始日志。
 *
 * 对应 Rust: trace::DefaultOnRequest — 请求进入时打印 method + uri。
 */
export function logRequestStart(req: Request, ctx: TraceContext): void {
  console.info({
    event: "request.start",
    request_id: ctx.requestId,
    method: req.method,
    uri: new URL(req.url).pathname,
  });
}

/**
 * 请求结束日志（成功路径）。
 *
 * 对应 Rust: trace::DefaultOnResponse — INFO 级别 + 毫秒级 latency。
 */
export function logRequestEnd(
  ctx: TraceContext,
  status: number,
): void {
  const latencyMs = Math.round(performance.now() - ctx.startTime);
  console.info({
    event: "request.end",
    request_id: ctx.requestId,
    status,
    latency_ms: latencyMs,
  });
}

/**
 * 请求失败日志（5xx 错误路径）。
 *
 * 对应 Rust: trace::DefaultOnFailure — ERROR 级别 + 毫秒级 latency。
 * 仅对服务端错误（5xx）记录 failure，4xx 视为业务正常返回走 end 路径。
 */
export function logRequestFailure(
  ctx: TraceContext,
  status: number,
  error?: unknown,
): void {
  const latencyMs = Math.round(performance.now() - ctx.startTime);
  console.error({
    event: "request.failure",
    request_id: ctx.requestId,
    status,
    latency_ms: latencyMs,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 包装 handler 为带 trace 的纯函数 wrapper。
 *
 * 对应 Rust: make_trace_layer() — 创建带 request_id 的 TraceLayer。
 *
 * 用法：
 *   const traced = makeTraceMiddleware(myHandler);
 *   const response = await traced(req);
 *
 * 实现：外层计时 + try/catch（捕获抛出错误记 failure 并重抛）+
 *       finally 记 end（成功路径）。4xx 不视为 failure。
 *
 * 注：此处为纯函数包装而非框架 middleware。Handler 签名
 * (req: Request, ctx: TraceContext) => Promise<Response>，
 * ctx 仅携带 trace 字段（requestId/startTime），不携带 AppState——
 * AppState 注入由上层 router 组合，与 trace 职责分离。
 */
export function makeTraceMiddleware(
  handler: TraceHandler,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const ctx = makeTraceContext();
    logRequestStart(req, ctx);
    let response: Response;
    try {
      response = await handler(req, ctx);
    } catch (err) {
      // handler 抛出异常：记 failure 并重抛，由上层错误体系兜底转 Response
      logRequestFailure(ctx, 500, err);
      throw err;
    }
    // 5xx 视为服务端失败走 failure 路径，其余（含 4xx）走 end 路径
    if (response.status >= 500) {
      logRequestFailure(ctx, response.status);
    } else {
      logRequestEnd(ctx, response.status);
    }
    return response;
  };
}
