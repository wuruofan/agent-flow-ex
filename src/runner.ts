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
import { killTree } from "./proc-tree.js";

const MAX_ROUNDS = 5;
const NOTIFY_GRACE_MS = 1500; // SIGTERM 后给通知 promise 的最长等待时间
const MAX_RESULT_LEN = 4000;

// 瞬态重试：agent 自身内部重试耗尽后仍把 429/529 当作终态报错时，runner 再兜底重试。
// 仅对「瞬时/可恢复」错误重试；timeout（真超时）、needs_input（等人工）、硬失败不重试。
const MAX_ATTEMPTS = 3;
// 退避可用 AGENT_FLOW_RETRY_BACKOFF_MS 覆盖（逗号分隔，毫秒），便于集成测试走短退避；生产默认 30s/60s。
const RETRY_BACKOFF_MS = (process.env.AGENT_FLOW_RETRY_BACKOFF_MS ?? "30000,60000")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

/** 判断 agent 终态报错是否为可重试的瞬时错误（429 限流 / 529 集群过载 / 5xx / 连接重置 / 配额临时不可用）。 */
function isTransientError(text: string | null): boolean {
  if (!text) return false;
  const patterns = [
    /\b429\b/,                 // Too Many Requests / Token Plan 上限
    /\b529\b/,                 // MiniMax 集群过载
    /\b50[234]\b/,             // 502/503/504 网关/服务临时不可用
    /token plan/i,
    /用量上限/,
    /集群负载/,
    /request rejected/i,
    /rate.?limit/i,
    /econnreset|etimedout|socket hang up|fetch failed|connection reset|upstream connect error/i,
    /try again|稍后重试/i,
  ];
  return patterns.some((p) => p.test(text));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 单次 agent 运行的结果快照（供重试循环与终态裁决共用）。 */
interface RunOutcome {
  timedOut: boolean;
  question: string | null;
  resultText: string | null;
  resultIsError: boolean;
  stderrTail: string;
  lastAssistantText: string;
  code: number | null;
}

/** 当前轮 finalize 启动的通知 promise；SIGTERM handler 等待它完成（防止被截断导致 notify_failed 未落库）。 */
let pendingNotify: Promise<void> | null = null;

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) { console.error("usage: runner.ts <task_id>"); process.exit(2); }

  const store = openStore(dbPath());
  const task = store.getTask(taskId)!; // 非空断言仅供闭包内类型窄化；下一行运行时 guard 兜底
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
  // cancel 场景：server 端 killTree(runnerPid)（组杀 runner + agent；逃逸子进程靠 ppid 快照补杀）。
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

  // 配额/限流告警单任务只推一次（任务级去重，不依赖 DB 字段）。
  // runner 崩了 SIGTERM 整体收尾不再触发告警，故无需持久化。
  let quotaWarned = false;

  // 单次 agent 运行：spawn → 逐行解析事件/落库/写日志 → 终态时 resolve 出本次运行结果。
  // 不设 detached：agent 继承 runner 的进程组（runner 自己是 leader），便于 cancel 时组杀级联到 agent。
  // 注意：agent 的 Bash 工具可能派生出逃出该组的子进程（见 proc-tree.ts），cancel/timeout 用 killTree 兜底。
  function runAgent(attempt: number): Promise<RunOutcome> {
    return new Promise((resolve) => {
      const files = new Set<string>(task.files_changed ?? []);
      const log = createWriteStream(task.log_path, { flags: "a" });
      const args = executor.buildCommand(executorCfg.bin, executorCfg.extra_flags ?? [], task.session_id ?? undefined);
      const child: ChildProcess = spawn(executorCfg.bin, args, {
        cwd: task.project_path,
        env: buildAgentEnv(executorCfg.bin, profileEnv),
        stdio: ["pipe", "pipe", "pipe"],
      });
      log.write(JSON.stringify({ type: "_runner", event: "spawn", argv: args, round: task.rounds, attempt, child_pid: child.pid }) + "\n");
      child.stdin!.write(prompt);
      child.stdin!.end();

      let timedOut = false;
      // 每轮超时：killTree(child.pid) 给 agent 发 SIGTERM（含其后代树，覆盖 agent Bash 工具逃出进程组的
      // 长命令子进程），3s 后未驯服者自动补 SIGKILL（killTree 内部兜底）。agent 退出后 child.close 触发，
      // 本次运行标记为 timedOut。
      // 注意：避免 kill(-process.pid) 给整个进程组——那会让 runner 自己 SIGTERM 跳过 child.close 处理；
      // killTree 只从 child.pid 向下清，不动 runner 所在的组根。
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid);
      }, task.timeout_sec * 1000);
      timeoutTimer.unref();

      let lastAssistantText = "";
      let resultText: string | null = null;
      let resultIsError = false;
      let stderrTail = "";
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
        // 配额告警：识别到首个 429 / 硬配额信号时立即推一张 ⚠️ 卡，不再静默等终态。
        if (ev.quotaWarning && !quotaWarned) {
          quotaWarned = true;
          pushQuotaWarning(cfg, task.id, ev.quotaWarning);
        }
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
        resolve({ timedOut, question, resultText, resultIsError, stderrTail, lastAssistantText, code });
      });
    });
  }

  // 重试循环：仅对瞬时错误（429/529/5xx/连接重置/配额临时不可用）重试；
  // timeout（真超时）、needs_input（等人工）、硬失败不重试。第 MAX_ATTEMPTS 次仍失败即终态 failed。
  let outcome: RunOutcome | null = null;
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    outcome = await runAgent(attempt);
    const finalText = (outcome.resultText ?? outcome.lastAssistantText ?? "").trim();
    if (outcome.timedOut) break;           // 真超时，不是 API 瞬时错误
    if (outcome.question) break;           // 等人工，交给 dispatcher 代答/续跑
    if (outcome.resultIsError || outcome.code !== 0) {
      const errText = outcome.stderrTail || finalText || "";
      if (isTransientError(errText) && attempt < MAX_ATTEMPTS) {
        appendFileSync(task.log_path, JSON.stringify({ type: "_retry", attempt, reason: trunc(errText, 200) }) + "\n");
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 60000);
        continue;
      }
    }
    break;
  }

  // 终态裁决（与单次运行的分支语义完全一致）
  const o = outcome!;
  const finalText = (o.resultText ?? o.lastAssistantText ?? "").trim();
  const question = o.question;
  if (o.timedOut) {
    finalize(store, task, "failed", { error: `timeout after ${task.timeout_sec}s (round ${task.rounds})`, result: trunc(finalText) }, cfg);
  } else if (question) {
    if (task.rounds >= MAX_ROUNDS) {
      finalize(store, task, "failed", { error: `rounds limit (${MAX_ROUNDS}) reached with pending question`, question: trunc(question) }, cfg);
    } else {
      finalize(store, task, "needs_input", { question: trunc(question), result: trunc(finalText) }, cfg);
    }
  } else if (o.resultIsError) {
    finalize(store, task, "failed", { error: trunc(o.stderrTail || finalText || "agent reported error"), result: trunc(finalText) }, cfg);
  } else if (o.code === 0 && finalText) {
    finalize(store, task, "completed", { result: trunc(finalText) }, cfg);
  } else {
    finalize(store, task, "failed", { error: trunc(o.stderrTail || `agent exited with code ${o.code ?? "?"}`) }, cfg);
  }
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

