import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";
import { version } from "../src/tools/version.js";
import { restart } from "../src/tools/restart.js";

describe("agent_flow_version", () => {
  test("reads build meta from a given path", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-meta-"));
    const metaPath = join(dir, "build-meta.json");
    const expected = { version: "0.1.0", gitSha: "abc1234", buildTime: new Date().toISOString() };
    writeFileSync(metaPath, JSON.stringify(expected));
    expect(version(metaPath)).toEqual(expected);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns unknown when meta missing", () => {
    const res = version(join(tmpdir(), "does-not-exist-xyz", "build-meta.json"));
    expect(res).toEqual({ unknown: true, note: expect.any(String) });
  });

  test("real project build-meta is present after `npm run build`", () => {
    // Smoke check: if a build has run, dist/build-meta.json exists and parses.
    const realPath = join(process.cwd(), "dist", "build-meta.json");
    if (!existsSync(realPath)) return; // no build in this env; covered by the build step
    const v = version();
    expect(v).toMatchObject({
      version: expect.any(String),
      gitSha: expect.any(String),
      buildTime: expect.any(String),
    });
  });
});

describe("agent_flow_restart", () => {
  test("returns restarting shape and triggers shutdown (injected, no real exit)", () => {
    const spy = vi.fn();
    const res = restart(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ restarting: true, note: expect.any(String) });
  });
});
