/**
 * The paid plans website-auditor-api names in `plan` (GET /api/subscription;
 * services/tiers.js PLANS). One list: the type and the output schema derive
 * from it, and the labels a member reads (checkUpgradeStatus.ts PLAN_LABEL)
 * are typed against it, so a plan added here fails to compile until it has
 * one. A leaf module, so a schema file can import it without loading the HTTP
 * client.
 */
export const PAID_PLANS = ["pro", "agency", "enterprise"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
