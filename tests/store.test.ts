import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type NewTask } from "../src/store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "afex-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function newTask(p: Partial<NewTask> = {}): NewTask {
  return {
    id: "task_test_000001", prompt: "do it", project_path: "/tmp", executor: "claude",
    profile: "minimax-3", timeout_sec: 60, log_path: join(dir, "task_test_000001.jsonl"),
    role: "worker", created_at: 1000, ...p,
  };
}

describe("store", () => {
  it("creates and gets a task", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    const t = s.getTask("task_test_000001");
    expect(t?.status).toBe("queued");
    expect(t?.rounds).toBe(1);
    expect(t?.files_changed).toEqual([]);
  });

  it("claimToRunning: queued→running sets started_at+pid", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    expect(s.claimToRunning("task_test_000001", 4242)).toBe(true);
    const t = s.getTask("task_test_000001")!;
    expect(t.status).toBe("running");
    expect(t.started_at).toBeGreaterThan(0);
    expect(t.pid).toBe(4242);
  });

  it("transition is atomic: only from expected statuses", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    expect(s.transition("task_test_000001", ["running"], "completed", { result: "done", ended_at: 2000 })).toBe(false);
    expect(s.transition("task_test_000001", ["queued", "running"], "cancelled", { ended_at: 2000 })).toBe(true);
    expect(s.transition("task_test_000001", ["cancelled"], "completed", {})).toBe(false);
  });

  it("claimToRunning on cancelled task fails (防竞态)", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    s.transition("task_test_000001", ["queued"], "cancelled", { ended_at: 1500 });
    expect(s.claimToRunning("task_test_000001", 1)).toBe(false);
  });

  it("patch updates non-status fields; files_changed round-trips as array", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    s.patch("task_test_000001", { progress: "Editing a.ts", files_changed: ["/x/a.ts", "/x/b.ts"], session_id: "sid-1" });
    const t = s.getTask("task_test_000001")!;
    expect(t.progress).toBe("Editing a.ts");
    expect(t.files_changed).toEqual(["/x/a.ts", "/x/b.ts"]);
    expect(t.session_id).toBe("sid-1");
  });

  it("listActive returns only queued/running/needs_input", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask({ id: "task_a" }));
    s.createTask(newTask({ id: "task_b" }));
    s.createTask(newTask({ id: "task_c" }));
    s.transition("task_a", ["queued"], "completed", { ended_at: 1 });
    s.transition("task_b", ["queued"], "failed", { error: "x", ended_at: 1 });
    expect(s.listActive().map((t) => t.id).sort()).toEqual(["task_c"]);
  });
});