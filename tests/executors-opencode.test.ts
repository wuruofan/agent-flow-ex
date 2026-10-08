import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExecutor } from "../src/executors/types.js";

const here = join(fileURLToPath(import.meta.url), "..");
// fixture = opencode v1.18.33 `opencode run --format json --auto` 的真实 stdout 裁剪（2026-10-08）。
const lines = readFileSync(join(here, "fixtures/opencode-events.jsonl"), "utf8").split("\n").filter(Boolean);

describe("opencode executor", () => {
  const ex = getExecutor("opencode");

  it("extracts sessionID from step_start", () => {
    expect(ex.parseEvent(lines[0])?.sessionId).toBe("ses_sample0000001");
  });

  it("extracts text (整段快照) as assistantText", () => {
    const ev = ex.parseEvent(lines[3]);
    expect(ev?.assistantText).toBe("DONEPONG");
    expect(ev?.sessionId).toBe("ses_sample0000001");
  });

  it("extracts tool name from part.tool; file 为 null（bash 无 filePath）", () => {
    expect(ex.parseEvent(lines[1])?.toolUse).toEqual({ name: "bash", file: null });
  });

  it("extracts tool filePath from part.state.input（真实路径）", () => {
    expect(ex.parseEvent(lines[7])?.toolUse).toEqual({ name: "write", file: "/tmp/x.ts" });
  });

  it("step_finish 不产出 result（真实事件无 text；产出空 result 会把成功任务判成 failed）", () => {
    for (const i of [2, 4]) {
      const ev = ex.parseEvent(lines[i]);
      expect(ev?.result).toBeUndefined();
      expect(ev?.sessionId).toBe("ses_sample0000001");
    }
  });

  it("error 从 error.data.message 取文案，isError=true", () => {
    const ev = ex.parseEvent(lines[5]);
    expect(ev?.result?.isError).toBe(true);
    expect(ev?.result?.subtype).toBe("error");
    expect(ev?.result?.text).toBe("Unexpected server error. Check server logs for details.");
    expect(ev?.quotaWarning).toBeUndefined();
  });

  it("error 带 statusCode=429 时映射 quotaWarning", () => {
    const ev = ex.parseEvent(lines[6]);
    expect(ev?.result?.isError).toBe(true);
    expect(ev?.quotaWarning?.status).toBe(429);
    expect(ev?.quotaWarning?.message).toContain("用量上限");
  });

  it("ignores non-json line", () => {
    expect(ex.parseEvent("not-json-line")).toBeNull();
  });

  it("builds first-run command: opencode run --format json + extra flags，且不含 --prompt", () => {
    const cmd = ex.buildCommand("/usr/local/bin/opencode", ["--auto"]);
    expect(cmd[0]).toBe("/usr/local/bin/opencode");
    expect(cmd[1]).toBe("run");
    expect(cmd).toContain("--format");
    expect(cmd).toContain("json");
    expect(cmd).toContain("--auto");
    // prompt 走 stdin；`--prompt` 不是 run 的合法参数（传了会打 help 并 exit 1）。
    expect(cmd).not.toContain("--prompt");
  });

  it("builds resume command with --session sid (not -c latest)", () => {
    const cmd = ex.buildCommand("/usr/local/bin/opencode", [], "ses_abc");
    expect(cmd).toContain("--session");
    expect(cmd).toContain("ses_abc");
  });

  // 2026-10-08 e2e 回归：spawn 会补一个 argv[0]=bin 并把本数组接在后面，bin 于是被夹带成
  // `run` 的第一个位置参数（= message），opencode 直接打 help、exit 1。runner 靠 slice(1) 规避，
  // 这里锁死「[0] 是 bin、[1] 是 run」这个前提。
  it("argv 恰为 [bin, run, ...]：bin 只在 [0]，不会重复", () => {
    const bin = "/usr/local/bin/opencode";
    expect(ex.buildCommand(bin, ["--auto"])).toEqual([bin, "run", "--format", "json", "--auto"]);
    expect(ex.buildCommand(bin, ["--auto"], "ses_abc")).toEqual([bin, "run", "--session", "ses_abc", "--format", "json", "--auto"]);
  });
});
