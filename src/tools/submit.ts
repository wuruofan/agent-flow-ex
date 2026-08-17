import { randomBytes } from "node:crypto";
import { statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../store.js";
import { loadConfig } from "../config.js";
import { logsDir, dbPath } from "../paths.js";
import { spawnDetachedRunner } from "../spawn-runner.js";

export interface SubmitArgs {
  prompt: string;
  project_path?: string;
  profile?: string;
  continue_of?: string;
  timeout_sec?: number;
}

export type SubmitResult = { task_id: string; status: string; rounds: number } | { error: string };

export function submit(args: SubmitArgs): SubmitResult {
  if (!args.prompt?.trim()) return { error: "prompt is required" };
  const cfg = loadConfig();
  const store = openStore(dbPath());

  // ---- 续跑：needs_input 任务答疑 ----
  if (args.continue_of) {
    const t = store.getTask(args.continue_of);
    if (!t) return { error: `task ${args.continue_of} not found` };
    if (t.status !== "needs_input") return { error: `task ${args.continue_of} is "${t.status}", expected "needs_input"` };
    const rounds = t.rounds + 1;
    const ok = store.transition(args.continue_of, ["needs_input"], "running", { rounds });
    if (!ok) return { error: `task ${args.continue_of} state changed concurrently (now "${store.getTask(args.continue_of)?.status}")` };
    appendFileSync(t.log_path, JSON.stringify({ type: "user_prompt", round: rounds, text: args.prompt }) + "\n");
    const child = spawnDetachedRunner(args.continue_of);
    store.patch(args.continue_of, { pid: child.pid ?? null });
    return { task_id: args.continue_of, status: "running", rounds };
  }

  // ---- 新任务 ----
  const profileName = args.profile ?? cfg.defaults.profile;
  const profile = cfg.profiles[profileName];
  if (!profile) return { error: `unknown profile "${profileName}"` };
  if (!cfg.executors[profile.executor]) return { error: `profile "${profileName}" references unknown executor` };

  const timeout_sec = args.timeout_sec ?? cfg.defaults.timeout_sec;
  if (!Number.isInteger(timeout_sec) || timeout_sec <= 0) return { error: "timeout_sec must be a positive integer" };

  const project_path = args.project_path ?? process.cwd();
  try {
    if (!statSync(project_path).isDirectory()) return { error: `project_path "${project_path}" is not a directory` };
  } catch {
    return { error: `project_path "${project_path}" not accessible` };
  }

  const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  store.createTask({
    id, prompt: args.prompt, project_path, executor: profile.executor, profile: profileName,
    timeout_sec, log_path: join(logsDir(), `${id}.jsonl`), role: "worker",
    created_at: Math.floor(Date.now() / 1000),
  });
  const child = spawnDetachedRunner(id);
  store.patch(id, { pid: child.pid ?? null });
  return { task_id: id, status: "queued", rounds: 1 };
}