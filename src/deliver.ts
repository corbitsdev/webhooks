import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import {
  assembleMessage,
  assembleSignedContent,
  createDetachedSignatureFromProvider,
} from "@intx/mime";
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
};

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
      // A system trigger carries no inbound sender, so there is no sender
      // key to co-deliver on this barrier.
      if (
        !opts.router.sendRunGrants(address, runId, grants.stepGrants, undefined)
      ) {
        throw new Error("run grants not routable");
      }

      const domain = await opts.tenantDomain(tenantId);
      const raw = await assembleTriggerMail({
        address,
        content,
        tenantId,
        domain,
        subject,
        senderLocalPart: opts.senderLocalPart,
      });
      // The run is the mail's own recipient and trigger; it is also the
      // authenticated sender of its own trigger mail.
      if (
        !opts.router.routeMail(address, raw.base64, address, raw.messageId)
      ) {
        throw new Error("run mail not routable");
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
  senderLocalPart: string;
}): Promise<{ base64: string; messageId: string }> {
  const cryptoProvider = createEd25519Crypto(await generateKeyPair());
  const messageId = `<${crypto.randomUUID()}@${opts.domain}>`;
  const headers = {
    from: `${opts.senderLocalPart}@${opts.domain}`,
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
  const signature = await createDetachedSignatureFromProvider(
    signedContent,
    cryptoProvider,
  );
  const rawMessage = assembleMessage(headers, signedContent, signature);
  return { base64: base64Encode(rawMessage), messageId };
}
