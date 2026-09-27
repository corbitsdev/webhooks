export const HOOK_VERIFY = ["bearer", "standard-webhooks", "slack"] as const;

export type HookVerify = (typeof HOOK_VERIFY)[number];

export function timingEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function hmacSha256(
  key: Uint8Array<ArrayBuffer>,
  prefix: string,
  body: Uint8Array,
): Promise<Buffer> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = Buffer.concat([new TextEncoder().encode(prefix), body]);
  return Buffer.from(await crypto.subtle.sign("HMAC", hmac, message));
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Standard Webhooks keys are base64, optionally behind `whsec_`. Before 0.2 an
 * unprefixed secret was used as raw bytes, so those still verify under that
 * key too.
 */
function standardWebhooksKeys(secret: string): Uint8Array<ArrayBuffer>[] {
  if (secret.startsWith("whsec_")) {
    const encoded = secret.slice("whsec_".length);
    return BASE64.test(encoded) ? [Buffer.from(encoded, "base64")] : [];
  }
  const raw = new TextEncoder().encode(secret);
  return BASE64.test(secret) ? [Buffer.from(secret, "base64"), raw] : [raw];
}

export async function verifyStandardWebhooks(
  secret: string,
  headers: Headers,
  body: Uint8Array,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const candidates = signature.split(/\s+/).flatMap((part) => {
    const [ver, val] = part.split(",", 2);
    return ver === "v1" && val !== undefined && val !== "" ? [val] : [];
  });
  for (const key of standardWebhooksKeys(secret)) {
    const mac = await hmacSha256(key, `${id}.${timestamp}.`, body);
    const expected = mac.toString("base64");
    if (candidates.some((c) => timingEqual(c, expected))) return true;
  }
  return false;
}

export function verifyBearer(secret: string, headers: Headers): boolean {
  if (secret === "") return false;
  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return timingEqual(auth.slice("Bearer ".length), secret);
  }
  const header = headers.get("x-webhook-secret");
  return header !== null && timingEqual(header, secret);
}

export async function verifySlack(
  secret: string,
  headers: Headers,
  body: Uint8Array,
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const mac = await hmacSha256(
    new TextEncoder().encode(secret),
    `v0:${timestamp}:`,
    body,
  );
  const expected = `v0=${mac.toString("hex")}`;
  return timingEqual(signature, expected);
}
