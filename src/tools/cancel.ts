import { openStore, TERMINAL_STATUSES } from "../store.js";
import { dbPath } from "../paths.js";

export interface CancelArgs { task_id: string }

export type CancelResult = { task_id: string; status: string } | { error: string };

/** 状态感知、幂等取消（spec §6）。 */
export function cancel(args: CancelArgs): CancelResult {
  if (!args.task_id) return { error: "task_id is required" };
  const store = openStore(dbPath());
  const t = store.getTask(args.task_id);
  if (!t) return { error: `task ${args.task_id} not found` };
  if (TERMINAL_STATUSES.includes(t.status)) return { task_id: t.id, status: t.status }; // 幂等

  if (t.status === "running" && t.pid) {
    try { process.kill(-t.pid, "SIGTERM"); } catch { /* runner 可能刚退出，继续置状态 */ }
  }
  const ok = store.transition(t.id, [t.status], "cancelled", { ended_at: Math.floor(Date.now() / 1000) });
  if (!ok) {
    const cur = store.getTask(t.id)!;
    return { task_id: t.id, status: cur.status }; // 并发变化：返回实际状态
  }
  return { task_id: t.id, status: "cancelled" };
}