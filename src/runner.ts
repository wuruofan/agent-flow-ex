/**
 * detached runner 入口：node runner.ts <task_id>
 * 生命周期：认领任务 → 组装命令 → spawn agent(detached) → 逐行解析事件/落库/写日志 → 终态 + 通知。
 */
import { appendFileSync, createWriteStream, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { openStore, type Task, type TaskPatch } from "./store.js";
import { loadConfig, resolveEnvPlaceholders } from "./config.js";
import { getExecutor } from "./executors/types.js";
import { buildAgentEnv } from "./agent-env.js";
import { wrapInitialPrompt, wrapContinuePrompt, extractNeedsInput } from "./prompt.js";
import { sendFeishuCard, buildFeishuCard } from "./notifier.js";
import { dbPath } from "./paths.js";

const MAX_ROUNDS = 5;
const KILL_GRACE_MS = 3000;
const NOTIFY_GRACE_MS = 1500; // SIGTERM 后给通知 promise 的最长等待时间
const MAX_RESULT_LEN = 4000;

/** 当前轮 finalize 启动的通知 promise；SIGTERM handler 等待它完成（防止被截断导致 notify_failed 未落库）。 */
let pendingNotify: Promise<void> | null = null;

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) { console.error("usage: runner.ts <task_id>"); process.exit(2); }

  const store = openStore(dbPath());
  const task = store.getTask(taskId);
  if (!task) { console.error(`task ${taskId} not found`); process.exit(2); }
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    console.error(`task ${taskId} already terminal (${task.status}); exiting`);
    process.exit(0);
  }

  if (!store.claimToRunning(taskId, process.pid)) {
    const cur = store.getTask(taskId);
    console.error(`claim failed, task is ${cur?.status ?? "gone"}; exiting`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const executorCfg = cfg.executors[task.executor];
  const executor = getExecutor(task.executor);
  const profileEnv = cfg.profiles[task.profile]?.env ?? {};

  // 本轮原始输入：round1 用 task.prompt；续跑轮从日志读 server 预写的 user_prompt 行
  const rawInput = task.rounds === 1 ? task.prompt : readRoundInput(task.log_path, task.rounds);
  if (rawInput === null) {
    finalize(store, task, "failed", { error: `round ${task.rounds} input not found in log` }, cfg);
    return;
  }
  const prompt = task.rounds === 1 ? wrapInitialPrompt(rawInput) : wrapContinuePrompt(rawInput);
  appendFileSync(task.log_path, JSON.stringify({ type: "user_prompt", round: task.rounds, text: rawInput }) + "\n");
  const log = createWriteStream(task.log_path, { flags: "a" });

  const args = executor.buildCommand(executorCfg.bin, executorCfg.extra_flags ?? [], task.session_id ?? undefined);
  // 不设 detached：让 agent 继承 runner 的进程组（runner 自己是 leader），便于 cancel 时 kill(-runnerPid) 级联到 agent。
  const child: ChildProcess = spawn(executorCfg.bin, args, {
    cwd: task.project_path,
    env: buildAgentEnv(executorCfg.bin, profileEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  log.write(JSON.stringify({ type: "_runner", event: "spawn", argv: args, round: task.rounds, child_pid: child.pid }) + "\n");
  child.stdin!.write(prompt);
  child.stdin!.end();

  // cancel 场景：server kill(-runnerPid)。agent 与 runner 同进程组，会随 runner 一起被 SIGTERM，无需单独再杀。
  // 先等 final 通知最多 NOTIFY_GRACE_MS 完成再退出，避免截断导致 notify_failed 未标。
  process.on("SIGTERM", () => {
    if (pendingNotify) {
      Promise.race([
        pendingNotify,
        new Promise<void>((r) => setTimeout(r, NOTIFY_GRACE_MS)),
      ]).catch(() => { /* finalize 已记日志 */ });
    }
    process.exit(0);
  });

  // 每轮超时：给 agent 发 SIGTERM → 3s 后 SIGKILL。agent 退出后 child.close 触发，
  // finalize 走 timedOut 分支并标 failed（task 转 failed + pendingNotify 落库）。
  // 注意：避免 kill(-process.pid) 给整个进程组——那会让 runner 自己 SIGTERM 跳过 child.close 处理。
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid !== undefined) process.kill(child.pid, "SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => { try { if (child.pid !== undefined) process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ } }, KILL_GRACE_MS).unref();
  }, task.timeout_sec * 1000);
  timeoutTimer.unref();

  // 事件流解析
  let lastAssistantText = "";
  let resultText: string | null = null;
  let resultIsError = false;
  let stderrTail = "";
  const files = new Set<string>(task.files_changed ?? []);

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    log.write(line + "\n");
    const ev = executor.parseEvent(line);
    if (!ev) return;
    const patch: TaskPatch = {};
    if (ev.sessionId && !task.session_id) { patch.session_id = ev.sessionId; task.session_id = ev.sessionId; }
    if (ev.toolUse) {
      if (ev.toolUse.file) files.add(ev.toolUse.file);
      patch.progress = `${ev.toolUse.name} ${ev.toolUse.file ?? ""}`.trim();
      patch.files_changed = [...files];
    }
    if (ev.assistantText) lastAssistantText = ev.assistantText;
    if (ev.result) { resultText = ev.result.text; resultIsError = ev.result.isError; }
    if (Object.keys(patch).length) store.patch(taskId, patch);
  });
  child.stderr!.on("data", (d: Buffer) => {
    const s = d.toString();
    stderrTail = (stderrTail + s).slice(-2048);
    log.write(JSON.stringify({ type: "stderr", text: s }) + "\n");
  });

  child.on("close", (code) => {
    clearTimeout(timeoutTimer);
    log.end();
    const finalText = (resultText ?? lastAssistantText ?? "").trim();
    const question = extractNeedsInput(finalText);
    if (timedOut) {
      finalize(store, task, "failed", { error: `timeout after ${task.timeout_sec}s (round ${task.rounds})`, result: trunc(finalText) }, cfg);
    } else if (question) {
      if (task.rounds >= MAX_ROUNDS) {
        finalize(store, task, "failed", { error: `rounds limit (${MAX_ROUNDS}) reached with pending question`, question: trunc(question) }, cfg);
      } else {
        finalize(store, task, "needs_input", { question: trunc(question), result: trunc(finalText) }, cfg);
      }
    } else if (resultIsError) {
      finalize(store, task, "failed", { error: trunc(stderrTail || finalText || "agent reported error"), result: trunc(finalText) }, cfg);
    } else if (code === 0 && finalText) {
      finalize(store, task, "completed", { result: trunc(finalText) }, cfg);
    } else {
      finalize(store, task, "failed", { error: trunc(stderrTail || `agent exited with code ${code ?? "?"}`) }, cfg);
    }
  });
}

