// Launches a workflow run from a verified webhook delivery through
// the host's own provisioned-deployment machinery — the same call a
// provisioned front chat's own launch path already drives. This
// package resolves the definition row and asks the host to provision
// its existing asset HEAD; it does not mint the run row itself, and it
// does not depend on any workflow-allocation or session-service shape
// beyond the single function each is reduced to below.
//
// Every host-specific concern — how a workflow definition's asset
// projection folds into a system prompt and tool-package pins, how a
// tenant's git store resolves an asset ref to a commit sha, how a
// freshly provisioned run's agent session gets recorded, how mail
// retries until the sidecar is routable — is supplied as a callback
// rather than imported from a host package directly, so this library
// carries no dependency on any workflow-authoring domain logic or
// unpublished host-internal types.
//
// Opening mail is one `sendUserMessage` call. Launch is async: mail
// sent before ready is queued. A delivery already accepted (202) has
// already committed a real run by the time this send runs, so a
// failed mail must not throw past `createWebhookTriggerIngressRoutes`
// — that would both hide the run (no `store.recordFired` call) and,
// if the sender's webhook client retries the same delivery on a 5xx,
// mint a second, duplicate run for one event. On send failure this
// only calls `deps.onDeliveryError`, naming the run.
import { listVisibleOfferings, type DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import type { CredentialCipher } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import { and, eq } from "drizzle-orm";

import { renderInputTemplate } from "./trigger-mapping";
import type { WebhookTriggerRow } from "./trigger-schema";

export type CryptoProviderCache = {
  get(key: string): Promise<CryptoProvider>;
};

export type PreparedDeployContent = {
  systemPrompt: string;
  toolPackagePins: readonly unknown[];
};

export type PrepareProvisionedDeploymentInput = {
  readonly tenantId: string;
  readonly anchorRunId: string;
  readonly sessionId: string;
  readonly deploymentDomain: string;
  readonly assetId: string;
  readonly commitSha: string;
  readonly entry: string;
  readonly sourceAuthorityPrincipalId: string;
  readonly sourceOfferingIds: readonly string[];
  readonly defaultSourceOfferingId: string;
  readonly toolPackagePins: readonly unknown[];
};

export type PreparedProvisionedDeployment = {
  readonly anchorRunId: string;
  readonly deploymentAddress: string;
};

export type LaunchWebhookTriggerDeps = {
  db: DB["db"];
  /** Resolves the definition asset's HEAD to a commit sha; `null` if it has none. */
  resolveAssetCommitSha: (assetId: string) => Promise<string | null>;
  /** The host's `WorkflowAllocationService.prepareProvisionedDeployment`, or an equivalent. */
  prepareProvisionedDeployment: (
    input: PrepareProvisionedDeploymentInput,
  ) => Promise<PreparedProvisionedDeployment>;
  /** The host's `SessionService.sendUserMessage`, or an equivalent. */
  sendUserMessage: (input: {
    agentAddress: string;
    from: string;
    messageId: string;
    date: Date;
    content: string;
    sessionId: string;
    tenantId: string;
    cryptoProvider: CryptoProvider;
  }) => Promise<unknown>;
  /** Reads the host's live sidecar routing table for `deliverWhenRoutable`. */
  isRoutable: (address: string) => boolean;
  cryptoProviderCache: CryptoProviderCache;
  credentialCipher: CredentialCipher;
  /** Passed through to `prepareProvisionedDeployment` as `entry`. */
  workflowSourceEntry: string;
  /**
   * Reads the definition's asset projection and folds its grant
   * requirements into deployable content. Should throw if the
   * definition cannot be launched without a system prompt configured.
   */
  prepareDeployContent: (input: {
    db: DB["db"];
    definitionRow: typeof workflowDefinition.$inferSelect;
  }) => Promise<PreparedDeployContent>;
  /**
   * Records the run's agent session (and any event collector) the
   * instant `prepareProvisionedDeployment` returns.
   */
  afterProvision: (input: {
    db: DB["db"];
    runId: string;
    sessionId: string;
    sourceAuthorityPrincipalId: string;
  }) => Promise<void>;
  /**
   * Retries the opening mail send once the deployment address is
   * routable, since a freshly provisioned run's sidecar takes several
   * seconds to boot and register.
   */
  deliverWhenRoutable: (input: {
    send: () => Promise<void>;
    isRoutable: () => boolean;
  }) => Promise<void>;
  /** Reports a failed opening-mail send without throwing past the ingress route. */
  onDeliveryError: (
    error: unknown,
    context: {
      tenantId: string;
      agentId: string;
      instanceId: string;
      triggerId: string;
    },
  ) => void;
  /**
   * Records the relaunch mapping after the run has been prepared.
   * Invoked with the returned `anchorRunId`, not a pre-minted id.
   */
  persistLaunch: (input: {
    readonly tenantId: string;
    readonly instanceId: string;
  }) => void | Promise<void>;
  /** Records the inference chain the launch just deployed with. */
  recordLaunchSources: (input: {
    readonly instanceId: string;
    readonly sourcesDigest: string;
  }) => Promise<void>;
  generateId: (kind: "workflowRun" | "session") => string;
};

export type LaunchedWebhookTrigger = {
  readonly instanceId: string;
  readonly triggerAddress: string;
};

function offeringDigest(sourceOfferingIds: readonly string[]): string {
  return sourceOfferingIds.join("\0");
}

/**
 * Resolves the trigger's referenced workflow definition (must be
 * deployed and materialized), provisions its existing asset HEAD
 * through the host's workflow allocation service, then delivers the
 * rendered input mapping as the run's first inbound message. The
 * webhook sender itself is never a principal on the platform, so the
 * mail's `from` names the trigger, not a person.
 */
export async function launchWebhookTrigger(
  deps: LaunchWebhookTriggerDeps,
  trigger: WebhookTriggerRow,
  payload: unknown,
): Promise<LaunchedWebhookTrigger> {
  const definitionRow = await deps.db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.id, trigger.workflowDefinitionId),
      eq(workflowDefinition.tenantId, trigger.tenantId),
    ),
  });
  if (definitionRow === undefined) {
    throw new Error(
      `webhook trigger "${trigger.id}" names no workflow definition ` +
        `"${trigger.workflowDefinitionId}" for its tenant`,
    );
  }
  if (definitionRow.status !== "deployed") {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" is not in a ` +
        `launchable state (status: ${definitionRow.status})`,
    );
  }
  if (definitionRow.assetId === null) {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" has not been ` +
        "materialized",
    );
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenantTable.id, trigger.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`no tenant "${trigger.tenantId}"`);
  }

  const deployContent = await deps.prepareDeployContent({
    db: deps.db,
    definitionRow,
  });

  const offerings = [
    ...(await listVisibleOfferings(deps.db, trigger.tenantId)),
  ].sort((a, b) => a.offering.priority - b.offering.priority);
  const sourceOfferingIds = offerings.map((o) => o.offering.id);
  const defaultSourceOfferingId = sourceOfferingIds[0];
  if (defaultSourceOfferingId === undefined) {
    throw new Error(
      `no catalog offerings visible to tenant "${trigger.tenantId}"`,
    );
  }

  const assetId = definitionRow.assetId;
  const commitSha = await deps.resolveAssetCommitSha(assetId);
  if (commitSha === null) {
    throw new Error(`definition asset "${assetId}" has no HEAD`);
  }
  const anchorRunId = deps.generateId("workflowRun");
  const sessionId = deps.generateId("session");

  const prepared = await deps.prepareProvisionedDeployment({
    tenantId: trigger.tenantId,
    anchorRunId,
    sessionId,
    deploymentDomain: tenantRow.domain,
    assetId,
    commitSha,
    entry: deps.workflowSourceEntry,
    sourceAuthorityPrincipalId: trigger.createdBy,
    sourceOfferingIds,
    defaultSourceOfferingId,
    toolPackagePins: deployContent.toolPackagePins,
  });

  await deps.afterProvision({
    db: deps.db,
    runId: prepared.anchorRunId,
    sessionId,
    sourceAuthorityPrincipalId: trigger.createdBy,
  });

  await deps.persistLaunch({
    tenantId: trigger.tenantId,
    instanceId: prepared.anchorRunId,
  });
  await deps.recordLaunchSources({
    instanceId: prepared.anchorRunId,
    sourcesDigest: offeringDigest(sourceOfferingIds),
  });

  const content = renderInputTemplate(trigger.inputTemplate, payload);
  const cryptoProvider = await deps.cryptoProviderCache.get(
    prepared.anchorRunId,
  );
  try {
    await deps.deliverWhenRoutable({
      send: async () => {
        await deps.sendUserMessage({
          agentAddress: prepared.deploymentAddress,
          from: `webhook-trigger:${trigger.id}`,
          messageId: `<${crypto.randomUUID()}@${tenantRow.domain}>`,
          date: new Date(),
          content,
          sessionId,
          tenantId: trigger.tenantId,
          cryptoProvider,
        });
      },
      isRoutable: () => deps.isRoutable(prepared.deploymentAddress),
    });
  } catch (error) {
    deps.onDeliveryError(error, {
      tenantId: trigger.tenantId,
      agentId: prepared.deploymentAddress,
      instanceId: prepared.anchorRunId,
      triggerId: trigger.id,
    });
  }

  return {
    instanceId: prepared.anchorRunId,
    triggerAddress: prepared.deploymentAddress,
  };
}
