import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

// vitest 2.1.x 的 vite resolver 会把 "node:sqlite" 的前缀剥掉，导致 "Failed to load url sqlite"。
// 用 createRequire 绕过 vite 转译；运行时无差别。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type TaskStatus = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

/** 字段名与 DB 列一致（snake_case），避免映射层。 */
export interface Task {
  id: string;
  status: TaskStatus;
  prompt: string;
  project_path: string;
  executor: string;
  profile: string;
  timeout_sec: number;
  session_id: string | null;
  rounds: number;
  result: string | null;
  question: string | null;
  progress: string | null;
  files_changed: string[];
  pid: number | null;
  error: string | null;
  log_path: string;
  role: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  notify_failed: boolean;
}

export type NewTask = Pick<Task, "id" | "prompt" | "project_path" | "executor" | "profile" | "timeout_sec" | "log_path" | "role" | "created_at">;
export type TaskPatch = Partial<Omit<Task, "id" | "status" | "created_at">>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  prompt TEXT NOT NULL,
  project_path TEXT NOT NULL,
  executor TEXT NOT NULL,
  profile TEXT NOT NULL,
  timeout_sec INTEGER NOT NULL,
  session_id TEXT,
  rounds INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  question TEXT,
  progress TEXT,
  files_changed TEXT NOT NULL DEFAULT '[]',
  pid INTEGER,
  error TEXT,
  log_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  notify_failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`;

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
  }
  createTask(t: NewTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, prompt, project_path, executor, profile, timeout_sec, log_path, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(t.id, t.prompt, t.project_path, t.executor, t.profile, t.timeout_sec, t.log_path, t.role, t.created_at);
  }
  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }
  /** runner 启动时认领：queued|running → running（幂等刷新 pid；started_at 只记首次）。cancelled 后认领失败 → runner 直接退出。 */
  claimToRunning(id: string, pid: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `UPDATE tasks SET status='running', pid=?, started_at=COALESCE(started_at, ?) WHERE id=? AND status IN ('queued','running')`
      )
      .run(pid, now, id);
    return r.changes === 1;
  }
  /** 原子状态流转：仅当当前 status ∈ from 时更新为 to。返回是否成功。终态为吸收态，from 含终态直接拒绝。 */
  transition(id: string, from: TaskStatus[], to: TaskStatus, patch: TaskPatch = {}): boolean {
    if (from.length === 0) return false;
    if (from.some((s) => TERMINAL_STATUSES.includes(s))) return false;
    const [sql, args] = buildUpdate(patch, `status=?`, `id=? AND status IN (${from.map(() => "?").join(",")})`);
    const r = this.db.prepare(sql).run(...args, to, id, ...from);
    return r.changes === 1;
  }
  /** 非状态字段更新（progress/session_id/files_changed/result 等）。 */
  patch(id: string, patch: TaskPatch): void {
    if (Object.keys(patch).length === 0) return;
    const [sql, args] = buildUpdate(patch, "", `id=?`);
    this.db.prepare(sql).run(...args, id);
  }
  listActive(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('queued','running','needs_input') ORDER BY created_at`)
      .all() as Record<string, unknown>[];
    return rows.map(fromRow);
  }
  close(): void {
    this.db.close();
  }
}

export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}

function buildUpdate(patch: TaskPatch, setExtra: string, whereExtra: string): [string, unknown[]] {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k}=?`);
    args.push(k === "files_changed" ? JSON.stringify(v) : k === "notify_failed" ? (v ? 1 : 0) : v);
  }
  if (setExtra) sets.push(setExtra);
  const where = whereExtra ? ` WHERE ${whereExtra}` : "";
  return [`UPDATE tasks SET ${sets.join(", ")}${where}`, args];
}

function fromRow(r: Record<string, unknown>): Task {
  return {
    ...(r as unknown as Task),
    files_changed: JSON.parse((r.files_changed as string) ?? "[]") as string[],
    notify_failed: Boolean(r.notify_failed),
  };
}