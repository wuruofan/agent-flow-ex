import { spawn, type ChildProcess } from "node:child_process";
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

export interface SpawnResult {
  child: ChildProcess;
  /** 同步异常（spawn 参数本身错误）会通过这里抛出。 */
}
/**
 * spawn detached runner（新进程组），unref 后立即返回。
 * 注：spawn 是异步的，ENOENT 这类"cmd 不存在"会在 child.on('error') 后异步触发。
 * 调用方负责捕获 onSpawnError 回调（通常把任务转 failed）。
 */
export function spawnDetachedRunner(
  taskId: string,
  onSpawnError?: (e: Error) => void,
): SpawnResult {
  const { cmd, args } = runnerCommand();
  const child = spawn(cmd, args(taskId), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  if (onSpawnError) {
    // 'error'：spawn 失败（ENOENT 等）异步触发；'exit' with code：极早期奔溃（如 tsx 找不到 .ts）
    child.on("error", onSpawnError);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) onSpawnError(new Error(`runner exited with code ${code} before claim`));
    });
  }
  return { child };
}