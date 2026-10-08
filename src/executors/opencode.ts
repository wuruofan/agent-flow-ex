import type { AgentEvent, Executor } from "./types.js";

/**
 * opencode executor (https://opencode.ai/docs/cli)
 *
 * 2026-10-08 用**真实样本**校准（opencode v1.18.33，`opencode run --format json --auto`）；
 * 样本即 tests/fixtures/opencode-events.jsonl（由真实 stdout 裁剪，字段结构原样保留）。
 *
 * 与 claude 的关键差异：
 * - 命令不同：opencode 用 `run`。**prompt 走 stdin**（run.ts：`const piped = !process.stdin.isTTY
 *   ? await Bun.stdin.text() : undefined`）——`run` **没有** `--prompt` 参数（那是 TUI 的），
 *   传了会直接打 help 并以 1 退出。
 * - 权限开关是 `--auto`（`--dangerously-skip-permissions` 在 v1.18.33 仍被解析，但未见于
 *   `run --help`，属未文档化兼容，不要依赖）。
 * - 输出**不是增量 token 流，而是「已完成 part」的快照**：`tool_use` 出现时已带
 *   `state.status="completed"` + 完整 output；`text` 是一整段（实测单 part 338 字符），
 *   无 pending/running 中间态。
 * - 一次 run 含**多个 step**（每个 LLM 回合一个）：`step_start → (tool_use|text)* → step_finish`；
 *   只有最后一个 step 的 `part.reason === "stop"`。
 * - **没有终态 result 对象**（claude 有）：最终结果 = 最后一段 text。
 * - 字段命名：`sessionID`（驼峰）出现在**每一行**顶层；工具入参在 `part.state.input.filePath`。
 * - 错误：`error.name` + `error.data.{message,statusCode,isRetryable,responseBody,metadata}`。
 *   实测样本（minimax 配额耗尽）：`{"type":"error","error":{"name":"APIError","data":{"message":
 *   "当前已达到 Token Plan 用量上限。… (2067)","statusCode":429,"isRetryable":true,…}}}` ——
 *   `statusCode` 是 **number**（不是字符串），`message` 是含平台错误码的完整长句。
 */
export const opencodeExecutor: Executor = {
  name: "opencode",
  buildCommand(bin, extraFlags, resumeSessionId) {
    return [
      bin, "run",
      ...(resumeSessionId ? ["--session", resumeSessionId] : []),
      "--format", "json",
      ...extraFlags,
      // prompt 由 runner 写入 stdin（opencode 在 stdin 非 TTY 时读取它），不进 argv。
    ];
  },
  parseEvent(line) {
    let j: unknown;
    try { j = JSON.parse(line); } catch { return null; }
    if (typeof j !== "object" || j === null) return null;
    const o = j as Record<string, unknown>;
    const part = o.part as Record<string, unknown> | undefined;
    // sessionID 在每行顶层，也常冗余出现在 part 内；两处都取，尽早让 runner 落库。
    const sessionId = typeof o.sessionID === "string" ? o.sessionID
      : typeof part?.sessionID === "string" ? (part.sessionID as string) : undefined;
    const withSession = (ev: AgentEvent): AgentEvent => (sessionId ? { ...ev, sessionId } : ev);

    if (o.type === "text") {
      // 实测是整段快照（非增量），runner 的覆盖式 `lastAssistantText = ev.assistantText` 语义正确。
      const text = typeof part?.text === "string" ? part.text : typeof o.text === "string" ? o.text : "";
      return text ? withSession({ assistantText: text }) : (sessionId ? { sessionId } : null);
    }

    if (o.type === "tool_use") {
      const toolName = typeof part?.tool === "string" ? part.tool : typeof o.tool === "string" ? o.tool : undefined;
      if (!toolName) return sessionId ? { sessionId } : null;
      // 真实入参在 part.state.input（旧实现读 part.input，导致 file 恒为 null、files_changed 永远为空）。
      const state = part?.state as Record<string, unknown> | undefined;
      const input = (state?.input ?? part?.input ?? o.input) as Record<string, unknown> | undefined;
      const file = typeof input?.filePath === "string" ? input.filePath
        : typeof input?.file_path === "string" ? input.file_path
          : null;
      return withSession({ toolUse: { name: toolName, file } });
    }

    if (o.type === "error") {
      const err = o.error as Record<string, unknown> | undefined;
      const data = err?.data as Record<string, unknown> | undefined;
      const message = typeof data?.message === "string" ? data.message
        : typeof err?.message === "string" ? err.message
          : typeof o.message === "string" ? o.message : "";
      const status = typeof data?.statusCode === "number" ? data.statusCode
        : typeof data?.status === "number" ? data.status : undefined;
      const ev = withSession({ result: { text: message, isError: true, subtype: "error" } });
      if (status === 429 || /token plan|quota|用量上限|rate.?limit|exceeded/i.test(message)) {
        ev.quotaWarning = { status, message: message.slice(0, 400) };
      }
      return ev;
    }

    // step_start / step_finish / reasoning：对 runner 无有用载荷，只回传 sessionId。
    // ⚠️ step_finish **绝不能**产出 result——真实 step_finish 没有 text 字段，一旦产出
    //    `result.text = ""`，runner 的 `resultText ?? lastAssistantText` 会被空串短路
    //    （`"" ?? x === ""`），把成功任务判成 failed。判定交给「最后一段 text + exit code」。
    return sessionId ? { sessionId } : null;
  },
};
