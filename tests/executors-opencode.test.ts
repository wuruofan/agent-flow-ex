import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExecutor } from "../src/executors/types.js";

const here = join(fileURLToPath(import.meta.url), "..");
const lines = readFileSync(join(here, "fixtures/opencode-events.jsonl"), "utf8").split("\n").filter(Boolean);

describe("opencode executor", () => {
  const ex = getExecutor("opencode");

  it("extracts sessionID from step_start (top-level)", () => {
    const ev = ex.parseEvent(lines[0]);
    expect(ev?.sessionId).toBe("ses_abc123");
  });
  it("extracts sessionID from step_start with part.sessionID (alt shape)", () => {
    const ev = ex.parseEvent(lines[7]);
    expect(ev?.sessionId).toBe("ses_alt");
  });
  it("extracts text from text event with part.text", () => {
    const ev = ex.parseEvent(lines[2]);
    expect(ev?.assistantText).toBe("Let me check the file.");
  });
  it("extracts text from plain text event without part", () => {
    const ev = ex.parseEvent(lines[8]);
    expect(ev?.assistantText).toBe("plain text event without part wrapping");
  });
  it("extracts tool_use name + filePath (camelCase input)", () => {
    const ev = ex.parseEvent(lines[3]);
    expect(ev?.toolUse).toEqual({ name: "read", file: "/tmp/x.txt" });
  });
  it("returns step-finish as result with subtype", () => {
    const ev = ex.parseEvent(lines[5]);
    expect(ev?.result?.subtype).toBe("step-finish");
    expect(ev?.result?.isError).toBe(false);
  });
  it("returns error event as result with isError=true", () => {
    const ev = ex.parseEvent(lines[6]);
    expect(ev?.result?.isError).toBe(true);
    expect(ev?.result?.subtype).toBe("error");
  });
  it("ignores non-json line", () => {
    expect(ex.parseEvent("not-json-line")).toBeNull();
  });
  it("builds first-run command: opencode run --format json + extra flags", () => {
    const cmd = ex.buildCommand("/usr/local/bin/opencode", ["--dangerously-skip-permissions"]);
    expect(cmd[0]).toBe("/usr/local/bin/opencode");
    expect(cmd[1]).toBe("run");
    expect(cmd).toContain("--format");
    expect(cmd).toContain("json");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });
  it("builds resume command with --session sid (not -c latest)", () => {
    const cmd = ex.buildCommand("/usr/local/bin/opencode", [], "ses_abc");
    expect(cmd).toContain("--session");
    expect(cmd).toContain("ses_abc");
  });
});