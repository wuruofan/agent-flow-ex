// 集成测试：端到端真实链路（submit → runner → agent → completed）。
// 不走 mock，spawn 真实进程。覆盖 happy path；cancel 级联、超时、续跑留给后续用例。
//
// 实施要点：
// - 自己的 inline fake-agent 脚本（chmod +x），写到 /tmp/afex-int-*。
//   用 /tmp 而非 os.tmpdir()（macOS 在 /var/folders 下 spawn .cjs 报 ENOEXEC）。
// - 模板字面量首字符直接是 #!：\n 会让 file/lspawn 看不到 shebang。
// - profile.env.PATH 必须注入：buildAgentEnv 显式构造 PATH 不继承 process.env，
//   而 `#!/usr/bin/env node` 需要 env 找到 node。
// - bin=可执行文件本身，args=[]。避免 fake executor 当前 buildCommand 设计里
//   bin 重复进 args 头部可能带来的 argv 拼接边界。
//   （claude/opencode executor 对真实 CLI 这是 OK 的，fake 目前没人真跑过。）
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { submit } from "../src/tools/submit.js";
import { status } from "../src/tools/status.js";
import { openStore } from "../src/store.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync("/tmp/afex-int-");
  process.env.AGENT_FLOW_HOME = home;
  mkdirSync(join(home, "logs"), { recursive: true });

  const fakeAgent = join(home, "fake-agent.cjs");
  writeFileSync(fakeAgent, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sid-int-" + process.pid });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/fake.txt" } }] } });
emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
emit({ type: "result", subtype: "success", result: "all done", is_error: false });
`);
  chmodSync(fakeAgent, 0o755);

  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: fakeAgent, extra_flags: [] } },
    profiles: { fake: { executor: "fake", env: { PATH: process.env.PATH ?? "" } } },
    notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
    defaults: { profile: "fake", timeout_sec: 30 },
  }));
});

afterEach(() => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_FLOW_HOME;
});

describe("integration: full task lifecycle", () => {
  it("submit → runner → fake-agent → completed", async () => {
    const r = await submit({ prompt: "hello", project_path: home });
    expect(r).toMatchObject({ status: "queued", rounds: 1 });
    const id = (r as { task_id: string }).task_id;

    const db = join(home, "tasks.db");
    const deadline = Date.now() + 8_000;
    let finalStatus: string | undefined;
    while (Date.now() < deadline) {
      const t = openStore(db).getTask(id);
      if (t && (t.status === "completed" || t.status === "failed" || t.status === "cancelled")) {
        finalStatus = t.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(finalStatus).toBe("completed");
    const final = status({ task_id: id }) as { status: string; result?: string };
    expect(final.status).toBe("completed");
    expect(final.result).toContain("all done");
  }, 10_000);
});
