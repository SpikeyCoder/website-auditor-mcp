/**
 * The member's own dashboard, linked from the success replies of the tools
 * that are about a site.
 *
 * WHY. Trialists who used the product inside ChatGPT or Claude mostly never
 * opened the dashboard: a reply is JSON the model summarises, and nothing in it
 * pointed at the page where the AI crawler check, the competitors and the
 * visits from AI assistants live. The reply now carries `dashboard`
 * ({ url, note }) and the same sentence is folded into `summary`, the text the
 * model reads.
 *
 * THE RULES, each one a way this went wrong on paper before it was written:
 *   * Pro members only. A caller without Pro gets no `dashboard` key and no
 *     line about one: the link is the member's own page, and an "upgrade to
 *     see your dashboard" sentence would be promotion under the OpenAI and
 *     Anthropic directory rules. The paywall answers already say what they say.
 *   * `?site=` only for a site the member tracks. The dashboard ignores a site
 *     that is not one of the member's active tracked domains and opens their
 *     first one instead, so a link that names an untracked site would open a
 *     different site than the one just discussed. For an untracked site, or a
 *     member who tracks nothing, the link is the plain dashboard and the note
 *     says to track the site first.
 *   * No `refresh=1`. It makes the dashboard re-ask every model on arrival and
 *     spends the member's weekly claims; a link in a conversation must not.
 *   * One `src` label, `<channel>-<tool>`, from a closed set. It is read by
 *     the dashboard's counters, so a tool or channel that is not on the list
 *     reads as `other` / `mcp` rather than becoming a new value. It never
 *     carries the domain.
 *   * The link must never cost the reply. One read of GET /api/tracked-domains
 *     per call (or none when the tool already holds the list), a short
 *     timeout, and any failure means no link. Callers invoke this only after
 *     their own work succeeded, so a failing tool never gains a read.
 *   * Neutral words: what is on the dashboard, nothing about price, trials or
 *     plans.
 */
import { normalizeDomain } from "../api/domain.js";
import { isPro } from "../auth/entitlements.js";
import type { DashboardLink } from "../api/types.js";
import type { LinkChannel } from "../config.js";
import type { ToolDeps } from "./context.js";

export type { DashboardLink };

/** The tools that carry a link. Anything else is labelled "other". */
export const DASHBOARD_LINK_TOOLS = [
  "run_audit",
  "get_ai_visibility",
  "get_monitoring_status",
  "compare_competitors",
  "get_recommendations",
  "get_gtm_plan",
  "track_site",
] as const;
export type DashboardLinkTool = (typeof DASHBOARD_LINK_TOOLS)[number];

const CHANNELS: readonly LinkChannel[] = ["mcp", "chatgpt", "claude"];

/** How long the tracked-domains read may take before the link is skipped. */
export const TRACKED_READ_TIMEOUT_MS = 1500;

/** `<channel>-<tool>` from the closed sets; the domain is never part of it. */
export function linkLabel(channel: string | undefined, tool: string): string {
  const c = CHANNELS.find((x) => x === channel) ?? "mcp";
  const t = (DASHBOARD_LINK_TOOLS as readonly string[]).includes(tool) ? tool : "other";
  return `${c}-${t}`;
}

function host(input: string | undefined): string | undefined {
  if (!input) return undefined;
  try {
    return normalizeDomain(input);
  } catch {
    return undefined;
  }
}

const WHAT = "the AI crawler check, your competitors and visits from AI assistants";

/** Appends the link's note to a summary sentence; a missing link changes nothing. */
export function withDashboardNote(summary: string, link: DashboardLink | null): string {
  return link ? `${summary} ${link.note}` : summary;
}

/** The result's optional field: present only when there is a link. */
export function dashboardField(link: DashboardLink | null): { dashboard: DashboardLink } | Record<string, never> {
  return link ? { dashboard: link } : {};
}

export interface DashboardLinkOptions {
  /**
   * The member's active tracked domains when the tool already holds them
   * (get_monitoring_status, track_site). When given, no read is made.
   */
  tracked?: readonly string[];
}

/**
 * Build the link for a successful reply, or null (not Pro, the read failed,
 * or the domain is unusable). `domain` is the site the reply is about; omit it
 * for a reply about all of the member's sites.
 */
export async function dashboardLink(
  deps: ToolDeps,
  tool: string,
  domain?: string,
  opts: DashboardLinkOptions = {},
): Promise<DashboardLink | null> {
  try {
    const resolved = await deps.subscriptions.resolve(deps.config.apiKey);
    if (!isPro(resolved.tier)) return null;

    const trackedHosts = await trackedHostsFor(deps, opts.tracked);
    if (!trackedHosts) return null;

    const base = `${deps.config.siteUrl}/dashboard`;
    const src = `src=${encodeURIComponent(linkLabel(deps.config.linkChannel, tool))}`;
    const asked = host(domain);
    // A reply about all of the member's sites points at the first one they
    // track, which is the site the dashboard opens on its own.
    const site = asked ?? (domain === undefined ? trackedHosts[0] : undefined);

    if (site && trackedHosts.includes(site)) {
      const url = `${base}?site=${encodeURIComponent(site)}&${src}`;
      return { url, note: `Your dashboard for ${site} shows ${WHAT}: ${url}` };
    }

    const url = `${base}?${src}`;
    const what = asked ? `Track ${asked} (track_site)` : "Track a site (track_site)";
    return { url, note: `${what} to see it on your dashboard, which shows ${WHAT}: ${url}` };
  } catch {
    return null;
  }
}

async function trackedHostsFor(
  deps: ToolDeps,
  known: readonly string[] | undefined,
): Promise<string[] | null> {
  let raw: readonly string[];
  if (known) {
    raw = known;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const list = await Promise.race([
        deps.client.listTrackedDomains(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("tracked-domains read timed out")), TRACKED_READ_TIMEOUT_MS);
        }),
      ]);
      raw = list.tracked.filter((t) => t.active !== false).map((t) => t.domain);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return raw.map((d) => host(d)).filter((h): h is string => h !== undefined);
}
