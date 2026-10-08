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
  // 2026-09-03：识别 429 / 硬配额信号，让 runner 触发即时告警推送
  it("detects 429 retry as quotaWarning (status + attempt + message)", () => {
    const ev = ex.parseEvent(lines[11]);
    expect(ev?.quotaWarning).toEqual({ status: 429, message: "Rate limit reached", attempt: 3 });
  });
  it("detects hard 'Token Plan 用量上限' message via Chinese keyword", () => {
    const ev = ex.parseEvent(lines[12]);
    expect(ev?.quotaWarning?.status).toBe(429);
    expect(ev?.quotaWarning?.message).toContain("Token Plan 用量上限");
  });
  it("detects quota from English message even without explicit status field", () => {
    const ev = ex.parseEvent(lines[13]);
    expect(ev?.quotaWarning?.message).toContain("quota exceeded");
  });
  it("ignores non-quota api_retry (500 / transient) — no false positive", () => {
    expect(ex.parseEvent(lines[14])?.quotaWarning).toBeUndefined();
    expect(ex.parseEvent(lines[15])?.quotaWarning).toBeUndefined();
  });
  it("builds first-run and resume commands; prompt always via stdin", () => {
    const first = ex.buildCommand("/bin/claude", ["--dangerously-skip-permissions"]);
    expect(first).toEqual(["/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
    const resume = ex.buildCommand("/bin/claude", [], "sid-9");
    expect(resume).toEqual(["/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--resume", "sid-9"]);
  });
// 2026-10-08 opencode e2e 回归：Node 的 spawn(bin, argv) 会**自己补**一个 argv[0]=bin，
// 再把传入数组原样接在后面 ⇒ child 实收 [bin, bin, run, …]，bin 被夹带成子命令的第一个位置参数。
// opencode 会把它当 prompt 吞掉 → 打 help、exit 1；claude 忽略位置参数所以长期潜伏。
// runner 的职责就是 slice(1)；这里锁死「buildCommand 的输出必须以 bin 开头」这一契约，
// 让 runner 的 slice(1) 永远安全。
it("buildCommand 输出以 bin 开头（runner 会 slice(1) 后再 spawn）", () => {
  const bin = "/bin/claude";
  expect(ex.buildCommand(bin, [])[0]).toBe(bin);
  expect(ex.buildCommand(bin, [], "sid-9")[0]).toBe(bin);
});
});