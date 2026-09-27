import { describe, expect, test } from "bun:test";

import { verifyBearer, verifySlack, verifyStandardWebhooks } from "./verify.js";

const bytes = (text: string) => new TextEncoder().encode(text);

async function swSign(
  key: Uint8Array<ArrayBuffer>,
  id: string,
  timestamp: string,
  body: Uint8Array,
): Promise<Headers> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    hmac,
    Buffer.concat([bytes(`${id}.${timestamp}.`), body]),
  );
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${Buffer.from(mac).toString("base64")}`,
  });
}

const now = () => String(Math.floor(Date.now() / 1000));

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
    expect(await verifyStandardWebhooks(secret, headers, bytes(body))).toBe(
      true,
    );
  });

  test("verifies over raw bytes that are not valid UTF-8", async () => {
    const key = bytes("supersecret");
    const body = new Uint8Array([0x7b, 0x22, 0xe9, 0x22, 0x7d]);
    const headers = await swSign(key, "evt_1", now(), body);
    const secret = `whsec_${Buffer.from(key).toString("base64")}`;
    expect(await verifyStandardWebhooks(secret, headers, body)).toBe(true);
  });

  test("base64-decodes a secret without the whsec_ prefix", async () => {
    const key = bytes("supersecret");
    const headers = await swSign(key, "evt_1", now(), bytes("{}"));
    const secret = Buffer.from(key).toString("base64");
    expect(await verifyStandardWebhooks(secret, headers, bytes("{}"))).toBe(
      true,
    );
  });

  test("still accepts an unprefixed secret used as raw bytes", async () => {
    const secret = "plain-secret";
    const headers = await swSign(bytes(secret), "evt_1", now(), bytes("{}"));
    expect(await verifyStandardWebhooks(secret, headers, bytes("{}"))).toBe(
      true,
    );
  });

  test("does not use a whsec_ secret as raw bytes", async () => {
    const secret = `whsec_${Buffer.from("supersecret").toString("base64")}`;
    const headers = await swSign(bytes(secret), "evt_1", now(), bytes("{}"));
    expect(await verifyStandardWebhooks(secret, headers, bytes("{}"))).toBe(
      false,
    );
  });

  test("rejects a bad signature", async () => {
    const headers = new Headers({
      "webhook-id": "evt_1",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1,nope",
    });
    expect(
      await verifyStandardWebhooks("whsec_xxxx", headers, bytes("{}")),
    ).toBe(false);
  });
});

describe("zero-length signing keys", () => {
  test.each(["", "whsec_"])(
    "standard-webhooks rejects the empty secret %p instead of throwing",
    async (secret) => {
      const body = bytes("{}");
      const headers = new Headers({
        "webhook-id": "evt_1",
        "webhook-timestamp": now(),
        "webhook-signature": "v1,AAAA",
      });
      expect(await verifyStandardWebhooks(secret, headers, body)).toBe(false);
    },
  );

  test("slack rejects an empty secret instead of throwing", async () => {
    const headers = new Headers({
      "x-slack-request-timestamp": now(),
      "x-slack-signature": "v0=00",
    });
    expect(await verifySlack("", headers, bytes("{}"))).toBe(false);
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

  test.each([{ authorization: "Bearer " }, { "x-webhook-secret": "" }])(
    "rejects an empty secret (%o)",
    (init) => {
      expect(verifyBearer("", new Headers(init))).toBe(false);
    },
  );

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
    expect(await verifySlack(secret, headers, bytes(body))).toBe(true);
  });

  test("rejects a bad signature", async () => {
    const headers = new Headers({
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=00",
    });
    expect(await verifySlack("signing-secret", headers, bytes("{}"))).toBe(
      false,
    );
  });
});
