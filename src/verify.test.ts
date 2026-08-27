import { describe, expect, test } from "bun:test";

import {
  verifyBearer,
  verifySlack,
  verifyStandardWebhooks,
} from "./verify";

describe("verifyStandardWebhooks", () => {
  test("accepts a valid v1 signature", async () => {
    const secret = `whsec_${Buffer.from("supersecret").toString("base64")}`;
    const id = "evt_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = `{"ok":true}`;
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from("supersecret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    );
    const headers = new Headers({
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${Buffer.from(mac).toString("base64")}`,
    });
    expect(await verifyStandardWebhooks(secret, headers, body)).toBe(true);
  });

  test("rejects a bad signature", async () => {
    const headers = new Headers({
      "webhook-id": "evt_1",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1,nope",
    });
    expect(await verifyStandardWebhooks("whsec_xxxx", headers, "{}")).toBe(
      false,
    );
  });
});

describe("verifyBearer", () => {
  test("accepts Authorization Bearer", () => {
    const headers = new Headers({ authorization: "Bearer s3cret" });
    expect(verifyBearer("s3cret", headers)).toBe(true);
  });

  test("accepts x-webhook-secret", () => {
    const headers = new Headers({ "x-webhook-secret": "s3cret" });
    expect(verifyBearer("s3cret", headers)).toBe(true);
  });

  test("rejects a mismatch", () => {
    const headers = new Headers({ authorization: "Bearer nope" });
    expect(verifyBearer("s3cret", headers)).toBe(false);
  });
});

describe("verifySlack", () => {
  test("accepts a valid v0 signature", async () => {
    const secret = "signing-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = `{"type":"event_callback"}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`),
    );
    const headers = new Headers({
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${Buffer.from(mac).toString("hex")}`,
    });
    expect(await verifySlack(secret, headers, body)).toBe(true);
  });

  test("rejects a bad signature", async () => {
    const headers = new Headers({
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=00",
    });
    expect(await verifySlack("signing-secret", headers, "{}")).toBe(false);
  });
});
