import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

/** prod（编译后 dist/server.js）spawn dist/runner.js；dev/test（tsx 跑 src/*.ts）spawn src/runner.ts via --import tsx。 */
export function runnerCommand(): { cmd: string; args: (id: string) => string[] } {
  if (process.env.AGENT_FLOW_RUNNER) return { cmd: process.env.AGENT_FLOW_RUNNER, args: (id) => [id] };
  const selfUrl = import.meta.url;
  const ext = selfUrl.endsWith(".ts") ? "ts" : "js";
  const runnerPath = join(fileURLToPath(new URL(".", selfUrl)), `runner.${ext}`);
  if (ext === "ts") {
    if (!existsSync(join(fileURLToPath(new URL(".", selfUrl)), "../node_modules/tsx/package.json"))) {
      throw new Error("dev mode requires tsx installed");
    }
    return { cmd: process.execPath, args: (id) => ["--import", "tsx", runnerPath, id] };
  }
  return { cmd: process.execPath, args: (id) => [runnerPath, id] };
}

/** spawn detached runner（新进程组），unref 后立即返回 child（供记 pid）。 */
export function spawnDetachedRunner(taskId: string) {
  const { cmd, args } = runnerCommand();
  const child = spawn(cmd, args(taskId), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  return child;
}