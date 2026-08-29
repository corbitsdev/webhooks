import type { DB } from "@intx/db";
import {
  credentialAad,
  isRunAddress,
  type CredentialCipher,
} from "@intx/types";

import { HOOK_VERIFY, type HookVerify } from "./verify";

export type WebhookMeta = {
  verify: HookVerify;
  /** Explicit onTrigger mail address. */
  to?: string;
  /** Asset or definition name; selects a live deployment when `to` is omitted. */
  workflow?: string;
};

export type LoadedHook = {
  credentialId: string;
  credentialName: string;
  tenantId: string;
  secret: string;
  meta: WebhookMeta;
};

export type LiveRun = {
  address: string;
  definitionName: string;
  assetName: string | null;
};

export function parseWebhookMeta(metadata: unknown): WebhookMeta | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const rec = metadata as Record<string, unknown>;
  const nested = rec["webhook"];
  if (nested === null || typeof nested !== "object") return undefined;
  const hook = nested as Record<string, unknown>;
  const verify = hook["verify"];
  if (typeof verify !== "string" || !isHookVerify(verify)) return undefined;
  const to = typeof hook["to"] === "string" ? hook["to"].trim() : "";
  const workflow =
    typeof hook["workflow"] === "string" ? hook["workflow"].trim() : "";
  return {
    verify,
    ...(to !== "" ? { to } : {}),
    ...(workflow !== "" ? { workflow } : {}),
  };
}

function isHookVerify(value: string): value is HookVerify {
  return (HOOK_VERIFY as readonly string[]).includes(value);
}

export function pickDestination(
  hook: { to?: string; workflow?: string; credentialName: string },
  runs: readonly LiveRun[],
): { ok: true; to: string } | { ok: false; code: "none" | "ambiguous" } {
  // Only addresses from `runs` (already tenant-scoped) are eligible.
  let candidates = runs.filter((r) => r.address !== "");

  if (hook.to !== undefined && hook.to !== "") {
    candidates = candidates.filter((r) => r.address === hook.to);
  } else if (hook.workflow !== undefined && hook.workflow !== "") {
    candidates = candidates.filter(
      (r) =>
        r.definitionName === hook.workflow || r.assetName === hook.workflow,
    );
  } else {
    const named = candidates.filter(
      (r) =>
        r.definitionName === hook.credentialName ||
        r.assetName === hook.credentialName,
    );
    if (named.length === 1) {
      const only = named[0];
      if (only) return { ok: true, to: only.address };
    }
    if (named.length > 1) return { ok: false, code: "ambiguous" };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (only) return { ok: true, to: only.address };
  }
  if (candidates.length === 0) return { ok: false, code: "none" };
  return { ok: false, code: "ambiguous" };
}

export async function loadWebhook(
  db: DB["db"],
  credentialCipher: CredentialCipher,
  id: string,
  tenantHint: string | undefined,
): Promise<LoadedHook | "ambiguous" | undefined> {
  const rows = await findCredentials(db, id, tenantHint);
  const hooks: LoadedHook[] = [];
  for (const row of rows) {
    if (row.status !== "active") continue;
    // Tenant-owned only — personal creds are not ingress keys.
    if (row.principalId !== null && row.principalId !== undefined) continue;
    if (tenantHint && row.tenantId !== tenantHint) continue;
    const meta = parseWebhookMeta(row.metadata);
    if (!meta) continue;
    const secret = await credentialCipher.decrypt(
      row.secret,
      credentialAad(row.id, "secret"),
    );
    hooks.push({
      credentialId: row.id,
      credentialName: row.name,
      tenantId: row.tenantId,
      secret,
      meta,
    });
  }
  if (hooks.length === 0) return undefined;
  if (hooks.length > 1) return "ambiguous";
  return hooks[0];
}

async function findCredentials(
  db: DB["db"],
  id: string,
  tenantHint: string | undefined,
): Promise<
  {
    id: string;
    name: string;
    tenantId: string;
    principalId: string | null;
    secret: string;
    status: string;
    metadata: unknown;
  }[]
> {
  if (id.startsWith("crd_")) {
    const row = await db.query.credential.findFirst({
      where: (c, { eq }) => eq(c.id, id),
    });
    return row ? [row] : [];
  }

  // Names are tenant-scoped. No cross-tenant scan.
  if (tenantHint === undefined || tenantHint === "") return [];
  const row = await db.query.credential.findFirst({
    where: (c, { and, eq }) => and(eq(c.tenantId, tenantHint), eq(c.name, id)),
  });
  return row ? [row] : [];
}

export async function listLiveMailRuns(
  db: DB["db"],
  tenantId: string,
): Promise<LiveRun[]> {
  const runs = await db.query.workflowRun.findMany({
    where: (run, { and, eq, isNotNull, inArray }) =>
      and(
        eq(run.tenantId, tenantId),
        inArray(run.status, ["deployed", "running"]),
        isNotNull(run.address),
      ),
  });
  const anchors = runs.filter(
    (r) => r.address && r.anchorRunId === r.id,
  );
  if (anchors.length === 0) return [];

  const defIds = [...new Set(anchors.map((r) => r.definitionId))];
  const defs = await db.query.workflowDefinition.findMany({
    where: (d, { inArray }) => inArray(d.id, defIds),
  });
  const defById = new Map(defs.map((d) => [d.id, d]));

  const assetIds = [
    ...new Set(
      defs
        .map((d) => d.assetId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];
  const assets =
    assetIds.length === 0
      ? []
      : await db.query.asset.findMany({
          where: (a, { inArray }) => inArray(a.id, assetIds),
        });
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const live: LiveRun[] = [];
  for (const run of anchors) {
    if (!run.address || !isRunAddress(run.address)) continue;
    const def = defById.get(run.definitionId);
    live.push({
      address: run.address,
      definitionName: def?.name ?? "",
      assetName: def?.assetId ? (assetById.get(def.assetId)?.name ?? null) : null,
    });
  }
  return live;
}
