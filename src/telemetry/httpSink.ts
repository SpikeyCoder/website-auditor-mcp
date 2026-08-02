/**
 * HttpEventSink — posts telemetry events to the API portal's /api/mcp-events
 * ingest endpoint, authenticated with the configured `wa_` key so the API can
 * resolve api_key_id / user_id / acquisition_channel server-side.
 *
 * FIRE-AND-FORGET: emit() kicks off the POST and returns immediately. Every
 * failure mode — network error, non-2xx, timeout, serialization — is swallowed.
 * A metrics failure must NEVER surface to the tool path.
 */
import type { WaConfig } from "../config.js";
import type { EventSink, McpEvent } from "./events.js";
import { resolveInstallId } from "./installId.js";
import { SERVER_VERSION } from "../mcp/server.js";

const INGEST_PATH = "/api/mcp-events";
/** Telemetry writes get a tight timeout so a slow ingest never lingers. */
const DEFAULT_TIMEOUT_MS = 3000;

interface HttpSinkDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpEventSink implements EventSink {
  private readonly url: string;
  private readonly apiKey?: string;
  /**
   * Anonymous install id, resolved once at construction. Sent on every event so
   * keyless installs can be deduplicated from restarts — see installId.ts.
   * Undefined when telemetry is disabled or storage is unusable, in which case
   * the field is simply omitted.
   */
  private readonly installId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: WaConfig, deps: HttpSinkDeps = {}) {
    this.url = `${cfg.apiBaseUrl}${INGEST_PATH}`;
    this.apiKey = cfg.apiKey;
    this.installId = resolveInstallId(cfg);
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  emit(event: McpEvent): void {
    // Never await, never throw — schedule the send and immediately return.
    void this.send(event).catch(() => {
      /* swallow: telemetry must not affect the tool path */
    });
  }

  private async send(event: McpEvent): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        // server_version is ALWAYS sent, unlike install_id, which the sandbox
        // path can leave undefined. That independence is the point: when a field
        // fails to appear in the data, the build that should have sent it must
        // still be identifiable, or diagnosing it means unpacking tarballs.
        // client_name/client_version on the event describe the HOST, not us.
        body: JSON.stringify({
          ...event,
          ...(this.installId ? { install_id: this.installId } : {}),
          server_version: SERVER_VERSION,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
