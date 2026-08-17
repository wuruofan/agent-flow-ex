import type { AgentEvent, Executor } from "./types.js";

export const claudeExecutor: Executor = {
  name: "claude",
  buildCommand(bin, extraFlags, resumeSessionId) {
    return [
      bin, "-p",
      "--output-format", "stream-json",
      "--verbose",
      ...extraFlags,
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    ];
  },
  parseEvent(line) {
    let j: unknown;
    try { j = JSON.parse(line); } catch { return null; }
    if (typeof j !== "object" || j === null) return null;
    const o = j as Record<string, unknown>;
    if (o.type === "system" && o.subtype === "init" && typeof o.session_id === "string") {
      return { sessionId: o.session_id };
    }
    if (o.type === "assistant") {
      const msg = o.message as { content?: unknown } | undefined;
      const blocks = msg?.content;
      if (!Array.isArray(blocks)) return null;
      const tool = blocks.find((b: unknown) => {
        return typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use";
      }) as { name?: string; input?: { file_path?: unknown } } | undefined;
      if (tool?.name) {
        return { toolUse: { name: tool.name, file: typeof tool.input?.file_path === "string" ? tool.input.file_path : null } };
      }
      const text = blocks
        .filter((b: unknown) => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
        .map((b: unknown) => (b as { text?: string }).text ?? "")
        .join("");
      return text ? { assistantText: text } : null;
    }
    if (o.type === "result") {
      return {
        result: {
          text: typeof o.result === "string" ? o.result : "",
          isError: Boolean(o.is_error),
          subtype: typeof o.subtype === "string" ? o.subtype : "",
        },
      };
    }
    return null;
  },
};