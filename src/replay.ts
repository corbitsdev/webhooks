import { and, eq, lt, sql } from "drizzle-orm";
import { pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { DB } from "@intx/db";

/** Seen-set of verified deliveries, so a captured request cannot be replayed. */
export type ReplayStore = {
  /** True when `nonce` is unseen or expired for the credential; records it until `expiresAt`. */
  claim(credentialId: string, nonce: string, expiresAt: Date): Promise<boolean>;
  /** Forgets `nonce`, so a sender retry after a failed delivery is accepted. */
  release(credentialId: string, nonce: string): Promise<void>;
};

const replayTable = pgSchema("webhooks").table(
  "replay",
  {
    credentialId: text("credential_id").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.credentialId, t.nonce] })],
);

/** Shared across replicas through the host's Postgres; requires `runWebhookMigrations`. */
export function createPostgresReplayStore(db: DB["db"]): ReplayStore {
  return {
    claim: async (credentialId, nonce, expiresAt) => {
      await db.delete(replayTable).where(lt(replayTable.expiresAt, sql`now()`));
      const claimed = await db
        .insert(replayTable)
        .values({ credentialId, nonce, expiresAt })
        .onConflictDoUpdate({
          target: [replayTable.credentialId, replayTable.nonce],
          set: { expiresAt },
          setWhere: lt(replayTable.expiresAt, sql`now()`),
        })
        .returning({ nonce: replayTable.nonce });
      return claimed.length > 0;
    },
    release: async (credentialId, nonce) => {
      await db
        .delete(replayTable)
        .where(
          and(
            eq(replayTable.credentialId, credentialId),
            eq(replayTable.nonce, nonce),
          ),
        );
    },
  };
}
