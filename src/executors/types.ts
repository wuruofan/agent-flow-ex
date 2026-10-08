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
  /**
   * 返回**完整 argv（含 bin 作为第 0 位）**。prompt 一律由 runner 写入 stdin，不在 argv 中。
   *
   * ⚠️ 这是给 runner / 测试 / 日志看的「完整命令」，**不要**原样传给 `spawn(bin, argv)`：
   *    Node 的 spawn 会**自己补**一个 argv[0]（= bin）并把传入数组原样接在后面，child 实际收到
   *    `[0]=bin [1]=bin [2]=子命令…` —— bin 被夹带成子命令的第一个**位置参数**，被 CLI 当 prompt 吞掉。
   *    runner 会先 `slice(1)` 再 spawn。2026-10-08 opencode e2e 实测踩过这个坑。
   */
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