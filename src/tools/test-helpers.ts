import { openStore } from "../store.js";
import { dbPath } from "../paths.js";

/** 仅在 AGENT_FLOW_TEST_MODE=1 时注册——用于 dispatcher 上线验收（V5 孤儿收割）模拟「超时」条件。 */
export function isTestMode(): boolean {
  return process.env.AGENT_FLOW_TEST_MODE === "1";
}

export interface SetStartedAtArgs { task_id: string; started_at: number }
export type SetStartedAtResult = { task_id: string; started_at: number } | { error: string };

/** 注入型工具：把任务的 started_at 改写为给定 unix 秒。生产环境禁用（isTestMode gate）。 */
export function setStartedAt(args: SetStartedAtArgs): SetStartedAtResult {
  if (!isTestMode()) return { error: "AGENT_FLOW_TEST_MODE not enabled" };
  if (!args.task_id) return { error: "task_id is required" };
  if (typeof args.started_at !== "number" || !Number.isFinite(args.started_at)) return { error: "started_at must be a finite number (unix seconds)" };
  const store = openStore(dbPath());
  const t = store.getTask(args.task_id);
  if (!t) return { error: `task ${args.task_id} not found` };
  store.patch(args.task_id, { started_at: Math.floor(args.started_at) });
  store.close();
  return { task_id: args.task_id, started_at: Math.floor(args.started_at) };
}
