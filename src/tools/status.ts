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

function view(t: Task): TaskView {
  const now = Math.floor(Date.now() / 1000);
  return {
    task_id: t.id,
    status: t.status,
    rounds: t.rounds,
    profile: t.profile,
    timeout_sec: t.timeout_sec,
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
    const t = store.getTask(args.task_id);
    if (!t) return { error: `task ${args.task_id} not found` };
    return view(t);
  }
  return store.listActive().map(view);
}