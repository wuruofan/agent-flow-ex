#!/usr/bin/env node
/**
 * wait-task.mjs — block until an agent-flow task reaches a terminal state, then
 * extract the worker's final report from its run log.
 *
 * Why this exists
 * ---------------
 * Feishu notifies the *human* on terminal state, but reviewing a worker's output needs
 * the human and the dispatcher (main agent) in the same place. This script closes that
 * last mile: launched as a background process it polls the task DB and exits the moment
 * the task needs the dispatcher — without occupying the session and without spending
 * model tokens while it waits.
 *
 * "Needs the dispatcher" is two states, not one. Terminal (completed/failed/cancelled) is
 * the obvious one. `needs_input` is the other, and it is easy to miss: the task is *not*
 * terminal — answering with continue_of puts it back into `running` — but the worker has
 * stopped and asked a question, and nothing will move again until the dispatcher replies.
 * Treating it as "keep waiting" burns the whole max-wait window (2h by default) and then
 * reports a useless timeout, swallowing the single event that required action. Both states
 * wake the caller; they differ in exit code and in what happens next (review vs. answer).
 * Verified 2026-09-23 against the pre-fix behaviour, where a needs_input task sat out a
 * 30s clock and exited 2 while the question was already on disk.
 *
 * Verified 2026-09-23 (probe task vXyTDb): a background process survives past the 600s
 * single-call Bash timeout — `sleep 700` completed and wrote its marker file. So a
 * median 22-min task needs no segmentation.
 *
 * Usage
 * -----
 *   node wait-task.mjs <task_id> [options]
 *
 *   --interval-sec N    poll interval (default 20)
 *   --max-wait-sec N    give up after N seconds; 0 = never. Default: derived from the task's
 *                       own timeout_sec (see "How long can this wait?" below)
 *   --report-out PATH   where to extract the report
 *                       (default <tmpdir>/<task_id>.report.md)
 *   --once              query once and exit; no waiting
 *   --verbose           heartbeat to stderr on each poll
 *   --no-digest         omit the digest fields (see "Token economy" above)
 *   --home PATH         agent-flow home (default $AGENT_FLOW_HOME, else ~/.agent-flow-ex)
 *
 * How long can this wait?
 * -----------------------
 * Three layers, and only the middle one is this script's business:
 *
 *   tool layer     a background process is NOT killed by the Bash call's timeout. Verified
 *                  2026-09-23: a probe run with an explicit 600s timeout survived to 700s,
 *                  and one launched with no timeout at all kept heartbeating past the 120s
 *                  default (task mvr3kW). So the script's lifetime is its own choice.
 *
 *   script layer   `--max-wait-sec`, defaulting to a value derived from the task's own
 *                  `timeout_sec`. The runner gives each attempt its own full timeout
 *                  (runner.ts:133) and retries transient failures up to MAX_ATTEMPTS=3 with
 *                  30s/60s backoff, and a real timeout is never retried — so nothing the
 *                  runner itself would allow can outlive 3*timeout_sec + 90s. Waiting 2
 *                  minutes past that is what makes a timeout wake *mean* something ("the
 *                  runner outlived its own worst case — it probably died without finalizing")
 *                  instead of being noise. Pass 0 to wait forever.
 *
 *   task layer     every task ends on its own: the runner finalizes to completed / failed /
 *                  needs_input. queued also resolves (the host spawns the runner immediately).
 *                  The only way to sit in `running` forever is a runner that died without
 *                  finalizing, which is exactly the case the derived max-wait catches.
 *
 * On timeout the script exits 2 and does NOT re-launch itself — re-waiting is the caller's
 * call, because only the caller knows whether to wait, cancel, or re-dispatch. With the
 * derived default a timeout is rare and always worth a look.
 *
 * Output: KEY=VALUE lines on stdout, terminated by a WAIT=... line
 *   WAIT=terminal    exit 0   completed / failed / cancelled — review the report, then act
 *   WAIT=needs_input exit 5   worker is blocked on a question — answer via continue_of,
 *                             then re-run this script on the same task id
 *   WAIT=timeout     exit 2   still running/queued when max-wait elapsed (or --once)
 *   WAIT=not_found   exit 3   no such task, or tasks.db unreadable
 *                    exit 4   usage error
 *
 * Report extraction rule (this is the part that bites)
 * ---------------------------------------------------
 * Two things have to be right, and getting either wrong fails *silently* — the script still
 * exits 0 and still hands over a path, so the caller cannot tell "no report" from "empty
 * report" without reading it.
 *
 *   1. Which lines count. Compaction summaries ("This session is being continued from a
 *      previous conversation…") arrive on lines whose message.role is "user" and can be
 *      several times longer than the real report — a naive "longest text block wins" scan
 *      hands back the summary instead of the deliverable. Verified on task_mu9jj2zd_9b3341:
 *      215 assistant lines, longest block 3322 chars = the actual report.
 *
 *   2. Which *shape* counts. claude nests text under message.content[]; opencode emits a flat
 *      {"type":"text","text":…}. A claude-only rule returns "" for every opencode task.
 *      Verified 2026-09-23 with the same report text in both shapes: REPORT_CHARS=440 for
 *      claude, 0 for opencode. See assistantTexts().
 *
 * What the caller gets back is the *longest* assistant text block, not the runner's own
 * `result` column. That is deliberate: the DB copy is truncated to 4000 chars (runner.ts:20)
 * and is the *last* assistant message, which on a long task is often a one-line sign-off
 * rather than the report. Real example — task_mtla69fx_3872f3: result (401 chars) = "清理完成,
 * 所有 monitor 已停止…", while the log's longest block (11461 chars) is the titled
 * "最终报告". Conversely, on a task that died mid-flight the longest block is whatever
 * reasoning was longest, NOT a conclusion — read it with STATUS/ERROR, never as a report.
 *
 * Read-only by design: the DB is opened with readOnly:true so this can never interfere
 * with the MCP server or a live runner.
 *
 * Token economy
 * -------------
 * There are two ways to wait for a task, and they differ by orders of magnitude:
 *
 *   in-session polling   the dispatcher sleeps in a tool call and re-checks status in a
 *                        loop. Every check is a full API round-trip, and a round-trip
 *                        replays the *entire* session context — so the cost is
 *                        (task duration / interval) × (whole conversation), not "the size
 *                        of a status line". A 22-min median task polled every 60s is ~22
 *                        full replays; at p75 (39 min) it is ~39. It also occupies the
 *                        session, so the user cannot talk to the agent meanwhile.
 *
 *   background wait      this script. The wait lives in its own process; the model is not
 *                        in the loop at all, so cost is exactly zero until the wake. Then
 *                        one notification arrives — verified 2026-09-23 (probe YvERVF): a
 *                        300-line / 21k-char background output produced a ~200-char
 *                        notification carrying only the stdout *file path*, never the
 *                        contents. Notification size is independent of printed volume.
 *
 * Consequence: the wait must not be outsourced, and the wake must land in the dispatcher's
 * own session. That is the property worth protecting — the dispatcher wakes with the prior
 * tasks' facts, the current plan's constraints, and anything the user said while the worker
 * ran. Handing the wake (or the review) to a separate context throws away the expensive
 * part; the report text is the cheap part.
 *
 * The only remaining cost is what the caller reads after waking, and that is a choice.
 * REPORT_OUTLINE / REPORT_TEXT (short reports) / REPORT_HEAD (long reports) exist so a
 * reviewer can usually decide without opening REPORT_PATH at all: a full report read into
 * the main context is re-billed on every subsequent turn of the session, which quickly
 * dwarfs the one-off read. Read REPORT_PATH only when the digest leaves a real doubt —
 * and then read a slice (grep/offset), not the whole thing.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// Not terminal — the task resumes when the dispatcher answers with continue_of — but it is
// *actionable*: the worker has stopped and only the dispatcher can move it forward. Waking
// on it is the point; sleeping through it wastes the entire max-wait window.
const ACTIONABLE = new Set(["needs_input"]);
// Fallback when the row carries no usable timeout_sec (it always should).
const DEFAULT_MAX_WAIT_SEC = 7200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USAGE =
  "usage: node wait-task.mjs <task_id> [--interval-sec N] [--max-wait-sec N] " +
  "[--report-out PATH] [--once] [--verbose] [--no-digest] [--home PATH]";

function usage(msg) {
  if (msg) console.error(`wait-task: ${msg}`);
  console.error(USAGE);
  process.exit(4);
}

// ---------------------------------------------------------------- args

const opts = {
  intervalSec: 20,
  maxWaitSec: null,   // null = derive from the task row; 0 = never give up
  reportOut: null,
  once: false,
  verbose: false,
  noDigest: false,
  home: process.env.AGENT_FLOW_HOME ?? join(homedir(), ".agent-flow-ex"),
};

const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const takeValue = () => {
    const v = argv[++i];
    if (v === undefined) usage(`${a} requires a value`);
    return v;
  };
  if (a === "--interval-sec") opts.intervalSec = Number(takeValue());
  else if (a === "--max-wait-sec") opts.maxWaitSec = Number(takeValue());
  else if (a === "--report-out") opts.reportOut = takeValue();
  else if (a === "--home") opts.home = takeValue();
  else if (a === "--once") opts.once = true;
  else if (a === "--verbose") opts.verbose = true;
  else if (a === "--no-digest") opts.noDigest = true;
  else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else positional.push(a);
}

if (positional.length !== 1) usage("exactly one task_id is required");
if (!Number.isFinite(opts.intervalSec) || opts.intervalSec <= 0) usage("--interval-sec must be > 0");
if (opts.maxWaitSec !== null && (!Number.isFinite(opts.maxWaitSec) || opts.maxWaitSec < 0)) {
  usage("--max-wait-sec must be >= 0");
}

const taskId = positional[0];
const SELECT =
  "SELECT id, status, project_path, log_path, files_changed, started_at, ended_at, error, question, timeout_sec " +
  "FROM tasks WHERE id = ?";

// How long this wait is willing to run. See "How long can this wait?" at the top.
let effectiveMaxWait = null;

/**
 * Worst case the runner itself permits: MAX_ATTEMPTS (3) attempts each with the task's own
 * full timeout_sec, plus 30s+60s backoff between them (runner.ts:24-26,133), plus slack for
 * finalize + notify. Past that, a still-`running` task means the runner died without
 * finalizing — so a timeout wake is diagnostic rather than noise.
 */
