// 集成测试：端到端真实链路（submit → runner → agent → 终态）。
// 不走 mock，spawn 真实进程。覆盖 happy path + cancel 级联 + 超时 + 续跑。
//
// 实施要点：
// - 自定义 inline fake-agent 写到 /tmp/afex-int-*（macOS 上 /var/folders spawn .cjs 报 ENOEXEC）。
// - 模板字面量首字符直接是 #!：\n 会让 file/lspawn 看不到 shebang。
// - profile.env.PATH 必须注入：buildAgentEnv 显式构造 PATH 不继承 process.env，
//   而 `#!/usr/bin/env node` 需要 env 找到 node。
// - bin=可执行文件本身，args=[]。fake executor 当前 buildCommand 把 bin 重复进 args 头部，
//   用 Node + script 时会让 argv 边界出问题（独立可执行无此问题）。
// - FAKE_MODE & FAKE_PIDFILE 通过 profile.env 传到 agent 子进程。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { submit } from "../src/tools/submit.js";
import { status } from "../src/tools/status.js";
import { cancel } from "../src/tools/cancel.js";
import { openStore } from "../src/store.js";

let home: string;
let fakeAgent: string;

// inline fake-agent：模式由 FAKE_MODE 决定；可选 FAKE_PIDFILE 写入自身 pid 让 cancel 测试验证。
const AGENT_BODY = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_MODE ?? "ok";
if (process.env.FAKE_PIDFILE) {
  try { require("node:fs").writeFileSync(process.env.FAKE_PIDFILE, String(process.pid)); } catch {}
}
if (mode === "hang") {
  emit({ type: "system", subtype: "init", session_id: "sid-hang-" + process.pid });
  // 响应 SIGTERM/SIGKILL 才能让 runner 的 timeout 信号真正杀进程
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "needs_input") {
  emit({ type: "system", subtype: "init", session_id: "sid-ni-" + process.pid });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "❓NEEDS_INPUT: which database engine?" }] } });
  emit({ type: "result", subtype: "success", result: "❓NEEDS_INPUT: which database engine?", is_error: false });
} else {
  emit({ type: "system", subtype: "init", session_id: "sid-ok-" + process.pid });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/fake.txt" } }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
  emit({ type: "result", subtype: "success", result: "all done", is_error: false });
}
`;

function setupHome(extraProfileEnv: Record<string, string> = {}, timeoutSec = 30): void {
  fakeAgent = join(home, "fake-agent.cjs");
  writeFileSync(fakeAgent, AGENT_BODY);
  chmodSync(fakeAgent, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: fakeAgent, extra_flags: [] } },
    profiles: { fake: { executor: "fake", env: { PATH: process.env.PATH ?? "", ...extraProfileEnv } } },
    notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
    defaults: { profile: "fake", timeout_sec: timeoutSec },
  }));
}

beforeEach(() => {
  home = mkdtempSync("/tmp/afex-int-");
  process.env.AGENT_FLOW_HOME = home;
  mkdirSync(join(home, "logs"), { recursive: true });
  setupHome();
});

afterEach(() => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_FLOW_HOME;
});

async function waitForTerminal(id: string, timeoutMs = 8_000): Promise<string> {
  const db = join(home, "tasks.db");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = openStore(db).getTask(id);
    if (t && (t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "needs_input")) {
      return t.status;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout (${timeoutMs}ms) waiting terminal state for ${id}`);
}

async function waitForPidfile(path: string, timeoutMs = 4_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(require("node:fs").readFileSync(path, "utf8"));
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting pidfile: ${path}`);
}

describe("integration: full task lifecycle", () => {
  it("submit → runner → fake-agent (ok) → completed", async () => {
    const r = await submit({ prompt: "hello", project_path: home });
    expect(r).toMatchObject({ status: "queued", rounds: 1 });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id)).toBe("completed");
    const final = status({ task_id: id }) as { status: string; result?: string };
    expect(final.result).toContain("all done");
  }, 10_000);
});

describe("integration: cancel cascades to agent process", () => {
  it("cancel kills the agent; no orphans (P0-2 regression)", async () => {
    const pidfile = join(home, "agent.pid");
    setupHome({ FAKE_MODE: "hang", FAKE_PIDFILE: pidfile });
    const r = await submit({ prompt: "hang", project_path: home });
    const id = (r as { task_id: string }).task_id;
    const agentPid = await waitForPidfile(pidfile);
    expect(agentPid).toBeGreaterThan(0);
    // 确认 agent 当前还活着
    expect(() => process.kill(agentPid, 0)).not.toThrow();
    // cancel
    expect(cancel({ task_id: id })).toMatchObject({ status: "cancelled" });
    // 给进程组信号传播时间
    await new Promise((r) => setTimeout(r, 800));
    // 核心断言：agent 进程已死，**没有孤儿**
    let agentAlive: "alive" | "dead" = "dead";
    try { process.kill(agentPid, 0); agentAlive = "alive"; } catch { /* dead */ }
    expect(agentAlive).toBe("dead");
    // 确认任务确实处于 cancelled 而非别的
    expect((openStore(join(home, "tasks.db")).getTask(id) as { status: string }).status).toBe("cancelled");
  }, 10_000);
});

describe("integration: timeout kills long-running agent", () => {
  it("hang mode > timeout_sec → failed(timeout) (P1 timeout regression)", async () => {
    setupHome({ FAKE_MODE: "hang" }, 2); // timeout_sec=2
    const r = await submit({ prompt: "hang slow", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 10_000)).toBe("failed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { error?: string };
    expect(t.error).toMatch(/timeout/i);
  }, 12_000);
});

describe("integration: needs_input → continue → completed", () => {
  it("first round needs_input; submit(continue_of) re-spawns runner; second round completed", async () => {
    // 第一轮
    setupHome({ FAKE_MODE: "needs_input" });
    const r1 = await submit({ prompt: "ask me", project_path: home });
    const id = (r1 as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 8_000)).toBe("needs_input");

    // 切到 ok 模式，让续跑直接成功
    setupHome({ FAKE_MODE: "ok" });
    const r2 = await submit({ prompt: "answer", continue_of: id, project_path: home });
    expect(r2).toMatchObject({ task_id: id, status: "running", rounds: 2 });
    expect(await waitForTerminal(id, 10_000)).toBe("completed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { status: string; rounds: number; result?: string };
    expect(t.status).toBe("completed");
    expect(t.rounds).toBe(2);
    expect(t.result).toContain("all done");
  }, 20_000);
});
