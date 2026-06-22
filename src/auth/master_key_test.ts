// master_key 单测
// 被测：src/auth/master_key.ts
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { signPlatformToken, verifyMasterKeyHeader, verifyPlatformToken } from "./master_key.ts";

const TEST_KEY = "test-master-key-0123456789abcdef";

Deno.test({
  name: "test_sign_and_verify_roundtrip",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      TEST_KEY,
    );
    const payload = await verifyPlatformToken(token, TEST_KEY);
    assertEquals(payload, { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 });
  },
});

Deno.test({
  name: "test_verify_wrong_key_returns_null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      TEST_KEY,
    );
    const payload = await verifyPlatformToken(token, "wrong-key");
    assertEquals(payload, null);
  },
});

Deno.test({
  name: "test_verify_tampered_payload_returns_null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      TEST_KEY,
    );
    // 篡改 payload 段（base64url 解码 → 改 tid → 重新编码）
    const [payloadB64, sigB64] = token.split(".");
    const tamperedPayloadB64 = payloadB64.slice(0, -2) + "XX";
    const tamperedToken = `${tamperedPayloadB64}.${sigB64}`;
    const payload = await verifyPlatformToken(tamperedToken, TEST_KEY);
    assertEquals(payload, null);
  },
});

Deno.test({
  name: "test_verify_non_platform_token_returns_null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // 模拟 PB user token（标准 JWT 三段格式）
    const fakeJwt = "eyJhbGci.eyJzdWIi.signature";
    const payload = await verifyPlatformToken(fakeJwt, TEST_KEY);
    assertEquals(payload, null);
  },
});

Deno.test({
  name: "test_verify_master_key_header_correct",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const headers = new Headers({ "X-Master-Key": TEST_KEY });
    assertEquals(verifyMasterKeyHeader(headers, TEST_KEY), true);
  },
});

Deno.test({
  name: "test_verify_master_key_header_missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const headers = new Headers();
    assertEquals(verifyMasterKeyHeader(headers, TEST_KEY), false);
  },
});

Deno.test({
  name: "test_verify_master_key_header_wrong",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const headers = new Headers({ "X-Master-Key": "wrong" });
    assertEquals(verifyMasterKeyHeader(headers, TEST_KEY), false);
  },
});

Deno.test({
  name: "test_two_signatures_differ_per_key",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const t1 = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      "key-1",
    );
    const t2 = await signPlatformToken(
      { tid: "tok-abc", aid: "app-xyz", iat: 1700000000 },
      "key-2",
    );
    assertNotEquals(t1, t2);
  },
});
