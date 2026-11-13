/**
 * The paid plans website-auditor-api names in `plan` (GET /api/subscription;
 * services/tiers.js PLANS). One list: the type, the labels in what a member
 * reads and the output schema all derive from it. A leaf module, so a schema
 * file can import it without loading the HTTP client.
 */
export const PAID_PLANS = ["pro", "agency", "enterprise"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