/**
 * 中途配额/限流告警推送：复用 finalize 的 webhook/env 解析路径，独立 fire-and-forget。
 * 不阻塞事件循环；不修改任务状态（任务还在跑）；不进入 pendingNotify（避免被 SIGTERM 截断）。
 * 唯一去重由 runner 主循环的 quotaWarned 局部标志保证（同任务只触发一次）。
 */
function pushQuotaWarning(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  taskId: string,
  q: { status?: number; message: string; attempt?: number },
): void {
  const dryRun = cfg.notify.dry_run ?? true;
  const webhook = dryRun ? cfg.notify.feishu_webhook_url
    : resolveEnvPlaceholders({ url: cfg.notify.feishu_webhook_url }).url;
  const parts: string[] = [];
  if (typeof q.status === "number") parts.push(`**状态码**：\`${q.status}\``);
  if (typeof q.attempt === "number") parts.push(`**重试次数**：${q.attempt}`);
  parts.push(`worker 触发配额/限流信号，正在重试；持续下去任务大概率失败，会自动推送终态卡片。`);
  if (q.message) parts.push(`\n> ${q.message}`);
  const detail = parts.join("\n\n");
  sendFeishuCard(webhook, buildFeishuCard("quota_warning", taskId, detail, cfg.notify.keyword), { dryRun })
    .catch((e) => { console.error("[quota-warn] unexpected:", e); });
}

main().catch((e) => { console.error("[runner] fatal:", e); process.exit(1); });