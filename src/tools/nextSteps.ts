/**
 * `next_steps` on a free audit: what this result found that another tool can
 * act on, as plain facts with the tool's name.
 *
 * OpenAI's app rules ("Do not advertise pricing, subscriptions, free trials,
 * discounts, or promotions"; "Plugins must not ... promote upgrades"; allowed:
 * "Explain that a certain feature is not available with the user's current
 * plan") decide the words: each entry says what exists and which tool does it.
 * No price, no trial, no "upgrade", "subscribe" or plan name, no urging. A
 * test fails on those words (tests/tools/freeAudits.test.ts).
 */
import type { AuditReport } from "../api/types.js";
import { siteHostname } from "./upgrade.js";

export interface NextStep {
  /** The tool that does it. */
  tool: string;
  /** A plain fact about this result. */
  what: string;
}

/** The finding the report's own table never counts as a fixable row (chaos_tester report_view). */
const AI_FINDING_NAME = "AI Visibility Score";
/** The engines a full audit asks. */
const ENGINE_COUNT = 6;

function isFixable(r: Record<string, unknown>): boolean {
  const impact = typeof r.impact_estimate === "number" ? r.impact_estimate : 0;
  return r.has_fix === true && impact > 0 && r.name !== AI_FINDING_NAME;
}

/** The AI engines this result did not check (the report's locked_engines). */
function lockedEngines(report: AuditReport): string[] {
  const raw = report.ai_visibility?.locked_engines;
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
}

/**
 * Which engines a free result left out, as a plain fact and with no tool name,
 * for a server that sends no next_steps (neutral copy, the Claude connector).
 * Null when every engine was checked.
 */
export function uncheckedEnginesNote(report: AuditReport): string | null {
  const locked = lockedEngines(report);
  if (locked.length === 0) return null;
  return `${ENGINE_COUNT - locked.length} of ${ENGINE_COUNT} AI engines were checked in this result; not checked: ${locked.join(", ")}.`;
}

export function freeNextSteps(report: AuditReport, domain: string): NextStep[] {
  const host = siteHostname(domain) ?? "this site";
  const steps: NextStep[] = [];

  // The same count the website's report prints as its fixable issues.
  const fixes = (report.results ?? []).filter((r) => isFixable(r as unknown as Record<string, unknown>)).length;
  if (fixes > 0) {
    steps.push({ tool: "get_fix", what: `${fixes} ${fixes === 1 ? "fix" : "fixes"} available for ${host}` });
  }

  const locked = lockedEngines(report);
  // The engines this plan did not check are covered by the weekly check, not by
  // asking run_audit again (a re-run of the same plan asks the same four).
  steps.push({
    tool: "track_site",
    what: locked.length > 0
      ? `${locked.length} of ${ENGINE_COUNT} AI engines not checked on this plan (${locked.join(", ")}); weekly monitoring of ${host} checks all ${ENGINE_COUNT}`
      : `Weekly monitoring of ${host}`,
  });
  steps.push({ tool: "get_gtm_plan", what: "A growth plan written from this audit" });
  steps.push({ tool: "compare_competitors", what: `Side-by-side AI visibility against named competitors of ${host}` });
  return steps;
}

/** One sentence for `summary`, so a reader who never opens the field still hears it. */
export function nextStepsSentence(steps: NextStep[]): string {
  return `Next steps: ${steps.map((s) => `${s.what} (${s.tool})`).join("; ")}.`;
}