function finalize(
  store: ReturnType<typeof openStore>, task: Task,
  to: "needs_input" | "completed" | "failed", patch: TaskPatch,
  cfg: Awaited<ReturnType<typeof loadConfig>>
): void {
  const ok = store.transition(task.id, ["running"], to, { ...patch, ended_at: Math.floor(Date.now() / 1000) });
  if (!ok) { console.error(`terminal transition to ${to} lost race; task state changed elsewhere`); return; }
  const detail = to === "needs_input" ? String(patch.question ?? "") : to === "completed" ? trunc(String(patch.result ?? "")) : String(patch.error ?? "");
  // 注册 pending 给 SIGTERM handler 等待；正常完成后清空，避免内存里挂旧 promise。
  // feishu_webhook_url 支持 {env:VAR} 占位符；dry_run 时不解析（打日志即可），真实发送才解析，
  // 缺变量时抛错 → notify_failed（任务状态不受影响）。
  const dryRun = cfg.notify.dry_run ?? true;
  const webhook = dryRun ? cfg.notify.feishu_webhook_url
    : resolveEnvPlaceholders({ url: cfg.notify.feishu_webhook_url }).url;
  pendingNotify = sendFeishuCard(webhook, buildFeishuCard(to, task.id, detail, cfg.notify.keyword), { dryRun })
    .then((sent) => { if (!sent) store.patch(task.id, { notify_failed: true }); })
    .catch((e) => { console.error("[notifier] unexpected:", e); store.patch(task.id, { notify_failed: true }); })
    .finally(() => { pendingNotify = null; });
}

function readRoundInput(logPath: string, round: number): string | null {
  let found: string | null = null;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j?.type === "user_prompt" && j.round === round && typeof j.text === "string") found = j.text;
    } catch { /* skip event lines */ }
  }
  return found;
}

function trunc(s: string, max = MAX_RESULT_LEN): string {
  return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
}

main().catch((e) => { console.error("[runner] fatal:", e); process.exit(1); });