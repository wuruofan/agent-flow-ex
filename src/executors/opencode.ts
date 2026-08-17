import type { AgentEvent, Executor } from "./types.js";

/**
 * opencode executor (https://opencode.ai/docs/cli)
 *
 * ⚠️ 此实现基于官方文档与社区 cheatsheet（golembot reference + takopi 文档）推断，未经真实事件样本验证。
 *    真实拿到 opencode 环境后，请用实际 `opencode run --format json` 输出样本校准以下字段映射。
 *
 * 与 claude 的关键差异：
 * - 命令不同：opencode 用 `opencode run`，不是 `-p`
 * - 续跑 flag：opencode 用 `--session <sid>` 续跑指定会话；`-c` 是续最近一次（runner 不用，避免歧义）
 * - 字段命名：opencode 用驼峰 `sessionID`，claude 用下划线 `session_id`
 * - 事件 schema：opencode 用 `step_start`/`text`/`tool_use`/`step-finish`/`error`；text 在顶层不带 message.content 包装
 *
 * 已知风险（opencode issue #31404）：v1.16.2 之前 `text` 事件不 stream 到 stdout（仅 `step_start`）。
 *   issue 已修复（commit 0a7cb20），但 v1.16.2 用户会拿到空 result——v1 不写 fallback，留在 plan 待观察。
 */
export const opencodeExecutor: Executor = {
  name: "opencode",
  buildCommand(bin, extraFlags, resumeSessionId) {
    return [
      bin, "run",
      ...(resumeSessionId ? ["--session", resumeSessionId] : []),
      "--format", "json",
      ...extraFlags,
      // prompt 通过 stdin 传入（runner 在 spawn 后 write+end），不在 argv 里
      "--prompt", "",
    ];
  },
  parseEvent(line) {
    let j: unknown;
    try { j = JSON.parse(line); } catch { return null; }
    if (typeof j !== "object" || j === null) return null;
    const o = j as Record<string, unknown>;
    const sessionId = typeof o.sessionID === "string" ? o.sessionID
      : typeof (o.part as Record<string, unknown> | undefined)?.sessionID === "string"
        ? (o.part as { sessionID: string }).sessionID : undefined;
    const part = o.part as Record<string, unknown> | undefined;
    const partType = typeof part?.type === "string" ? part.type : undefined;

    if (o.type === "step_start" || partType === "step-start") {
      return sessionId ? { sessionId } : null;
    }

    if (o.type === "text") {
      const text = typeof o.text === "string" ? o.text : typeof part?.text === "string" ? part.text : "";
      if (text) return { assistantText: text, sessionId };
    }

    if (o.type === "tool_use" || (partType?.startsWith("tool") ?? false)) {
      const toolName = typeof part?.tool === "string" ? part.tool : typeof o.tool === "string" ? o.tool : undefined;
      if (toolName) {
        const input = (part?.input ?? o.input) as Record<string, unknown> | undefined;
        const file = typeof input?.filePath === "string" ? input.filePath
          : typeof input?.file_path === "string" ? input.file_path
            : null;
        return { toolUse: { name: toolName, file }, sessionId };
      }
    }

    if (o.type === "step-finish" || o.type === "step_finish" || o.type === "error") {
      return { result: { text: typeof o.text === "string" ? o.text : "", isError: o.type === "error", subtype: o.type } };
    }

    return null;
  },
};