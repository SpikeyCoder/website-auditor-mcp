/**
 * Anonymous install id.
 *
 * Exists to answer a question the telemetry previously could not: how many
 * DISTINCT people install this server. Keyless events carry no api_key_id and no
 * user_id — by design, there is no key to resolve identity from — and the MCP
 * re-initialises on every client launch or reconnect, so session_init counts are
 * inflated by restarts. 102 keyless sessions in July 2026 could have been 6
 * people or 60, and nothing in the data separated those cases. Without this,
 * "are developers bouncing off the paywall?" is unanswerable and any fix for it
 * is unmeasurable.
 *
 * ANONYMOUS BY CONSTRUCTION. A random v4 UUID — never derived from hostname,
 * username, MAC address, or anything else about the machine. It is not a
 * fingerprint and cannot be reversed into an identity. Its only power is
 * collapsing N restarts into 1 install; a forged value can pollute install
 * counts and nothing else.
 *
 * OPT-OUT IS ABSOLUTE: with WA_METRICS_DISABLED set, no id is generated and
 * nothing is written to disk. Opting out must not leave a persistent identifier
 * behind.
 *
 * Best-effort throughout. A read-only home, a sandboxed environment or a
 * corrupt file yields `undefined` — the event still sends, just uncounted.
 * Telemetry must never break the server on startup.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WaConfig } from "../config.js";

const FILE_NAME = "install-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Resolved once per process — this is read on every event emission. */
let cached: string | undefined;
let resolved = false;

/** Test seam: forget the memoized value so a fresh process can be simulated. */
export function __resetInstallIdCacheForTests(): void {
  cached = undefined;
  resolved = false;
}

/** Where the id lives. Honours XDG_CONFIG_HOME, else ~/.config. */
function defaultDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), ".config"), "website-auditor-mcp");
}

/**
 * Read the persisted install id, creating one on first run.
 *
 * @param dir overrides the storage directory (tests); defaults to the config dir.
 * @returns the id, or undefined when telemetry is disabled or storage is unusable.
 */
export function resolveInstallId(config: WaConfig, dir: string = defaultDir()): string | undefined {
  if (!config.metricsEnabled) return undefined;
  if (resolved) return cached;
  resolved = true;

  const path = join(dir, FILE_NAME);

  try {
    const existing = readFileSync(path, "utf8").trim();
    // Ignore anything that isn't a well-formed UUID: a truncated or
    // hand-edited file should be replaced, not propagated into the metrics.
    if (UUID_RE.test(existing)) {
      cached = existing;
      return cached;
    }
  } catch {
    /* missing or unreadable — fall through and try to create one */
  }

  try {
    const id = randomUUID();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${id}\n`, "utf8");
    cached = id;
  } catch {
    // Unwritable home, read-only FS, sandbox. Stay undefined rather than
    // returning a per-process id, which would silently re-create the exact
    // restart-inflation this is meant to remove.
    cached = undefined;
  }

  return cached;
}
