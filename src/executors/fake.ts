import type { Executor } from "./types.js";
import { claudeExecutor } from "./claude.js";

/** 测试 executor：bin=node，extra_flags=[fake-agent.mjs 路径]，行为由 profile env FAKE_MODE 控制。事件解析复用 claude 格式。 */
export const fakeExecutor: Executor = {
  name: "fake",
  buildCommand(bin, extraFlags) {
    return [bin, ...extraFlags];
  },
  parseEvent: claudeExecutor.parseEvent,
};