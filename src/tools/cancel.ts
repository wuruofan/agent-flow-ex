import { openStore, TERMINAL_STATUSES } from "../store.js";
import { dbPath } from "../paths.js";
import { killTree } from "../proc-tree.js";

export interface CancelArgs { task_id: string }

export type CancelResult = { task_id: string; status: string; warning?: string } | { error: string };

/** 状态感知、幂等取消（spec §6）。 */
export function cancel(args: CancelArgs): CancelResult {
  if (!args.task_id) return { error: "task_id is required" };
  const store = openStore(dbPath());
  const t = store.getTask(args.task_id);
  if (!t) return { error: `task ${args.task_id} not found` };
  if (TERMINAL_STATUSES.includes(t.status)) return { task_id: t.id, status: t.status }; // 幂等

  // 降级信号：ps 不可用 ⇒拿不到后代快照 ⇒ agent 逃出进程组的子进程可能残留（见 proc-tree.ts）。
  // 不阻断取消（组播 + runner 本体确实已杀），但必须让调用方看见，别把「可能漏杀」说成「已清理干净」。
  let warning: string | undefined;
  if (t.status === "running" && t.pid) {
    // killTree: 杀 runner 进程组（runner + 同组 agent）+ 后代进程树快照逐点杀（覆盖逃出进程组的
    // agent Bash 子进程）。快照在 kill 前完成——runner 死后逃逸进程 ppid→1 即断链，无法再追踪。
    const r = killTree(t.pid);
    if (!r.treeComplete) {
      warning = "process tree snapshot unavailable (ps not permitted); escaped agent subprocesses may survive. " +
        "The runner and its process group were signalled.";
    }
  }
  const ok = store.transition(t.id, [t.status], "cancelled", { ended_at: Math.floor(Date.now() / 1000) });
  if (!ok) {
    const cur = store.getTask(t.id)!;
    return { task_id: t.id, status: cur.status }; // 并发变化：返回实际状态
  }
  return warning ? { task_id: t.id, status: "cancelled", warning } : { task_id: t.id, status: "cancelled" };
}