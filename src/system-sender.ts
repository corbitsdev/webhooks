import { generateId } from "@intx/hub-common";
import {
  createPrincipalStore,
  type DB,
  type PrincipalKeyStore,
} from "@intx/db";

/** The durable identity a system trigger signs and is authenticated as. */
export type SystemSenderIdentity = {
  address: string;
  /** Hex-encoded Ed25519 public key the recipient verifies the mail against. */
  publicKey: string;
  sign: (input: Uint8Array) => Promise<Uint8Array>;
};

export type SystemSender = {
  resolve: (args: {
    tenantId: string;
    domain: string;
    localPart: string;
  }) => Promise<SystemSenderIdentity>;
};

export type CreateTenantSystemSenderOpts = {
  db: DB["db"];
  principalKeyStore: PrincipalKeyStore;
};

/**
 * Back a system sender (`cron@domain`, `webhook@domain`) with one durable
 * principal per tenant and local part, minted once and reused after.
 *
 * The principal is `kind: "user"` because Interchange's sender-key resolver
 * only resolves a non-run address to a hub-custodied key through a user
 * principal; any other kind would make the recipient's verification miss.
 */
export function createTenantSystemSender(
  opts: CreateTenantSystemSenderOpts,
): SystemSender {
  const principalStore = createPrincipalStore(opts.db, opts.principalKeyStore);

  async function find(
    tenantId: string,
    localPart: string,
  ): Promise<string | undefined> {
    const row = await opts.db.query.principal.findFirst({
      where: (p, { and, eq }) =>
        and(
          eq(p.tenantId, tenantId),
          eq(p.kind, "user"),
          eq(p.refId, localPart),
        ),
    });
    return row?.id;
  }

  return {
    async resolve({ tenantId, domain, localPart }) {
      const existing = await find(tenantId, localPart);
      const created =
        existing === undefined
          ? await principalStore.createIfAbsent({
              id: generateId("principal"),
              tenantId,
              kind: "user",
              refId: localPart,
              status: "active",
            })
          : null;
      // A lost insert race means the winner already minted the one active key.
      const principalId = existing ?? created?.id ?? (await find(tenantId, localPart));
      if (principalId === undefined) {
        throw new Error(
          `no system sender principal "${localPart}" in tenant ${tenantId}`,
        );
      }
      return {
        address: `${localPart}@${domain}`,
        publicKey: await opts.principalKeyStore.getPublicKey(principalId),
        sign: (input) => opts.principalKeyStore.sign(principalId, input),
      };
    },
  };
}
