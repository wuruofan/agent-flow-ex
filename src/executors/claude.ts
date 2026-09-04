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
    // 2026-09-03：识别 CLI 重试/报错流中的 429 / 配额信号，让 runner 立即推告警卡而非等到 38min 后终态。
    // 触发条件：subtype 是 api_retry 或 api_error，且 error_status===429，或消息含硬配额关键词。
    // 注意：parseEvent 是纯函数，不做"已告警"去重——交给 runner 进程的局部标志处理，避免 schema 变更。
    if (o.type === "system" && (o.subtype === "api_retry" || o.subtype === "api_error")) {
      const errStatus = typeof o.error_status === "number" ? o.error_status
        : typeof o.status === "number" ? o.status
          : undefined;
      const rawMsg = typeof o.error === "string" ? o.error
        : typeof o.message === "string" ? o.message
          : typeof o.error_message === "string" ? o.error_message
            : "";
      const isHardQuota = errStatus === 429
        || /token plan|quota|用量上限|rate.?limit|exceeded/i.test(rawMsg);
      if (isHardQuota) {
        return {
          quotaWarning: {
            status: errStatus,
            message: rawMsg.slice(0, 400),
            attempt: typeof o.attempt === "number" ? o.attempt : undefined,
          },
        };
      }
    }
    return null;
  },
};