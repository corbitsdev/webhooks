import { describe, expect, test } from "bun:test";
import {
  generateWebhookSecret,
  isFreshTimestamp,
  signPayload,
  verifySignature,
} from "./trigger-signature";

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("generateWebhookSecret", () => {
  test("produces distinct, non-empty secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("verifySignature", () => {
  test("accepts a correctly computed signature over a fresh timestamp", () => {
    const secret = "s3cr3t";
    const timestamp = nowSeconds();
    const body = JSON.stringify({ hello: "world" });
    const signature = signPayload(secret, timestamp, body);
    expect(verifySignature(secret, timestamp, body, signature)).toBe(true);
  });

  test("rejects a signature computed with a different secret", () => {
    const timestamp = nowSeconds();
    const body = "{}";
    const signature = signPayload("wrong", timestamp, body);
    expect(verifySignature("right", timestamp, body, signature)).toBe(false);
  });

  test("rejects a missing signature", () => {
    expect(verifySignature("s", nowSeconds(), "{}", undefined)).toBe(false);
  });

  test("rejects a stale timestamp", () => {
    const secret = "s3cr3t";
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    const body = "{}";
    const signature = signPayload(secret, stale, body);
    expect(verifySignature(secret, stale, body, signature)).toBe(false);
  });

  test("rejects a non-hex signature without throwing", () => {
    expect(
      verifySignature("s3cr3t", nowSeconds(), "{}", "not-hex-!!"),
    ).toBe(false);
  });
});

describe("isFreshTimestamp", () => {
  test("true within the tolerance window, false outside it", () => {
    expect(isFreshTimestamp(nowSeconds())).toBe(true);
    expect(
      isFreshTimestamp(String(Math.floor(Date.now() / 1000) - 301)),
    ).toBe(false);
    expect(isFreshTimestamp(undefined)).toBe(false);
    expect(isFreshTimestamp("not-a-number")).toBe(false);
  });
});
