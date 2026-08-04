/**
 * A gateway 5xx that arrives at the timeout boundary is a TIMEOUT, not an
 * "upstream error".
 *
 * WHY THIS EXISTS. mcp_events for 2026-07-23 and 2026-07-25 carry three
 * tool_call failures at 60945 ms, 61121 ms and 60629 ms — all classified
 * UPSTREAM_ERROR, all suspiciously exactly 60 seconds.
 *
 * They cannot be client aborts: requestTimeoutMs defaults to 120000 (config.ts)
 * and an abort maps to TIMEOUT at client.ts. So the API answered with a 5xx at
 * ~60s — an infrastructure timeout between us and the audit engine. 504 was
 * already mapped to TIMEOUT; 502 and 503 fell through `default:` and became
 * UPSTREAM_ERROR, whose user-facing message is "Could not reach the Website
 * Auditor API."
 *
 * That message is wrong and unactionable. The API was reached; it took too
 * long. A user told "could not reach" retries immediately (and on 2026-08-01 a
 * user did exactly that, four times in 80 seconds, burning quota each time);
 * a user told "timed out" knows to try a smaller site or wait.
 *
 * THE RULE. 502/503 are ambiguous on their own — fast, they mean the service
 * is genuinely down, which IS an upstream error. Only their arrival TIME
 * distinguishes the two, so the classifier needs elapsed time, not just the
 * status code. 504 stays an unconditional TIMEOUT: it says so.
 */
import { describe, it, expect, vi } from "vitest";
import { WaApiClient } from "../../src/api/client.js";

/** A fetch that resolves after `delayMs` of fake time with the given status. */
function slowFetch(status: number, delayMs: number, body: unknown = { success: false, error: "upstream" }) {
  return vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
          delayMs,
        );
      }),
  );
}

const baseCfg = {
  apiBaseUrl: "https://api.website-auditor.io",
  siteUrl: "https://website-auditor.io",
  apiKey: "wa_valid_key",
  upgradeUrl: "https://api.website-auditor.io/admin_portal/",
  freeDailyAuditLimit: 3,
  freeMaxDomains: 1,
  requestTimeoutMs: 120000,
};

/** Drive a delayed fetch to completion under fake timers. */
async function runWithFakeClock<T>(work: () => Promise<T>, advanceMs: number): Promise<T> {
  vi.useFakeTimers();
  try {
    // Attach the handler BEFORE advancing the clock: the promise settles during
    // advanceTimersByTimeAsync, and an unobserved rejection in that window is
    // reported as an unhandled rejection and can fail the run.
    const promise = work();
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    vi.useRealTimers();
  }
}

describe("gateway 5xx classification", () => {
  it("maps a 502 that arrives at the ~60s boundary to TIMEOUT", async () => {
    // The exact shape of the three real failures.
    const fetchMock = slowFetch(502, 60_945);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(
      runWithFakeClock(() => client.runAudit({ domain: "example.com" }), 61_000),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("maps a slow 503 to TIMEOUT as well", async () => {
    const fetchMock = slowFetch(503, 60_629);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(
      runWithFakeClock(() => client.runAudit({ domain: "example.com" }), 61_000),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("leaves a FAST 502 as UPSTREAM_ERROR — that service really is down", async () => {
    // The distinguishing signal is time, not status. A 502 in 300ms is a dead
    // backend, and calling it a timeout would send the user to wait for
    // something that will never finish.
    const fetchMock = slowFetch(502, 300);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(
      runWithFakeClock(() => client.runAudit({ domain: "example.com" }), 1_000),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("leaves a fast 503 as UPSTREAM_ERROR", async () => {
    const fetchMock = slowFetch(503, 900);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(
      runWithFakeClock(() => client.runAudit({ domain: "example.com" }), 2_000),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("keeps 504 an unconditional TIMEOUT, however fast it arrives", async () => {
    // 504 is self-describing; it needs no timing heuristic. Pre-existing
    // behaviour, pinned here so the new elapsed-time logic cannot regress it.
    const fetchMock = slowFetch(504, 50);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(
      runWithFakeClock(() => client.runAudit({ domain: "example.com" }), 500),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("does not reclassify a slow 500 — that is a real upstream failure", async () => {
    // 500 is the API telling us the audit itself failed (see the
    // report_unavailable branch in website-auditor-api src/routes/audit.js).
    // It is slow by nature and must NOT be relabelled a timeout.
    const fetchMock = slowFetch(500, 61_000);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(
      runWithFakeClock(() => client.runAudit({ domain: "example.com" }), 62_000),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("says the request timed out, not that the API was unreachable", async () => {
    const fetchMock = slowFetch(502, 60_945);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const err = await runWithFakeClock(
      () => client.runAudit({ domain: "example.com" }).catch((e: unknown) => e),
      61_000,
    );
    expect(String((err as Error).message)).not.toMatch(/could not reach/i);
  });
});
