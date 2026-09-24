import { createDetachedSignatureWithSigner } from "@intx/crypto";
import { assembleMessage, assembleSignedContent } from "@intx/mime";
import type { SystemSenderIdentity, SystemSender } from "./system-sender.js";
import {
  base64Encode,
  deriveWorkflowRunId,
  isRunAddress,
} from "@intx/types";

export type MailDeliverer = {
  to: (
    address: string,
    content: string,
    tenantId: string,
    subject: string | undefined,
  ) => Promise<void>;
};

export type HookMailRouter = {
  routeMail: (
    address: string,
    rawMessage: string,
    authenticatedSender: string,
    messageId?: string,
  ) => boolean;
  sendRunGrants: (
    address: string,
    runId: string,
    stepGrants: unknown,
    senderIdentities: unknown,
  ) => boolean;
};

export type RunTriggerMaterialize = (args: {
  agentAddress: string;
  runId: string;
}) => Promise<{
  outcome: string;
  stepGrants?: unknown;
  code?: string;
  message?: string;
}>;

export type CreateRunTriggerDelivererOpts = {
  router: HookMailRouter;
  materialize: RunTriggerMaterialize;
  tenantDomain: (tenantId: string) => Promise<string>;
  /** Local part of the system sender address, e.g. "webhook" or "cron". */
  senderLocalPart: string;
  /** Durable per-tenant identity the trigger mail is signed and authenticated as. */
  systemSender: SystemSender;
};

/** `code` carried by a {@link RunTriggerUnroutableError}. */
export const RUN_GRANTS_NOT_ROUTABLE = "run_grants_not_routable";
export const RUN_MAIL_NOT_ROUTABLE = "run_mail_not_routable";

export type RunTriggerUnroutableCode =
  | typeof RUN_GRANTS_NOT_ROUTABLE
  | typeof RUN_MAIL_NOT_ROUTABLE;

/**
 * A system trigger the sidecar router could not route: the deployment address
 * has no live socket and no disconnect queue (its sidecar is gone — e.g. a
 * stale `running` anchor left by a previous stack). Carries the address and
 * run id so the caller can report a real failure and settle the dead run
 * instead of logging a bare "not routable" every tick. The message keeps the
 * legacy `run grants not routable` / `run mail not routable` prefix.
 */
export class RunTriggerUnroutableError extends Error {
  readonly code: RunTriggerUnroutableCode;
  readonly address: string;
  readonly runId: string;

  constructor(code: RunTriggerUnroutableCode, address: string, runId: string) {
    super(
      `${code === RUN_GRANTS_NOT_ROUTABLE ? "run grants" : "run mail"} not routable for ${address} (run ${runId})`,
    );
    this.name = "RunTriggerUnroutableError";
    this.code = code;
    this.address = address;
    this.runId = runId;
  }
}

/**
 * Structural match for a {@link RunTriggerUnroutableError}. Structural — not
 * `instanceof` — so callers that stay dependency-free (e.g. `@corbits/cron`,
 * which speaks to this deliverer through the `MailDeliverer` shape alone)
 * can match the same contract without importing this package.
 */
export function isRunTriggerUnroutable(error: unknown): error is RunTriggerUnroutableError {
  if (typeof error !== "object" || error === null) return false;
  const rec = error as Record<string, unknown>;
  return (
    (rec["code"] === RUN_GRANTS_NOT_ROUTABLE || rec["code"] === RUN_MAIL_NOT_ROUTABLE) &&
    typeof rec["address"] === "string" &&
    typeof rec["runId"] === "string"
  );
}

/**
 * Fire a live deployment as its run principal (mail-triggered grants),
 * not as the credential owner and not as a session-scoped user.
 */
export function createRunTriggerDeliverer(
  opts: CreateRunTriggerDelivererOpts,
): MailDeliverer {
  return {
    async to(address, content, tenantId, subject) {
      if (!isRunAddress(address)) {
        throw new Error("destination is not a live run address");
      }
      const runId = deriveWorkflowRunId(address);
      const grants = await opts.materialize({
        agentAddress: address,
        runId,
      });
      if (grants.outcome === "rejected") {
        throw new Error(grants.message ?? grants.code ?? "rejected");
      }
      if (grants.outcome !== "materialized" || grants.stepGrants === undefined) {
        throw new Error("destination is not a workflow deployment");
      }

      const domain = await opts.tenantDomain(tenantId);
      const sender = await opts.systemSender.resolve({
        tenantId,
        domain,
        localPart: opts.senderLocalPart,
      });
      // Co-deliver the system sender's durable key on the grants barrier so
      // the recipient can verify the trigger mail against the key the hub
      // vouches for, exactly as a person-originated trigger does.
      if (
        !opts.router.sendRunGrants(address, runId, grants.stepGrants, [
          { address: sender.address, publicKey: sender.publicKey },
        ])
      ) {
        throw new RunTriggerUnroutableError(RUN_GRANTS_NOT_ROUTABLE, address, runId);
      }

      const raw = await assembleTriggerMail({
        address,
        content,
        tenantId,
        domain,
        subject,
        sender,
      });
      if (
        !opts.router.routeMail(address, raw.base64, sender.address, raw.messageId)
      ) {
        throw new RunTriggerUnroutableError(RUN_MAIL_NOT_ROUTABLE, address, runId);
      }
    },
  };
}

async function assembleTriggerMail(opts: {
  address: string;
  content: string;
  tenantId: string;
  domain: string;
  subject: string | undefined;
  sender: SystemSenderIdentity;
}): Promise<{ base64: string; messageId: string }> {
  const messageId = `<${crypto.randomUUID()}@${opts.domain}>`;
  const headers = {
    from: opts.sender.address,
    to: [opts.address],
    cc: undefined,
    date: new Date(),
    messageId,
    subject: opts.subject,
    inReplyTo: undefined,
    references: undefined,
    mimeVersion: "1.0" as const,
    interchangeType: "conversation.message" as const,
    interchangeCorrelationId: undefined,
    interchangeAgentId: undefined,
    interchangeSessionId: undefined,
    interchangeOfferingId: undefined,
    interchangeSchemaVersion: undefined,
    interchangeTenantId: opts.tenantId,
    traceparent: undefined,
    tracestate: undefined,
  };
  const signedContent = assembleSignedContent({
    kind: "conversation",
    text: opts.content,
  });
  const signature = await createDetachedSignatureWithSigner(
    signedContent,
    (input) => opts.sender.sign(input),
  );
  const rawMessage = assembleMessage(headers, signedContent, signature);
  return { base64: base64Encode(rawMessage), messageId };
}
