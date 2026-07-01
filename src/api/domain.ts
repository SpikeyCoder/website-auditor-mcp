import { WaApiError } from "./errors.js";

/**
 * Normalize and validate a domain/URL argument. Accepts "example.com",
 * "https://example.com", "http://example.com/path". Returns the bare host
 * (lowercased, no scheme/path). Throws INVALID_INPUT on anything that isn't a
 * plausible domain.
 */
export function normalizeDomain(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new WaApiError("INVALID_INPUT", "A domain is required, e.g. \"example.com\".");

  let host = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch {
      throw new WaApiError("INVALID_INPUT", `Not a valid URL: ${raw}`);
    }
  } else {
    // Strip a path/query if the caller passed "example.com/foo".
    host = raw.split("/")[0] ?? raw;
  }

  host = host.toLowerCase().replace(/^www\./, "");

  // A conservative hostname check: labels of alphanumerics/hyphens, a dot, and
  // a 2+ char TLD. Mirrors the server-side validation in website-auditor.io.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host)) {
    throw new WaApiError("INVALID_INPUT", `Not a valid domain: ${input}. Example: example.com`);
  }
  return host;
}

/**
 * Derive a human-ish business name from a domain, used to satisfy the API's
 * required `businessName` param. The upstream audit re-detects the real name
 * from the site content, so this is only a fallback label.
 */
export function deriveBusinessName(host: string): string {
  const label = host.replace(/\.[a-z.]+$/i, ""); // drop TLD(s)
  return label
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || host;
}
