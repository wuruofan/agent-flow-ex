import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实 spawn MCP server 走 stdio JSON-RPC，断言注册出来的工具集。
//
// 为什么需要这一层：src/server.ts 曾把 agent_flow_set_started_at 注册了两次，
// MCP SDK 对同名工具抛 "Tool ... is already registered"，被 main() 捕获后
// process.exit(1) —— server 启动即死，且只在 AGENT_FLOW_TEST_MODE=1 时暴露。
// 而模块顶层就直接执行 main()，函数级单测根本 import 不到它，所以必须 spawn 真实进程来验。

const CLI = join(process.cwd(), "node_modules/.bin/tsx");

function listTools(extra: Record<string, string>): Promise<string[]> {
  const home = mkdtempSync(join(tmpdir(), "afex-srv-"));
  const child = spawn(CLI, ["src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_FLOW_HOME: home, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<string[]>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("tools/list timeout")); }, 25000);
    const done = (err: Error | null, names?: string[]) => {
      clearTimeout(timer);
      child.kill();
      rmSync(home, { recursive: true, force: true });
      err ? reject(err) : resolve(names!);
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        const m = JSON.parse(line);
        if (m.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (m.id === 2) {
          done(null, (m.result?.tools ?? []).map((t: { name: string }) => t.name));
        }
      }
    });
    child.on("exit", (code) => done(new Error(`server exited before answering tools/list (code ${code})`)));
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
    }) + "\n");
  });
}

describe("MCP server tool registration", () => {
  it("registers the 3 production tools and no test helper", async () => {
    const names = (await listTools({ AGENT_FLOW_TEST_MODE: "0" })).sort();
    expect(names).toEqual(["agent_flow_cancel", "agent_flow_status", "agent_flow_submit"]);
  }, 30000);

  it("registers set_started_at exactly once when test mode is on", async () => {
    const names = await listTools({ AGENT_FLOW_TEST_MODE: "1" });
    expect(names.filter((n) => n === "agent_flow_set_started_at")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(4);
  }, 30000);
});
