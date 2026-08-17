import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { submit } from "./tools/submit.js";
import { status } from "./tools/status.js";
import { cancel } from "./tools/cancel.js";
import { ensureRuntimeDirs } from "./paths.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

async function main(): Promise<void> {
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
    async (args) => json(submit(args))
  );

  server.tool(
    "agent_flow_status",
    ["查询任务状态。无参数调用返回全部活跃任务，用于一次性概览；", "needs_input 任务会返回 question 字段。"].join("\n"),
    { task_id: z.string().optional().describe("任务 id；缺省返回全部活跃任务") },
    async (args) => json(status(args))
  );

  server.tool(
    "agent_flow_cancel",
    "取消任务（状态感知、幂等）：running 杀整个进程组；已终态则原样返回当前状态。",
    { task_id: z.string().describe("任务 id") },
    async (args) => json(cancel(args))
  );

  await server.connect(new StdioServerTransport());
  console.error("[agent-flow-ex] mcp server ready (stdio)");
}

main().catch((e) => { console.error("[agent-flow-ex] fatal:", e); process.exit(1); });