function deriveMaxWait(timeoutSec) {
  const t = Number(timeoutSec);
  if (!Number.isFinite(t) || t <= 0) return DEFAULT_MAX_WAIT_SEC;
  return t * 3 + 90 + 120;
}

// ---------------------------------------------------------------- db

let db = null;
let dbError = null;

/** Returns a row object, null when the task does not exist, or throws on an unreadable DB. */
function readTask() {
  if (!db && !dbError) {
    try {
      db = new DatabaseSync(join(opts.home, "tasks.db"), { readOnly: true });
    } catch (e) {
      dbError = e.message;
    }
  }
  if (dbError) throw new Error(`cannot open ${join(opts.home, "tasks.db")}: ${dbError}`);
  return db.prepare(SELECT).get(taskId) ?? null;
}

// ---------------------------------------------------------------- report extraction

/**
 * Every assistant-authored text block carried by one log line, across executor shapes.
 *
 *   claude    {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":…}]}}
 *   opencode  {"type":"text","text":…}                      (executors/opencode.ts:45-47)
 *
 * On the claude shape both filters matter: type=="assistant" excludes compaction summaries,
 * and the role check is the second line of defence if a future log shape mingles them. The
 * opencode branch mirrors what that executor's own parseEvent treats as assistant text, and
 * is not decoration — with only the claude branch, every opencode task yields "" silently.
 * The two shapes cannot collide: claude nests its text, so a top-level type=="text" line
 * never appears in a claude stream.
 */
