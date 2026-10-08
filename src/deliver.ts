import { createDetachedSignatureWithSigner } from "@intx/crypto";
import { assembleMessage, assembleSignedContent } from "@intx/mime";
import type { createMailTriggeredRunGrantsMaterializer } from "@intx/hub-api";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { SystemSenderIdentity, SystemSender } from "./system-sender.js";
import { base64Encode, deriveWorkflowRunId, isRunAddress } from "@intx/types";

export type MailDeliverer = {
  to: (
    address: string,
    content: string,
    tenantId: string,
    subject: string | undefined,
  ) => Promise<void>;
};

export type HookRouter = Pick<SidecarRouter, "routeMail">;

export type RunTriggerMaterialize = ReturnType<
  typeof createMailTriggeredRunGrantsMaterializer
>;

export type CreateRunTriggerDelivererOpts = {
  router: HookRouter;
  materialize: RunTriggerMaterialize;
  tenantDomain: (tenantId: string) => Promise<string>;
  /** Local part of the system sender address, e.g. "webhook" or "cron". */
  senderLocalPart: string;
  /** Durable per-tenant identity the trigger mail is signed and authenticated as. */
  systemSender: SystemSender;
};

/** `code` carried by a {@link RunTriggerUnroutableError}. */
export const RUN_MAIL_NOT_ROUTABLE = "run_mail_not_routable";

/**
 * A system trigger the sidecar router could not route: the deployment address
 * has no live socket and no disconnect queue (its sidecar is gone — e.g. a
 * stale `running` anchor left by a previous stack). Carries the address and
 * run id so the caller can report a real failure and settle the dead run
 * instead of logging a bare "not routable" every tick.
 */
export class RunTriggerUnroutableError extends Error {
  readonly code = RUN_MAIL_NOT_ROUTABLE;
  readonly address: string;
  readonly runId: string;

  constructor(address: string, runId: string) {
    super(`run mail not routable for ${address} (run ${runId})`);
    this.name = "RunTriggerUnroutableError";
    this.address = address;
    this.runId = runId;
  }
}

export function isRunTriggerUnroutable(
  error: unknown,
): error is RunTriggerUnroutableError {
  return error instanceof RunTriggerUnroutableError;
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
      switch (grants.outcome) {
        case "rejected":
          throw new Error(grants.message);
        case "skip":
          throw new Error("destination is not a workflow deployment");
        case "materialized":
          break;
        default:
          grants satisfies never;
      }

      const domain = await opts.tenantDomain(tenantId);
      const sender = await opts.systemSender.resolve({
        tenantId,
        domain,
        localPart: opts.senderLocalPart,
      });
      const raw = await assembleTriggerMail({
        address,
        content,
        tenantId,
        domain,
        subject,
        sender,
      });
      // Co-deliver the system sender's durable key with the run grants so the
      // recipient can verify the trigger mail against the key the hub vouches
      // for, exactly as a person-originated trigger does.
      const routed = await opts.router.routeMail(
        address,
        raw.base64,
        sender.address,
        raw.messageId,
        {
          runId,
          stepGrants: grants.stepGrants,
          senderIdentities: [
            { address: sender.address, publicKey: sender.publicKey },
          ],
        },
      );
      if (!routed) throw new RunTriggerUnroutableError(address, runId);
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
