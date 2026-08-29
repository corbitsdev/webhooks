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
  to: (address: string, content: string, tenantId: string) => Promise<void>;
};

export type HookMailRouter = {
  routeMail: (
    address: string,
    rawMessage: string,
    messageId?: string,
  ) => boolean;
  sendRunGrants: (
    address: string,
    runId: string,
    stepGrants: unknown,
  ) => boolean;
};

type Materialize = (args: {
  agentAddress: string;
  runId: string;
}) => Promise<{
  outcome: string;
  stepGrants?: unknown;
  code?: string;
  message?: string;
}>;

/**
 * Fire a live deployment as its run principal (mail-triggered grants),
 * not as the credential owner and not as a session-scoped user.
 */
export function createRunTriggerDeliverer(opts: {
  router: HookMailRouter;
  materialize: Materialize;
  tenantDomain: (tenantId: string) => Promise<string>;
}): MailDeliverer {
  return {
    async to(address, content, tenantId) {
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
      if (!opts.router.sendRunGrants(address, runId, grants.stepGrants)) {
        throw new Error("run grants not routable");
      }

      const domain = await opts.tenantDomain(tenantId);
      const raw = await assembleTriggerMail({
        address,
        content,
        tenantId,
        domain,
      });
      if (!opts.router.routeMail(address, raw.base64, raw.messageId)) {
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
}): Promise<{ base64: string; messageId: string }> {
  const cryptoProvider = createEd25519Crypto(await generateKeyPair());
  const messageId = `<${crypto.randomUUID()}@${opts.domain}>`;
  const headers = {
    from: `webhook@${opts.domain}`,
    to: [opts.address],
    cc: undefined,
    date: new Date(),
    messageId,
    subject: undefined,
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
