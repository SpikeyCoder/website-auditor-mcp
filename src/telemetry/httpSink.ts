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
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: WaConfig, deps: HttpSinkDeps = {}) {
    this.url = `${cfg.apiBaseUrl}${INGEST_PATH}`;
    this.apiKey = cfg.apiKey;
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
        body: JSON.stringify(event),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
