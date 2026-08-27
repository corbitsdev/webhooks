export const HOOK_VERIFY = [
  "none",
  "bearer",
  "standard-webhooks",
  "slack",
] as const;

export type HookVerify = (typeof HOOK_VERIFY)[number];

export function timingEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function verifyStandardWebhooks(
  secret: string,
  headers: Headers,
  body: string,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const keyBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const expected = Buffer.from(mac).toString("base64");
  const candidates = signature.split(/\s+/).flatMap((part) => {
    const [ver, val] = part.split(",", 2);
    return ver === "v1" && val !== undefined && val !== "" ? [val] : [];
  });
  return candidates.some((c) => timingEqual(c, expected));
}

export function verifyBearer(secret: string, headers: Headers): boolean {
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
  body: string,
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
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
  const expected = `v0=${Buffer.from(mac).toString("hex")}`;
  return timingEqual(signature, expected);
}
