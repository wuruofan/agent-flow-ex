#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { submit } from "./tools/submit.js";
import { status } from "./tools/status.js";
import { cancel } from "./tools/cancel.js";
import { version } from "./tools/version.js";
import { restart } from "./tools/restart.js";
import { setStartedAt, isTestMode } from "./tools/test-helpers.js";
import { ensureRuntimeDirs } from "./paths.js";
import { loadEnvFile } from "./env-file.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

async function main(): Promise<void> {
  // 先灌 $AGENT_FLOW_HOME/.env（真实密钥所在）→ runner 子进程自动继承，任务期占位符可解析。
  loadEnvFile();
  ensureRuntimeDirs();
  const server = new McpServer({ name: "agent-flow-ex", version: "0.1.0" });

  server.tool(
    "agent_flow_submit",
    [
      "派发编码任务给外部 worker（detached runner），立即返回 task_id，不阻塞。",
      "prompt 需包含完整上下文、约束与验收标准——worker 不共享 Trae 上下文。",
      "任务已提交，卡住/完成会推飞书，无需轮询。",
      "多个任务写同一 project_path 会互相踩文件——plan 负责串行派发或确保改动文件不重叠。",
      "对 needs_input 任务答疑续跑时传 continue_of=task_id，prompt 填答案，worker 将带着原上下文继续。",
    ].join("\n"),
    {
      prompt: z.string().describe("任务工单（首轮）或对 worker 问题的答复（续跑）"),
      project_path: z.string().optional().describe("工作目录，默认 MCP server cwd"),
      profile: z.string().optional().describe("运行 profile 名，默认取 config defaults.profile"),
      continue_of: z.string().optional().describe("续跑目标任务 id（该任务须为 needs_input）"),
      timeout_sec: z.number().int().positive().optional().describe("每轮超时秒数，默认取 config"),
    },
    async (args) => json(await submit(args))
  );

  server.tool(
    "agent_flow_status",
    ["查询任务状态。无参数调用返回全部活跃任务，用于一次性概览；", "needs_input 任务会返回 question 字段。"].join("\n"),
    { task_id: z.string().optional().describe("任务 id；缺省返回全部活跃任务") },
    async (args) => json(status(args))
  );

  server.tool(
    "agent_flow_cancel",
    [
      "取消任务（状态感知、幂等）：running 杀整个进程组；已终态则原样返回当前状态。",
      "若返回带warning，说明进程树快照不可用（ps 被拒），组外逃逸的 agent 子进程可能残留。",
    ].join("\n"),
    { task_id: z.string().describe("任务 id") },
    async (args) => json(cancel(args))
  );

  server.tool(
    "agent_flow_version",
    ["返回当前 MCP server 构建元数据（version / gitSha / buildTime），用于确认重启后新代码已生效。",
      "构建信息缺失时返回 unknown。"].join("\n"),
    {},
    async () => json(version()),
  );

  server.tool(
    "agent_flow_restart",
    ["主动重启当前 MCP server 进程（process.exit，由 host 自动 respawn 并加载当前 dist）。",
      "server 无状态、in-flight worker 在独立进程组，重启安全；只重启调用方这条连接，不影响其他 live server 或在跑任务。"].join("\n"),
    {},
    async () => json(restart()),
  );

  if (isTestMode()) {
    server.tool(
      "agent_flow_set_started_at",
      ["TEST ONLY: 改写任务 started_at（unix 秒），用于 V5 孤儿收割验收快速触发 2×timeout_sec 判定。", "需在 MCP server 启动时设置环境变量 AGENT_FLOW_TEST_MODE=1。"].join("\n"),
      {
        task_id: z.string().describe("任务 id"),
        started_at: z.number().describe("新的 started_at（unix 秒）"),
      },
      async (args) => json(setStartedAt(args))
    );
  }

  await server.connect(new StdioServerTransport());
  console.error("[agent-flow-ex] mcp server ready (stdio)");

  // stdin EOF = MCP client 断开（会话结束）。SDK 的 StdioServerTransport 在 stdin end 时
  // 只 close（off 掉 data listener）不强制退出；host 复用常驻进程 + 懒加载 spawn 新会话时，
  // 旧 server 的事件循环仍非空 → 永久挂起成残留（实测观察到多个跨日残留 server 的 fd0 仍连活 pipe）。
  // 显式退出让"客户端断管道"的 server 能自愈回收。server 无状态（状态全在 tasks.db），exit 安全。
  process.stdin.on("end", () => process.exit(0));
}

const sub = process.argv[2];
if (sub === "init") {
  // 交互式 onboarding：探测 CLI、生成 config.json。动态 import 避免正常 MCP 启动拉入 readline。
  const { runInit } = await import("./init.js");
  runInit()
    .then(() => process.exit(0))
    .catch((e) => { console.error("[agent-flow-ex] init failed:", e); process.exit(1); });
} else {
  main().catch((e) => { console.error("[agent-flow-ex] fatal:", e); process.exit(1); });
}