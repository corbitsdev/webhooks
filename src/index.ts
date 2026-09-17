export { installWebhooks, type InstallWebhooksOpts } from "./install";
export type { HookMailRouter } from "./deliver";

// Trigger-CRUD half of the package: a persisted webhook_trigger row
// per external-webhook-to-workflow binding, HMAC ingress verification,
// tenant-scoped management routes, and launch through
// `prepareProvisionedDeployment`. Ported from Workbench's
// `packages/webhook-triggers` — see README.md for the mount shape.
export {
  applyWebhookTriggerMigrations,
  WEBHOOK_TRIGGER_MIGRATIONS,
  type ApplyWebhookTriggerMigrationsReport,
  type WebhookTriggerMigration,
} from "./trigger-migrations";
export {
  webhookTrigger,
  webhookTriggerSchema,
  type WebhookTriggerRow,
} from "./trigger-schema";
export {
  createDrizzleWebhookTriggerStore,
  type CreateWebhookTriggerInput,
  type WebhookTriggerStore,
  type WebhookTriggerDb,
} from "./trigger-store";
export {
  generateWebhookSecret,
  signPayload,
  verifySignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./trigger-signature";
export { renderInputTemplate } from "./trigger-mapping";
export {
  launchWebhookTrigger,
  type LaunchWebhookTriggerDeps,
  type LaunchedWebhookTrigger,
  type CryptoProviderCache,
  type PreparedDeployContent,
} from "./trigger-launch";
export {
  createWebhookTriggerIngressRoutes,
  type CreateWebhookTriggerIngressRoutesDeps,
} from "./trigger-ingress-routes";
export {
  createWebhookTriggerRoutes,
  type CreateWebhookTriggerRoutesDeps,
} from "./trigger-management-routes";
export {
  mountWebhookTrigger,
  type MountWebhookTriggerOpts,
} from "./mount-trigger";
