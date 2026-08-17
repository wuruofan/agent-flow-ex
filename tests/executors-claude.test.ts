import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExecutor } from "../src/executors/types.js";

const here = join(fileURLToPath(import.meta.url), "..");
const lines = readFileSync(join(here, "fixtures/claude-events.jsonl"), "utf8").split("\n").filter(Boolean);

describe("claude executor", () => {
  const ex = getExecutor("claude");

  it("extracts sessionId from system/init", () => {
    const ev = ex.parseEvent(lines[1]);
    expect(ev?.sessionId).toBe("f34332fe-e7d5-4e48-ab6b-d8cfe2a2b889");
  });
  it("extracts assistant text, skips thinking blocks", () => {
    const ev = ex.parseEvent(lines[3]);
    expect(ev?.assistantText).toBe("pong");
  });
  it("extracts tool_use name + file_path", () => {
    const ev = ex.parseEvent(lines[4]);
    expect(ev?.toolUse).toEqual({ name: "Write", file: "/private/tmp/spike-proj/hello.txt" });
    const bash = ex.parseEvent(lines[6]);
    expect(bash?.toolUse).toEqual({ name: "Bash", file: null });
  });
  it("ignores tool_result user events and unknown system events and non-json", () => {
    expect(ex.parseEvent(lines[0])).toBeNull();
    expect(ex.parseEvent(lines[7])).toBeNull();
    expect(ex.parseEvent("not-json-line")).toBeNull();
  });
  it("extracts result event", () => {
    const ev = ex.parseEvent(lines[8]);
    expect(ev?.result).toEqual({ text: "DONE", isError: false, subtype: "success" });
    const err = ex.parseEvent(lines[9]);
    expect(err?.result?.isError).toBe(true);
  });
  it("builds first-run and resume commands; prompt always via stdin", () => {
    const first = ex.buildCommand("/bin/claude", ["--dangerously-skip-permissions"]);
    expect(first).toEqual(["/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
    const resume = ex.buildCommand("/bin/claude", [], "sid-9");
    expect(resume).toEqual(["/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--resume", "sid-9"]);
  });
});