function assistantTexts(ev) {
  if (ev.type === "assistant") {
    const msg = ev.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
    return msg.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
  }
  if (ev.type === "text") {
    const text = typeof ev.text === "string" ? ev.text : ev.part?.text;
    return typeof text === "string" ? [text] : [];
  }
  return [];
}

function extractReport(logPath) {
  let raw;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
  let longest = "";
  for (const line of raw.split("\n")) {
    if (!line || line.charCodeAt(0) !== 0x7b /* { */) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev) continue;
    for (const text of assistantTexts(ev)) {
      if (text.length > longest.length) longest = text;
    }
  }
  return longest;
}

/**
 * Section headings only — a few dozen tokens that let the reviewer check the report
 * actually contains the sections it was asked for. Enough to catch a truncated or hollow
 * report without paying for the whole text.
 */
function outlineOf(text) {
  const heads = [];
  for (const raw of text.split("\n")) {
    const m = /^#{1,4}\s+(.+?)\s*$/.exec(raw.trim());
    if (!m) continue;
    heads.push(m[1]);
    if (heads.length >= 20) break;
  }
  return heads;
}

// ---------------------------------------------------------------- output

const oneLine = (s, max = 300) => String(s).replace(/\s+/g, " ").trim().slice(0, max);

function emit(row, wait) {
  const lines = [
    `TASK_ID=${row.id}`,
    `STATUS=${row.status}`,
    `WAIT=${wait}`,
    `MAX_WAIT_SEC=${effectiveMaxWait === 0 ? "never" : effectiveMaxWait ?? DEFAULT_MAX_WAIT_SEC}`,
  ];

  const end = row.ended_at ?? Math.floor(Date.now() / 1000);
  if (row.started_at) lines.push(`ELAPSED_SEC=${end - row.started_at}`);
  if (row.project_path) lines.push(`PROJECT_PATH=${row.project_path}`);

  let filesChanged = 0;
  try {
    filesChanged = JSON.parse(row.files_changed ?? "[]").length;
  } catch {
    /* keep 0 */
  }
  lines.push(`FILES_CHANGED=${filesChanged}`);

  if (row.error) lines.push(`ERROR=${oneLine(row.error)}`);
  if (row.question) lines.push(`QUESTION=${oneLine(row.question)}`);

  const isTerminal = TERMINAL.has(row.status);
  const hasResult = isTerminal || ACTIONABLE.has(row.status);
  if (hasResult) {
    const text = extractReport(row.log_path);
    const reportPath = opts.reportOut ?? join(tmpdir(), `${row.id}.report.md`);
    try {
      writeFileSync(reportPath, text);
    } catch (e) {
      console.error(`wait-task: could not write report: ${e.message}`);
    }
    lines.push(`LOG_PATH=${row.log_path}`);
    lines.push(`REPORT_PATH=${reportPath}`);
    lines.push(`REPORT_CHARS=${text.length}`);

    // Digest: the cheap stand-in for reading the report. See "Token economy" at the top.
    // Terminal only — when a question is pending the caller's next move is to answer it,
    // and the QUESTION line already carries the payload.
    if (isTerminal && !opts.noDigest && text.length > 0) {
      const heads = outlineOf(text);
      if (heads.length) lines.push(`REPORT_OUTLINE=${oneLine(heads.join(" | "), 600)}`);
      // A short report is cheapest inlined outright — that saves the caller a whole file
      // read, and inlining costs the same tokens as reading the file would. The threshold
      // accounts for this script's own ~450-char fixed overhead: below it, HEAD+path would
      // actually be *larger* than just handing over the text. Only genuinely long reports
      // are reduced to a head plus a path to the rest.
      if (text.length <= 1200) lines.push(`REPORT_TEXT=${oneLine(text, 1200)}`);
      else lines.push(`REPORT_HEAD=${oneLine(text.slice(0, 700), 700)}`);
    }
    if (isTerminal && text.length === 0) {
      // Not fatal, but the caller must know the report is missing rather than assume
      // a zero-length report means "the worker said nothing".
      console.error(
        "wait-task: no assistant text block found; read LOG_PATH directly " +
          "(the run may have died before producing a report, or used a non-claude event shape)",
      );
    }
  }

  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  let last = null;

  for (;;) {
    let row;
    try {
      row = readTask();
    } catch (e) {
      console.error(`wait-task: ${e.message}`);
      console.log(`TASK_ID=${taskId}\nSTATUS=unknown\nWAIT=not_found`);
      return 3;
    }

    if (row === null) {
      console.log(`TASK_ID=${taskId}\nSTATUS=unknown\nWAIT=not_found`);
      return 3;
    }

    last = row;
    // Resolve the wait budget once, from the task's own timeout_sec (it never changes).
    if (effectiveMaxWait === null) {
      effectiveMaxWait = opts.maxWaitSec ?? deriveMaxWait(row.timeout_sec);
    }
    if (opts.verbose) {
      console.error(`[wait-task] ${new Date().toISOString()} status=${row.status}`);
    }

    if (TERMINAL.has(row.status)) {
      emit(row, "terminal");
      return 0;
    }

    // Actionable but non-terminal: wake now instead of waiting out the clock.
    if (ACTIONABLE.has(row.status)) {
      emit(row, "needs_input");
      return 5;
    }

    if (opts.once) {
      emit(row, "timeout");
      return 2;
    }

    const waited = (Date.now() - t0) / 1000;
    if (effectiveMaxWait > 0 && waited >= effectiveMaxWait) {
      console.error(
        `wait-task: task still ${row.status} after ${Math.round(waited)}s, past the ${effectiveMaxWait}s ` +
          `budget derived from timeout_sec=${row.timeout_sec} — the runner likely died without finalizing.`,
      );
      emit(last, "timeout");
      return 2;
    }

    await sleep(opts.intervalSec * 1000);
  }
}

let code = 0;
try {
  code = await main();
} catch (e) {
  console.error(`wait-task: fatal: ${e?.stack ?? e}`);
  code = 1;
} finally {
  try {
    db?.close();
  } catch {
    /* already gone */
  }
}
process.exitCode = code;
