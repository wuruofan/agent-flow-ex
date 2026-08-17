import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function agentFlowHome(): string {
  return process.env.AGENT_FLOW_HOME ?? join(homedir(), ".agent-flow-ex");
}
export function dbPath(): string {
  return join(agentFlowHome(), "tasks.db");
}
export function logsDir(): string {
  return join(agentFlowHome(), "logs");
}
export function ensureRuntimeDirs(): void {
  mkdirSync(agentFlowHome(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}