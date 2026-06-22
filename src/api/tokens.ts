// Token CRUD handler（/api/tokens 端点）
//
// 所有 endpoint 都被 lib.ts 的 master key 中间件强制 X-Master-Key 校验。
// handler 内部不再单独校验 master key。
//
// 设计要点：
// - POST /api/tokens 颁发新 token，返回完整 token 字符串（仅此一次）
// - GET /api/tokens / GET /api/tokens/{id} 只返回 metadata，不返回 token 字符串
// - DELETE /api/tokens/{id} 软删除（status → revoked），不真删记录

import type { AppState } from "../state.ts";
import type { Ctx, Handler } from "./apps.ts";
import { AppError } from "../error.ts";
import { signPlatformToken } from "../auth/master_key.ts";
import { generateTokenId } from "../auth/token_id.ts";
import type { TokenRecord } from "../auth/token_store.ts";

/** POST /api/tokens 请求体。 */
interface CreateTokenRequest {
  app_id: string;
}

/** POST /api/tokens 返回（含 token 字符串）。 */
export interface CreateTokenResponse {
  token_id: string;
  app_id: string;
  token: string;
  status: "active";
  issued_at: string;
  /** 提示此 token 仅展示一次，丢失需吊销重新申请 */
  warning: string;
}

/** GET /api/tokens / GET /api/tokens/{id} 返回（不含 token 字符串）。 */
export interface TokenResponse {
  token_id: string;
  app_id: string;
  status: "active" | "revoked";
  issued_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** POST /api/tokens —— 颁发新 token。 */
export async function createToken(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const state = ctx.state;
  const body = await parseBody<CreateTokenRequest>(req);
  if (!body.app_id) {
    throw AppError.BadRequest("缺少 app_id");
  }
  const app = await state.store.get(body.app_id);
  if (!app) {
    throw AppError.NotFound(`App 不存在: ${body.app_id}`);
  }
  const now = new Date().toISOString();
  const tokenId = generateTokenId();
  const payload = {
    tid: tokenId,
    aid: app.id,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = await signPlatformToken(payload, state.masterKey);
  await state.tokenStore.add({
    token_id: tokenId,
    app_id: app.id,
    status: "active",
    issued_at: now,
    revoked_at: null,
    last_used_at: null,
  });
  await state.tokenStore.flush();
  const resp: CreateTokenResponse = {
    token_id: tokenId,
    app_id: app.id,
    token,
    status: "active",
    issued_at: now,
    warning: "此 token 仅展示一次，请立即持久化；丢失需吊销重新申请",
  };
  return Response.json({ data: resp, error: null });
}

/** GET /api/tokens —— 列出所有 token（可选 ?app_id= 过滤）。 */
export async function listTokens(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const url = new URL(req.url);
  const appIdFilter = url.searchParams.get("app_id");
  const all = appIdFilter
    ? await ctx.state.tokenStore.listByApp(appIdFilter)
    : await ctx.state.tokenStore.list();
  const resp: TokenResponse[] = all.map(tokenToResponse);
  return Response.json({ data: resp, error: null });
}

/** GET /api/tokens/{id} —— 查询 token。 */
export async function getToken(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  const id = ctx.params.id;
  const t = await ctx.state.tokenStore.get(id);
  if (!t) {
    throw AppError.NotFound(`Token 不存在: ${id}`);
  }
  return Response.json({ data: tokenToResponse(t), error: null });
}

/** DELETE /api/tokens/{id} —— 吊销 token。 */
export async function revokeToken(
  _req: Request,
  ctx: Ctx,
): Promise<Response> {
  const id = ctx.params.id;
  const now = new Date().toISOString();
  const ok = await ctx.state.tokenStore.revoke(id, now);
  if (!ok) {
    throw AppError.NotFound(`Token 不存在: ${id}`);
  }
  await ctx.state.tokenStore.flush();
  return Response.json({ data: { revoked: id }, error: null });
}

/**
 * 在 deleteApp 内部调用：吊销某 app 的所有 active token。
 *
 * 返回吊销的 token 数（0 时也不抛错——可能本来就没 token）。
 */
export async function revokeAllTokensByApp(
  state: AppState,
  appId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const n = await state.tokenStore.revokeAllByApp(appId, now);
  if (n > 0) await state.tokenStore.flush();
  return n;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function tokenToResponse(t: TokenRecord): TokenResponse {
  return {
    token_id: t.token_id,
    app_id: t.app_id,
    status: t.status,
    issued_at: t.issued_at,
    revoked_at: t.revoked_at,
    last_used_at: t.last_used_at,
  };
}

async function parseBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export type { Handler };
