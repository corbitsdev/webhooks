// The trust boundary this half of the package exists to guard: an
// inbound HTTP call from a network the host does not control. Every
// byte off the wire is untrusted until its signature verifies against
// the trigger's own secret, over a delivery recent enough to matter.
//
// Security-model note: the secret is generated server-side with
// `crypto.randomBytes` and shown to the caller exactly once, at
// creation or rotation. `trigger-store.ts` encrypts it at rest through
// the host's `CredentialCipher` seam — but this function still needs
// the *raw* secret in process memory to recompute the HMAC, since
// (unlike a hashed password) the verifying side must reproduce the
// MAC, not just compare against it. Closing that for real means moving
// to asymmetric signing (caller signs with a private key, this package
// verifies with a stored public key) — a bigger v2 change, not
// something an at-rest cipher removes.
//
// The replay half of the tradeoff — one shared secret, verified by
// recomputing the same MAC, with nothing to stop a captured request
// from being replayed forever — is closed here by binding an
// `X-Webhook-Timestamp` into the signed material instead of signing
// `rawBody` alone. `verifySignature` rejects a delivery whose
// timestamp falls outside a 5-minute window on either side of now,
// the same window Stripe's `timestamp.signature` scheme uses. This
// still doesn't stop a delivery replayed within that window; closing
// that fully needs a tracked, per-delivery nonce (also a bigger v2
// change).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-webhook-timestamp";

const SECRET_BYTES = 32;
const TIMESTAMP_TOLERANCE_SECONDS = 300;

/** A fresh, high-entropy secret for a new or rotated trigger. */
export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

function signedMaterial(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** The HMAC-SHA256 hex digest of `timestamp.rawBody` under `secret`. */
export function signPayload(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(signedMaterial(timestamp, rawBody), "utf8")
    .digest("hex");
}

/**
 * Exported only so `trigger-ingress-routes.ts` can log a more specific
 * reason for a rejected delivery than "bad signature" — the HTTP
 * response stays the same generic 401 either way.
 */
export function isFreshTimestamp(
  timestampHeader: string | undefined,
): timestampHeader is string {
  if (timestampHeader === undefined || timestampHeader === "") return false;
  const seconds = Number(timestampHeader);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(Date.now() / 1000 - seconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/**
 * Verifies an inbound `X-Webhook-Signature` header, over
 * `X-Webhook-Timestamp.rawBody`, against the trigger's stored secret —
 * in constant time so a timing side-channel never leaks how many
 * leading bytes of a guess were correct, and only for a timestamp
 * within `TIMESTAMP_TOLERANCE_SECONDS` of now so a captured delivery
 * stops verifying once it goes stale.
 */
export function verifySignature(
  secret: string,
  timestampHeader: string | undefined,
  rawBody: string,
  providedSignatureHex: string | undefined,
): boolean {
  if (providedSignatureHex === undefined || providedSignatureHex === "") {
    return false;
  }
  if (!isFreshTimestamp(timestampHeader)) {
    return false;
  }
  const expected = signPayload(secret, timestampHeader, rawBody);
  const expectedBuffer = Buffer.from(expected, "hex");
  let providedBuffer: Buffer;
  try {
    providedBuffer = Buffer.from(providedSignatureHex, "hex");
  } catch {
    return false;
  }
  if (
    expectedBuffer.length !== providedBuffer.length ||
    expectedBuffer.length === 0
  ) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
