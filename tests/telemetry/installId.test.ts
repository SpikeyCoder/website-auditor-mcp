import { describe, it, expect } from "vitest";
import { resolveInstallId, __resetInstallIdCacheForTests } from "../../src/telemetry/installId.js";
import { testConfig } from "../helpers.js";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The install id exists to answer one question the telemetry could not:
 * how many DISTINCT people install this, as opposed to how many times the
 * server restarted. Keyless events carry no identity, and the MCP re-initialises
 * on every client launch — 102 keyless sessions in July could have been 6 people
 * or 60.
 *
 * So the property that actually matters is stability across restarts. A fresh id
 * per process would look identical to the broken state it replaces while
 * appearing to work.
 */
function tempHome() {
  return mkdtempSync(join(tmpdir(), "wa-install-id-"));
}

describe("anonymous install id", () => {
  it("returns the SAME id across separate resolutions — restarts must not look like new installs", () => {
    const dir = tempHome();
    try {
      __resetInstallIdCacheForTests();
      const first = resolveInstallId(testConfig(), dir);
      __resetInstallIdCacheForTests(); // simulate a fresh process
      const second = resolveInstallId(testConfig(), dir);
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates different ids for different machines", () => {
    const a = tempHome();
    const b = tempHome();
    try {
      __resetInstallIdCacheForTests();
      const idA = resolveInstallId(testConfig(), a);
      __resetInstallIdCacheForTests();
      const idB = resolveInstallId(testConfig(), b);
      expect(idA).not.toBe(idB);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("writes nothing to disk when telemetry is disabled", () => {
    const dir = tempHome();
    try {
      __resetInstallIdCacheForTests();
      const id = resolveInstallId(testConfig({ metricsEnabled: false }), dir);
      expect(id).toBeUndefined();
      // Opting out must not leave a persistent identifier behind.
      expect(existsSync(join(dir, "install-id"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a random UUID, not derived from the machine — anonymous by construction", () => {
    const dir = tempHome();
    try {
      __resetInstallIdCacheForTests();
      const id = resolveInstallId(testConfig(), dir)!;
      const onDisk = readFileSync(join(dir, "install-id"), "utf8").trim();
      expect(onDisk).toBe(id);
      // v4 UUID: version nibble 4, variant nibble 8|9|a|b. Nothing hostname- or
      // user-derived would satisfy this.
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to undefined rather than throwing when the directory is unwritable", () => {
    // A read-only or sandboxed home must never break the server on startup.
    //
    // The unwritable path is a directory whose PARENT is a regular file, so
    // mkdir fails with ENOTDIR immediately, on every platform and whatever uid
    // the process has. This previously used /proc/..., which is not portable:
    // macOS has no /proc at all, so mkdir failed instantly with ENOENT and the
    // test passed in microseconds — while on Linux /proc is a real procfs and
    // the call hung, wedging CI on its first ever run. chmod would not work
    // either, since CI frequently runs as root and root ignores permission bits.
    const unwritable = join(tempHome(), "a-file-not-a-dir");
    writeFileSync(unwritable, "");
    __resetInstallIdCacheForTests();
    const id = resolveInstallId(testConfig(), join(unwritable, "child"));
    expect(id).toBeUndefined();
  });
});
