// The external-facing half of this package: a service outside the
// host's control posts here to kick off a workflow run. This is THE
// trust boundary — no session cookie, no tenant membership, nothing
// about the caller is trusted except what the HMAC signature over
// `timestamp.rawBody` proves, and proves only within the freshness
// window `verifySignature` enforces (see `./trigger-signature.ts`) —
// so a captured, byte-for-byte replay of a real delivery stops
// verifying once it goes stale. Every failure mode here is loud and
// specific in the log, but every one of unknown trigger, disabled
// trigger, and bad/missing/stale signature returns the SAME generic
// 401 `unauthorized` response, so a probe against a wrong triggerId
// cannot distinguish "no such trigger" from "disabled" from "wrong
// secret" from "replayed".
import { Hono } from "hono";
import type { Env } from "hono";
import { getLogger } from "@intx/log";

import type { LaunchedWebhookTrigger } from "./trigger-launch";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  isFreshTimestamp,
  verifySignature,
} from "./trigger-signature";
import type { WebhookTriggerRow } from "./trigger-schema";
import type { WebhookTriggerStore } from "./trigger-store";

const log = getLogger(["webhook", "trigger-ingress"]);

const unauthorized = () =>
  ({ error: "unauthorized", message: "invalid or missing signature" }) as const;

export type CreateWebhookTriggerIngressRoutesDeps = {
  store: WebhookTriggerStore;
  /**
   * The host composes this as `(trigger, payload) =>
   * launchWebhookTrigger(deps, trigger, payload)`, closing over the
   * real launch deps — kept as a seam here (rather than this module
   * importing `launchWebhookTrigger` directly) so the route's own
   * parsing/signature/lookup logic is testable without a database or
   * the launch machinery.
   */
  launch: (
    trigger: WebhookTriggerRow,
    payload: unknown,
  ) => Promise<LaunchedWebhookTrigger>;
};

/**
 * Mounts `POST /:triggerId`, the single ingress endpoint. Intended to
 * be mounted OUTSIDE the host's tenant-resolution middleware — this
 * route resolves its own tenant scope by looking the trigger up by
 * id, since the caller carries no session and no tenant path segment.
 */
export function createWebhookTriggerIngressRoutes(
  deps: CreateWebhookTriggerIngressRoutesDeps,
): Hono<Env> {
  const app = new Hono<Env>();

  app.post("/:triggerId", async (c) => {
    const triggerId = c.req.param("triggerId");
    const trigger = await deps.store.getById(triggerId);
    if (trigger === undefined) {
      log.info("Webhook delivery for unknown trigger {triggerId}", {
        triggerId,
      });
      return c.json(unauthorized(), 401);
    }

    if (!trigger.enabled) {
      log.info("Webhook delivery for disabled trigger {triggerId}", {
        triggerId,
      });
      return c.json(unauthorized(), 401);
    }

    const rawBody = await c.req.text();
    const signatureHeader = c.req.header(WEBHOOK_SIGNATURE_HEADER);
    const timestampHeader = c.req.header(WEBHOOK_TIMESTAMP_HEADER);
    if (
      !verifySignature(
        trigger.secret,
        timestampHeader,
        rawBody,
        signatureHeader,
      )
    ) {
      const reason = isFreshTimestamp(timestampHeader)
        ? "bad signature"
        : "missing or stale timestamp";
      log.warn("Rejected webhook delivery for trigger {triggerId}: {reason}", {
        triggerId,
        reason,
      });
      return c.json(unauthorized(), 401);
    }

    let payload: unknown;
    try {
      payload = rawBody === "" ? {} : JSON.parse(rawBody);
    } catch {
      return c.json(
        { error: "bad_request", message: "payload is not valid JSON" },
        400,
      );
    }

    const launched = await deps.launch(trigger, payload);
    await deps.store.recordFired(trigger.id, new Date());

    return c.json(
      { instanceId: launched.instanceId, address: launched.triggerAddress },
      202,
    );
  });

  return app;
}
