import { openStore, type Task } from "../store.js";
import { dbPath } from "../paths.js";

export interface StatusArgs { task_id?: string }

interface TaskView {
  task_id: string;
  status: string;
  rounds: number;
  profile: string;
  elapsed_sec: number | null;
  progress: string | null;
  files_changed: string[];
  question?: string;
  result?: string;
  error?: string;
  notify_failed?: boolean;
}

/** 僵死检测（spec §5/§10）：running/queued 且 pid 不存活 → failed(interrupted)。EPERM 视为存活（进程存在但属他人）。 */
function reapZombies(tasks: Task[], store: ReturnType<typeof openStore>): void {
  for (const t of tasks) {
    if ((t.status === "running" || t.status === "queued") && t.pid) {
      let alive: boolean;
      try { process.kill(t.pid, 0); alive = true; } catch (e: unknown) {
        const code = (e as { code?: string } | null)?.code;
        alive = code === "EPERM";
      }
      if (!alive) {
        store.transition(t.id, ["running", "queued"], "failed", { error: "interrupted (runner process gone)", ended_at: Math.floor(Date.now() / 1000) });
      }
    }
  }
}

function view(t: Task): TaskView {
  const now = Math.floor(Date.now() / 1000);
  return {
    task_id: t.id,
    status: t.status,
    rounds: t.rounds,
    profile: t.profile,
    elapsed_sec: t.started_at ? (t.ended_at ?? now) - t.started_at : null,
    progress: t.progress,
    files_changed: t.files_changed,
    ...(t.status === "needs_input" && t.question ? { question: t.question } : {}),
    ...(t.result ? { result: t.result } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.notify_failed ? { notify_failed: true } : {}),
  };
}

export function status(args: StatusArgs): TaskView | TaskView[] | { error: string } {
  const store = openStore(dbPath());
  if (args.task_id) {
    reapZombies(store.getTask(args.task_id) ? [store.getTask(args.task_id)!] : [], store);
    const t = store.getTask(args.task_id);
    if (!t) return { error: `task ${args.task_id} not found` };
    return view(t);
  }
  const active = store.listActive();
  reapZombies(active, store);
  return store.listActive().map(view);
}