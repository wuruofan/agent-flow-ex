#!/usr/bin/env node
/**
 * Isolated verification for wait-task.mjs. Run it after any edit to the script:
 *
 *   node --disable-warning=ExperimentalWarning \
 *     skills/agent-flow-dispatch/scripts/wait-task.test.mjs
 *
 * It never touches ~/.agent-flow-ex: every case builds a throwaway AGENT_FLOW_HOME with a
 * synthetic tasks.db and log file, so it cannot disturb the MCP server, a live runner, or
 * the Feishu notifier.
 *
 * The assertions are meant to *discriminate*, not to pass. Each one encodes a mistake that
 * was actually made while building this script:
 *
 *   1. needs_input treated as "keep waiting". The pre-fix script sat out a 30s clock and
 *      exited 2 while the question was already on disk — under the 2h default that is a
 *      2-hour blind spot over the one event that required action.
 *   2. "longest text block wins" report extraction. Compaction summaries ride on
 *      role:"user" and are many times longer than the report, so that rule silently hands
 *      the caller a summary instead of the deliverable. The mocks make the summary longer
 *      on purpose, so the naive rule goes red.
 *   3. A digest that costs more than the thing it replaces. Below the inline threshold this
 *      script's own ~450-char fixed overhead made HEAD+path larger than the raw report. The
 *      long mock is sized to the real range (past 1200) so a mis-set threshold stays caught.
 *   4. A claude-only log shape. opencode writes a flat {"type":"text","text":…}, so a rule
 *      keyed on type=="assistant" + message.content[] returns "" for every opencode task and
 *      still exits 0 — "no report" indistinguishable from "empty report". Group 7 feeds the
 *      same report text in both shapes; before the fix the opencode case was 0 chars.
 *
 * Exit code is the script's contract, so it is asserted directly:
 *   0 terminal / 5 needs_input / 2 timeout / 3 not_found / 4 usage.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "wait-task.mjs");
let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

const HOME = mkdtempSync(join(tmpdir(), "af-wait-test-"));
const db = new DatabaseSync(join(HOME, "tasks.db"));
db.exec(`CREATE TABLE tasks (
  id TEXT PRIMARY KEY, status TEXT, prompt TEXT, project_path TEXT, executor TEXT, profile TEXT,
  timeout_sec INTEGER, session_id TEXT, rounds INTEGER, result TEXT, question TEXT, progress TEXT,
  files_changed TEXT, pid INTEGER, error TEXT, log_path TEXT, role TEXT, created_at INTEGER,
  started_at INTEGER, ended_at INTEGER, notify_failed INTEGER)`);

const asst = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const compact = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const mkLog = (name, lines) => { const p = join(HOME, name); writeFileSync(p, lines.join("\n") + "\n"); return p; };
// A missing report file is itself a failure mode worth reporting as a FAIL rather than as a
// stack trace: if the script regresses into not writing it, the assertions should say that.
const readMaybe = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const now = Math.floor(Date.now() / 1000);

function insert(t) {
  db.prepare("INSERT INTO tasks (id,status,prompt,project_path,executor,profile,timeout_sec,session_id,rounds," +
    "result,question,progress,files_changed,pid,error,log_path,role,created_at,started_at,ended_at,notify_failed)" +
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(t.id, t.status, "p", "/tmp/proj", "claude", null, t.timeout_sec ?? 3600, null, 1, t.result ?? null, t.question ?? null,
      null, JSON.stringify(t.files ?? []), null, t.error ?? null, t.log_path, "worker", 1000, 1000, t.ended_at ?? null, 0);
}

function run(args) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, ...args],
      { env: { ...process.env, AGENT_FLOW_HOME: HOME } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err, sec: (Date.now() - t0) / 1000 }));
  });
}

// ------------------------------------------------------------------ 1. wake on needs_input

const PARTIAL = "## 进展\n已完成 3 处修复，第 4 处需要决策。";
const wakeLog = mkLog("wake.jsonl", [asst("small earlier note"), asst(PARTIAL),
  compact("This session is being continued from a previous conversation. ".repeat(60))]);
insert({ id: "task_mock_wake_0001", status: "running", log_path: wakeLog, files: ["a.ts", "b.ts"] });

console.log("=== 1. running -> needs_input must WAKE, not wait out the clock ===");
{
  const pending = run(["task_mock_wake_0001", "--interval-sec", "1", "--max-wait-sec", "30",
    "--report-out", join(HOME, "wake.report.md")]);
  await new Promise((r) => setTimeout(r, 2500));
  db.prepare("UPDATE tasks SET status='needs_input', question=?, result=?, ended_at=? WHERE id=?")
    .run("第 4 处要动 config.defaults.timeout_sec 默认值，改哪个？A=1800 B=3600 C=7200", PARTIAL,
      Math.floor(Date.now() / 1000), "task_mock_wake_0001");
  const r = await pending;
  check("exit 5", r.code === 5, `got ${r.code}`);
  check("WAIT=needs_input", /^WAIT=needs_input$/m.test(r.out), r.out);
  check("woke promptly (<10s, not the 30s clock)", r.sec < 10, `${r.sec.toFixed(1)}s`);
  check("STATUS=needs_input", /^STATUS=needs_input$/m.test(r.out));
  check("QUESTION carried in stdout", /^QUESTION=.*timeout_sec.*$/m.test(r.out), r.out);
  check("no digest while a question is pending", !/REPORT_(HEAD|TEXT|OUTLINE)=/m.test(r.out), r.out);
  check("partial report still written for optional reading", /^REPORT_PATH=/m.test(r.out));
  const wrote = readMaybe(join(HOME, "wake.report.md"));
  check("partial report is not the compaction summary",
    !!wrote && wrote.includes("已完成 3 处修复") && !wrote.includes("continued from a previous"),
    wrote === null ? "report file was never written" : `len=${wrote.length}`);
}

console.log("=== 2. already needs_input at start / under --once ===");
{
  const early = mkLog("early.jsonl", [asst("## 进展\n等你答复 timeout_sec 取值。")]);
  insert({ id: "task_mock_early_0001", status: "needs_input", question: "timeout_sec 取哪个值？A/B/C",
    result: "## 进展\n等你答复 timeout_sec 取值。", log_path: early, ended_at: now });
  const a = await run(["task_mock_early_0001", "--interval-sec", "1", "--max-wait-sec", "30"]);
  check("exit 5, fast", a.code === 5 && a.sec < 5, `code=${a.code} ${a.sec.toFixed(1)}s`);
  check("QUESTION present", /^QUESTION=timeout_sec 取哪个值/m.test(a.out), a.out);
  const b = await run(["task_mock_early_0001", "--once"]);
  check("--once reports needs_input, not timeout (was exit 2 before the fix)", b.code === 5, `got ${b.code}`);
  check("--once WAIT=needs_input", /^WAIT=needs_input$/m.test(b.out), b.out);
}

console.log("=== 3. terminal path, digest shapes ===");
{
  const LONG = "## 摘要\n" + "x".repeat(1400) + "\n## 验收\n0 fail\n## 遗留\n1 项";
  const SHORT = "## 报告\n改完 2 个文件，0 fail。";
  insert({ id: "task_mock_long_0001", status: "completed", result: LONG,
    log_path: mkLog("long.jsonl", [asst("short"), asst(LONG), compact("Z".repeat(3000))]),
    files: ["a.ts", "b.ts", "c.ts"], ended_at: now });
  insert({ id: "task_mock_short_0001", status: "completed", result: SHORT,
    log_path: mkLog("short.jsonl", [asst(SHORT)]), ended_at: now });

  const rl = await run(["task_mock_long_0001", "--report-out", join(HOME, "long.report.md")]);
  check("long: exit 0 / WAIT=terminal", rl.code === 0 && /^WAIT=terminal$/m.test(rl.out), `code=${rl.code}`);
  check("long: OUTLINE + HEAD, not inlined", /^REPORT_OUTLINE=/m.test(rl.out) && /^REPORT_HEAD=/m.test(rl.out) && !/^REPORT_TEXT=/m.test(rl.out));
  const wroteL = readMaybe(join(HOME, "long.report.md")) ?? "";
  check("long: extracted the report, not the 3000-char summary", wroteL.length === LONG.length && !wroteL.includes("ZZZ"), `len=${wroteL.length} want=${LONG.length}`);
  const stdoutBytes = Buffer.byteLength(rl.out, "utf8");
  check("long: stdout smaller than the report it replaces", stdoutBytes < Buffer.byteLength(wroteL, "utf8"), `${stdoutBytes} vs ${Buffer.byteLength(wroteL, "utf8")}`);

  const rs = await run(["task_mock_short_0001", "--report-out", join(HOME, "short.report.md")]);
  check("short: inlined via REPORT_TEXT (no file read needed)", /^REPORT_TEXT=.*0 fail/m.test(rs.out), rs.out);
  check("short: no HEAD when inlined", !/^REPORT_HEAD=/m.test(rs.out));
}

console.log("=== 4. still running -> timeout; missing task -> not_found; bad flag -> usage ===");
{
  insert({ id: "task_mock_slow_0001", status: "running", log_path: mkLog("slow.jsonl", [asst("working")]) });
  const slow = await run(["task_mock_slow_0001", "--interval-sec", "1", "--max-wait-sec", "3"]);
  check("timeout: exit 2 / WAIT=timeout / no QUESTION", slow.code === 2 && /^WAIT=timeout$/m.test(slow.out) && !/^QUESTION=/m.test(slow.out), `code=${slow.code}`);
  const miss = await run(["task_mock_nope_0001", "--once"]);
  check("missing: exit 3 / WAIT=not_found", miss.code === 3 && /^WAIT=not_found$/m.test(miss.out), `code=${miss.code}`);
  const bad = await run(["--bogus"]);
  check("bad flag: exit 4", bad.code === 4, `code=${bad.code}`);
}

console.log("=== 5. needs_input round-trip: answer -> running -> completed, same id ===");
{
  const LOG = join(HOME, "rt.jsonl");
  writeFileSync(LOG, [asst("## 第1轮\n先做了 A，等答复。")].join("\n") + "\n");
  insert({ id: "task_mock_rt_0001", status: "running", log_path: LOG });
  const args = ["task_mock_rt_0001", "--interval-sec", "1", "--max-wait-sec", "25", "--report-out", join(HOME, "rt.report.md")];

  const p1 = run(args);
  await new Promise((r) => setTimeout(r, 2200));
  db.prepare("UPDATE tasks SET status='needs_input', question='A 还是 B？', ended_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), "task_mock_rt_0001");
  const r1 = await p1;
  check("round 1: exit 5 with the question", r1.code === 5 && /^QUESTION=A 还是 B？$/m.test(r1.out), r1.out);

  db.prepare("UPDATE tasks SET status='running', rounds=2, question=NULL, ended_at=NULL WHERE id=?").run("task_mock_rt_0001");
  writeFileSync(LOG, [asst("## 第1轮\n先做了 A，等答复。"), asst("## 第2轮终报\n按 A 完成。剩余 0 项。")].join("\n") + "\n");
  const p2 = run(args);
  await new Promise((r) => setTimeout(r, 2200));
  db.prepare("UPDATE tasks SET status='completed', result='## 第2轮终报\n按 A 完成。剩余 0 项。', ended_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), "task_mock_rt_0001");
  const r2 = await p2;
  check("round 2: exit 0 / terminal (script is cleanly re-runnable on the same id)", r2.code === 0 && /^WAIT=terminal$/m.test(r2.out), `code=${r2.code}`);
  check("round 2: report file overwritten with the newer round", (readMaybe(join(HOME, "rt.report.md")) ?? "").includes("按 A 完成"));
}

console.log("=== 6. wait budget: derived from timeout_sec / explicit / never ===");
{
  insert({ id: "task_mock_budget_0001", status: "running", timeout_sec: 120,
    log_path: mkLog("budget.jsonl", [asst("working")]) });

  // 3*120 + 90 backoff + 120 slack. Asserted through the printed budget rather than by
  // waiting 570s, so the derivation is checked instantly.
  const d = await run(["task_mock_budget_0001", "--once"]);
  check("derived: 3*timeout_sec + 90 + 120", /^MAX_WAIT_SEC=570$/m.test(d.out), d.out);
  const e = await run(["task_mock_budget_0001", "--once", "--max-wait-sec", "30"]);
  check("explicit --max-wait-sec wins over the derivation", /^MAX_WAIT_SEC=30$/m.test(e.out), e.out);
  const n = await run(["task_mock_budget_0001", "--once", "--max-wait-sec", "0"]);
  check("0 means never", /^MAX_WAIT_SEC=never$/m.test(n.out), n.out);

  // 0 = never: with a task that never finishes, the process must still be alive well past
  // the point where a finite budget would have fired (interval is 1s).
  const child = spawn(process.execPath,
    ["--disable-warning=ExperimentalWarning", SCRIPT, "task_mock_budget_0001", "--interval-sec", "1", "--max-wait-sec", "0"],
    { env: { ...process.env, AGENT_FLOW_HOME: HOME } });
  let out = "";
  child.stdout.on("data", (x) => (out += x));
  await new Promise((r) => setTimeout(r, 6000));
  const alive = child.exitCode === null;
  child.kill("SIGKILL");
  check("never: still waiting (alive at 6s with interval=1s)", alive, `exitCode=${child.exitCode}`);
  check("never: printed nothing while still waiting", out === "", JSON.stringify(out.slice(0, 80)));
}

console.log("=== 7. executor log shapes: claude and opencode must both yield the report ===");
{
  const REPORT = "## 摘要\n完成 A/B 两个改动\n## 验收\n0 fail\n## 遗留\n1 项";

  // opencode, flat: {"type":"text","text":…}  (executors/opencode.ts:45-47)
  insert({ id: "task_mock_oc_0001", status: "completed", ended_at: now,
    log_path: mkLog("oc.jsonl", [
      JSON.stringify({ type: "step_start", sessionID: "ses_1" }),
      JSON.stringify({ type: "text", sessionID: "ses_1", text: REPORT }),
      JSON.stringify({ type: "step-finish", text: "done" }),
    ]) });

  // opencode, nested: the same executor falls back to part.text when o.text is absent.
  insert({ id: "task_mock_oc2_0001", status: "completed", ended_at: now,
    log_path: mkLog("oc2.jsonl", [
      JSON.stringify({ type: "text", part: { type: "text", text: REPORT } }),
    ]) });

  const oc = await run(["task_mock_oc_0001", "--report-out", join(HOME, "oc.report.md")]);
  check("opencode flat: not a silent empty report",
    !/^REPORT_CHARS=0$/m.test(oc.out), (oc.out.match(/^REPORT_CHARS=.*$/m) ?? ["<no line>"])[0]);
  check("opencode flat: file holds the report verbatim",
    (readMaybe(join(HOME, "oc.report.md")) ?? "") === REPORT,
    `len=${(readMaybe(join(HOME, "oc.report.md")) ?? "").length} want=${REPORT.length}`);

  await run(["task_mock_oc2_0001", "--report-out", join(HOME, "oc2.report.md")]);
  check("opencode nested part.text: also extracted",
    (readMaybe(join(HOME, "oc2.report.md")) ?? "") === REPORT);

  // Regression guard on the claude path, with the decoy that the role filter exists for.
  insert({ id: "task_mock_cl_0001", status: "completed", ended_at: now,
    log_path: mkLog("cl.jsonl", [asst("short earlier"), asst(REPORT),
      compact("This session is being continued from a previous conversation. ".repeat(80))]) });
  await run(["task_mock_cl_0001", "--report-out", join(HOME, "cl.report.md")]);
  const clWrote = readMaybe(join(HOME, "cl.report.md")) ?? "";
  check("claude shape unchanged by the opencode branch",
    clWrote === REPORT && !clWrote.includes("continued from a previous"), `len=${clWrote.length}`);
}

db.close();
rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("failed:\n  " + failures.join("\n  ")); process.exit(1); }
