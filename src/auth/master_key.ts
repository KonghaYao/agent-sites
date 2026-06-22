// Platform token HMAC 签名/校验 + master key header 校验
//
// Platform token 格式：base64url(payload_json) + "." + base64url(hmac_sha256_sig)
// payload: { tid: string, aid: string, iat: number }
//
// 注意：跟 PB token（JWT 三段 xxx.yyy.zzz）结构不同，HMAC 试签名验证失败
// 即可认定不是 platform token，让代理层透传到 PB。

/** Platform token payload。 */
export interface PlatformTokenPayload {
  /** Token ID（tok-xxx 格式）。 */
  tid: string;
  /** App ID（app-xxx 格式）。 */
  aid: string;
  /** 签发时间（Unix 秒）。 */
  iat: number;
}

/**
 * 用 master key 签 platform token。
 *
 * 返回 `base64url(payload_json).base64url(hmac_sha256(payload_b64, master_key))`。
 * 用 payload_b64 做 HMAC input（不是裸 JSON），保证验签侧不需要重新序列化
 * JSON（避免 key 顺序差异导致签名不匹配）。
 */
export async function signPlatformToken(
  payload: PlatformTokenPayload,
  masterKey: string,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const key = await importKey(masterKey);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

/**
 * 验证 platform token。成功返回 payload，失败（签名错/格式错）返回 null。
 *
 * 注意：返回 null 不代表"无效 token"——可能是 PB user token 或匿名，
 * 调用方应继续当 PB token 透传处理。
 */
export async function verifyPlatformToken(
  token: string,
  masterKey: string,
): Promise<PlatformTokenPayload | null> {
  const dot = token.indexOf(".");
  // platform token 恰好一段点号；JWT 有两段，dot 位置之后还有 dot 即非 platform token
  const secondDot = token.indexOf(".", dot + 1);
  if (dot === -1 || secondDot !== -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const key = await importKey(masterKey);
  const sigBytes = base64UrlDecode(sigB64);
  if (sigBytes === null) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    new TextEncoder().encode(payloadB64) as BufferSource,
  );
  if (!ok) return null;
  const payloadBytes = base64UrlDecode(payloadB64);
  if (payloadBytes === null) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as PlatformTokenPayload;
    if (
      typeof payload.tid !== "string" ||
      typeof payload.aid !== "string" ||
      typeof payload.iat !== "number"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * 校验 X-Master-Key header 是否匹配 master key。
 * 常数时间比较防 timing attack。
 */
export function verifyMasterKeyHeader(headers: Headers, masterKey: string): boolean {
  const provided = headers.get("X-Master-Key");
  if (provided === null) return false;
  return constantTimeEqual(provided, masterKey);
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

async function importKey(masterKey: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 常数时间字符串比较。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
