// Token ID 生成器
// tok-{8 位 hex}，跟 app id 同样格式但前缀不同（避免混淆）

/** 生成 tok-xxxxxxxx 格式的 token ID。 */
export function generateTokenId(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `tok-${hex.slice(0, 8)}`;
}

/** 校验 token ID 格式：tok-{1..20 个 hex 字符}。 */
export function isValidTokenId(id: string): boolean {
  const rest = id.startsWith("tok-") ? id.slice("tok-".length) : null;
  if (rest === null) return false;
  return rest.length >= 1 && rest.length <= 20 && /^[0-9a-f]+$/.test(rest);
}
