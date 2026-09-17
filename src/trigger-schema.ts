// The one product table `@corbits/webhook` owns for the trigger-CRUD
// half of this package (see `./trigger-ingress-routes.ts` and
// `./trigger-management-routes.ts`): a row per external-webhook-to-
// workflow binding. Lives in this package's own `webhook_trigger`
// Postgres schema, fully siloed from the host's own tables — see
// `./trigger-migrations.ts`.
//
// The signing secret is encrypted at rest via the host's
// `CredentialCipher` seam — see `./trigger-store.ts` for the
// encrypt/decrypt wiring and `./trigger-signature.ts` for the
// security-model note on what that does and does not close.
import { boolean, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const webhookTriggerSchema = pgSchema("webhook_trigger");

export const webhookTrigger = webhookTriggerSchema.table("webhook_trigger", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  workflowDefinitionId: text("workflow_definition_id").notNull(),
  /**
   * A template applied to the parsed JSON payload to produce the
   * message content the launched run receives — see
   * `./trigger-mapping.ts:renderInputTemplate`.
   */
  inputTemplate: text("input_template").notNull(),
  /**
   * The HMAC-SHA256 secret verified against the inbound signature
   * header, stored as a `CredentialCipher`-encrypted blob (see
   * `./trigger-store.ts`) — never returned by any route after creation
   * except a rotate response, and never in this encrypted form even
   * then.
   */
  secret: text("secret").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
});

export type WebhookTriggerRow = typeof webhookTrigger.$inferSelect;
