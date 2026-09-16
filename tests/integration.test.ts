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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 集成测试直接跑预编译的 dist/runner.js（生产同款路径），避开 tsx 冷启动给每个 runner 进程加的延迟——
// 否则本机 spawn 延迟会把测试内部 timing 阈值（waitForTerminal 8s / pidfile 4s / 并发 8s）拖爆而误报失败。
// dist 缺失时整组优雅 skip，避免 `npm test` 因未构建而红；`npm run test:integration` 会先 build。
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtRunner = join(repoRoot, "dist", "runner.js");
const builtRunnerExists = existsSync(builtRunner);
if (!builtRunnerExists) {
  console.warn(`[integration] SKIP: ${builtRunner} not found. Run \`npm run build\` first.`);
}
const suite = builtRunnerExists ? describe : describe.skip;

import { submit } from "../src/tools/submit.js";
import { status } from "../src/tools/status.js";
import { cancel } from "../src/tools/cancel.js";
import { openStore } from "../src/store.js";
import { killTree } from "../src/proc-tree.js";

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
} else if (mode === "escape") {
  // P0-2 逃逸场景：agent 派生 detached 心跳子进程（脱离 runner 进程组，模拟 agent Bash 工具的
  // 逃逸长命令），自身 hang 等待 cancel。修复前 cancel 杀不掉该子进程，心跳文件持续增长。
  emit({ type: "system", subtype: "init", session_id: "sid-esc-" + process.pid });
  const { spawn } = require("node:child_process");
  const hbChild = spawn(process.execPath, ["-e", \`
    const fs = require("node:fs");
    let i = 0;
    const t = setInterval(() => { fs.appendFileSync(process.env.HB_PATH, i++ + "\\\\n"); }, 50);
    process.on("SIGTERM", () => process.exit(0));
  \`], { detached: true, env: { ...process.env, HB_PATH: process.env.FAKE_HB }, stdio: "ignore" });
  hbChild.unref();
  try { require("node:fs").writeFileSync(process.env.FAKE_HB_PIDFILE, String(hbChild.pid)); } catch {}
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "needs_input") {
  emit({ type: "system", subtype: "init", session_id: "sid-ni-" + process.pid });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "❓NEEDS_INPUT: which database engine?" }] } });
  emit({ type: "result", subtype: "success", result: "❓NEEDS_INPUT: which database engine?", is_error: false });
} else if (mode === "transient") {
  // 瞬态重试验收：用计数器文件记录这是第几次运行（runner 每次重试都是全新进程）。
  // 前 FAKE_FAIL_TIMES 次吐 429 终态报错，之后成功——验证 runner 兜底重试能救回任务。
  emit({ type: "system", subtype: "init", session_id: "sid-tr-" + process.pid });
  const fs = require("node:fs");
  const cntFile = process.env.FAKE_ATTEMPT_FILE || "/tmp/afex-attempt.txt";
  let n = 0;
  try { n = Number(fs.readFileSync(cntFile, "utf8")) || 0; } catch {}
  n++;
  try { fs.writeFileSync(cntFile, String(n)); } catch {}
  const failTimes = Number(process.env.FAKE_FAIL_TIMES ?? "2");
  if (n <= failTimes) {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "API Error: Request rejected (429) · 当前已达到 Token Plan 用量上限" }] } });
    emit({ type: "result", subtype: "error", result: "API Error: Request rejected (429) · 当前已达到 Token Plan 用量上限", is_error: true });
  } else {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
    emit({ type: "result", subtype: "success", result: "all done", is_error: false });
  }
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
  process.env.AGENT_FLOW_RUNNER = builtRunner;
  mkdirSync(join(home, "logs"), { recursive: true });
  setupHome();
});

afterEach(() => {
  // 兜底清理：escape 测试若失败可能残留 detached 心跳子进程，按 pidfile 追杀
  const hbPidfile = join(home, "hb-child.pid");
  try {
    if (existsSync(hbPidfile)) {
      const pid = Number(readFileSync(hbPidfile, "utf8"));
      if (pid > 0) killTree(pid);
    }
  } catch { /* 清理失败不阻断 */ }
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_FLOW_HOME;
  delete process.env.AGENT_FLOW_RUNNER;
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

function hbLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

async function waitForHbLines(path: string, min: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hbLines(path) >= min) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting heartbeat lines >= ${min}: ${path}`);
}

suite("integration: full task lifecycle", () => {
  it("submit → runner → fake-agent (ok) → completed", async () => {
    const r = await submit({ prompt: "hello", project_path: home });
    expect(r).toMatchObject({ status: "queued", rounds: 1 });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id)).toBe("completed");
    const final = status({ task_id: id }) as { status: string; result?: string };
    expect(final.result).toContain("all done");
  }, 10_000);
});

