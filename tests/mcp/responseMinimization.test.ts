/**
 * Response minimization — the OpenAI plugin review's data rule, pinned.
 *
 * "Tool responses don't include unnecessary personal data, auth secrets, debug
 * payloads, internal identifiers, or undisclosed user-related fields." This
 * suite runs EVERY served tool end-to-end (success paths under a pro mock,
 * error paths keyless) and scans the full serialized response for the classes
 * of leak that rule names:
 *
 *   - the caller's API key echoed back (auth secret)
 *   - `raw` upstream envelopes (debug payload — AuditResponse.raw exists on
 *     the client precisely so tools can choose NOT to forward it)
 *   - key_hash / install_id (internal identifiers)
 *   - stack traces (debug payload)
 *
 * A new tool that forwards any of these fails here, not in review.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { SERVED_TOOLS } from "../../src/tools/registry.js";
import { makeDeps } from "../helpers.js";

const SECRET_KEY = "wa_super_secret_key_value";

/** Minimal valid arguments per tool. A new tool must be added here to pass. */
const ARGS: Record<string, Record<string, unknown>> = {
  get_ai_visibility: { domain: "example.com" },
  run_audit: { domain: "example.com" },
  get_changes: { domain: "example.com" },
  compare_competitors: { domain: "example.com", competitors: ["rival.com"] },
  track_site: { domain: "example.com" },
  untrack_site: { domain: "example.com" },
  list_tracked_sites: {},
  get_monitoring_status: {},
  get_benchmark: { domain: "example.com" },
  get_recommendations: { domain: "example.com" },
  generate_schema: { domain: "example.com" },
  get_report: { domain: "example.com" },
  check_upgrade_status: {},
  get_sample_audit: {},
};

const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ["the caller's API key", new RegExp(SECRET_KEY)],
  ["a raw upstream envelope", /"raw"\s*:/],
  ["a key hash", /key_hash/i],
  ["the telemetry install id", /install_id/],
  ["a stack trace", /\bat\s+.+\(.+:\d+:\d+\)/],
];

async function connect(deps: ReturnType<typeof makeDeps>) {
  const server = createServer(deps);
  const client = new Client({ name: "minimization-scan", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("no tool response leaks secrets, debug payloads, or internal identifiers", () => {
  it("covers every served tool (add new tools to ARGS)", () => {
    expect(Object.keys(ARGS).sort()).toEqual(SERVED_TOOLS.map((t) => t.name).sort());
  });

  for (const [scenario, deps] of [
    ["pro (success paths)", () => makeDeps({ tier: "pro", config: { apiKey: SECRET_KEY } as never })],
    ["keyless (error paths)", () => makeDeps({ tier: "none", config: { apiKey: undefined } as never })],
  ] as const) {
    it(`scans all 14 tools under ${scenario}`, async () => {
      const client = await connect(deps());
      for (const [name, args] of Object.entries(ARGS)) {
        const res = await client.callTool({ name, arguments: args });
        const serialized = JSON.stringify(res);
        for (const [label, pattern] of FORBIDDEN) {
          expect(serialized, `${name} (${scenario}) must not expose ${label}`).not.toMatch(pattern);
        }
      }
      await client.close();
    });
  }
});
