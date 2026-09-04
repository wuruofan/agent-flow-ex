export interface AgentEvent {
  sessionId?: string;
  toolUse?: { name: string; file: string | null };
  assistantText?: string;
  result?: { text: string; isError: boolean; subtype: string };
  /** agent 命中可识别的硬配额/限流信号（如 429 / "Token Plan 用量上限"）；runner 据此触发飞书即时告警。 */
  quotaWarning?: { status?: number; message: string; attempt?: number };
}

export interface Executor {
  name: string;
  /** 返回完整 argv（含 bin）。prompt 一律由 runner 写入 stdin，不在 argv 中。 */
  buildCommand(bin: string, extraFlags: string[], resumeSessionId?: string): string[];
  /** 解析 CLI stdout 的一行；无法识别返回 null。 */
  parseEvent(line: string): AgentEvent | null;
}

import { claudeExecutor } from "./claude.js";
import { opencodeExecutor } from "./opencode.js";
import { fakeExecutor } from "./fake.js";

const registry: Record<string, Executor> = { claude: claudeExecutor, opencode: opencodeExecutor, fake: fakeExecutor };

export function getExecutor(name: string): Executor {
  const ex = registry[name];
  if (!ex) throw new Error(`unknown executor "${name}"`);
  return ex;
}