suite("integration: cancel cascades to agent process", () => {
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

suite("integration: cancel kills escaped descendant process", () => {
  it("detached heartbeat spawned by agent stops after cancel (P0-2 regression)", async () => {
    const pidfile = join(home, "agent.pid");
    const hbChildPidfile = join(home, "hb-child.pid");
    const hb = join(home, "hb.txt");
    setupHome({
      FAKE_MODE: "escape", FAKE_PIDFILE: pidfile,
      FAKE_HB: hb, FAKE_HB_PIDFILE: hbChildPidfile,
    });
    const r = await submit({ prompt: "escape", project_path: home });
    const id = (r as { task_id: string }).task_id;
    await waitForPidfile(pidfile);
    const hbChildPid = await waitForPidfile(hbChildPidfile);
    // 心跳进程活着且正在写文件
    await waitForHbLines(hb, 1);
    expect(() => process.kill(hbChildPid, 0)).not.toThrow();

    // cancel → killTree：进程组 + 逃逸后代树都应被清
    expect(cancel({ task_id: id })).toMatchObject({ status: "cancelled" });
    await new Promise((res) => setTimeout(res, 500));

    // 修复核心断言：逃逸的 detached 心跳子进程必须死（旧实现会继续跑）
    let childAlive: "alive" | "dead" = "dead";
    try { process.kill(hbChildPid, 0); childAlive = "alive"; } catch { /* dead */ }
    expect(childAlive).toBe("dead");
    // 心跳文件停止增长
    const linesAtStop = hbLines(hb);
    await new Promise((res) => setTimeout(res, 700));
    expect(hbLines(hb)).toBe(linesAtStop);
    expect((openStore(join(home, "tasks.db")).getTask(id) as { status: string }).status).toBe("cancelled");
  }, 15_000);
});

suite("integration: timeout kills long-running agent", () => {
  it("hang mode > timeout_sec → failed(timeout) (P1 timeout regression)", async () => {
    setupHome({ FAKE_MODE: "hang" }, 2); // timeout_sec=2
    const r = await submit({ prompt: "hang slow", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 10_000)).toBe("failed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { error?: string };
    expect(t.error).toMatch(/timeout/i);
  }, 12_000);
});

suite("integration: needs_input → continue → completed", () => {
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

suite("integration: concurrent submits", () => {
  // 并发安全：N 个任务同时提交到同一 home（共享 tasks.db），全部应各自进入终态、互不串扰。
  // SQLite WAL 模式保证 transition 原子性；本测试主要验证：
  //   1) 没有 task_id 重复 / 数据库错误
  //   2) 每个任务都到 completed（状态机不冲突）
  //   3) 日志文件按 task_id 隔离（不互踩）
  it("N parallel submits → all completed; no DB conflicts (concurrent regression)", async () => {
    const N = 4;
    const t0 = Date.now();
    const rs = await Promise.all(
      Array.from({ length: N }, (_, i) => submit({ prompt: `parallel-${i}`, project_path: home })),
    );
    const ids = rs.map((r) => (r as { task_id: string }).task_id);
    // task_id 互不重复
    expect(new Set(ids).size).toBe(N);
    // 全部进入终态（completed）。并发的 runner 各自 spawn fake-agent，互不冲突。
    await Promise.all(ids.map((id) => waitForTerminal(id, 15_000).then((s) => {
      expect({ id, s }).toEqual({ id, s: "completed" });
    })));
    // 每个 task 的 result 都填了，且 logs/ 下都有对应 jsonl
    const db = join(home, "tasks.db");
    for (const id of ids) {
      const t = openStore(db).getTask(id) as { status: string; result?: string };
      expect(t.status).toBe("completed");
      expect(t.result).toContain("all done");
      expect(existsSync(join(home, "logs", `${id}.jsonl`))).toBe(true);
    }
    // 端到端执行时间 sanity check：4 个任务并发跑（fake-agent 每轮 <200ms），整轮 < 8s
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 20_000);
});

suite("integration: transient API error retry (P0)", () => {
  it("retries on 429 and completes after transient failures", async () => {
    process.env.AGENT_FLOW_RETRY_BACKOFF_MS = "50,50";
    const attemptFile = join(home, "attempt.txt");
    setupHome({ FAKE_MODE: "transient", FAKE_ATTEMPT_FILE: attemptFile, FAKE_FAIL_TIMES: "2" });
    const r = await submit({ prompt: "do work", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 12_000)).toBe("completed");
    const final = status({ task_id: id }) as { status: string; result?: string };
    expect(final.result).toContain("all done");
    // 前两次 429 各产生一条 _retry 标记；第 3 次成功不再重试
    const log = readFileSync(join(home, "logs", `${id}.jsonl`), "utf8");
    expect(log.split("\n").filter((l) => l.includes('"_retry"')).length).toBe(2);
    // 计数器到 3：runner 共运行 3 次（2 次重试 + 1 次成功）
    expect(Number(readFileSync(attemptFile, "utf8"))).toBe(3);
    delete process.env.AGENT_FLOW_RETRY_BACKOFF_MS;
  }, 15_000);

  it("gives up after MAX_ATTEMPTS when 429 never recovers", async () => {
    process.env.AGENT_FLOW_RETRY_BACKOFF_MS = "50,50";
    const attemptFile = join(home, "attempt.txt");
    setupHome({ FAKE_MODE: "transient", FAKE_ATTEMPT_FILE: attemptFile, FAKE_FAIL_TIMES: "99" });
    const r = await submit({ prompt: "do work", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 12_000)).toBe("failed");
    const log = readFileSync(join(home, "logs", `${id}.jsonl`), "utf8");
    // MAX_ATTEMPTS=3 → 仅 2 次重试（第 3 次失败即终态 failed）
    expect(log.split("\n").filter((l) => l.includes('"_retry"')).length).toBe(2);
    expect(Number(readFileSync(attemptFile, "utf8"))).toBe(3);
    delete process.env.AGENT_FLOW_RETRY_BACKOFF_MS;
  }, 15_000);
});
