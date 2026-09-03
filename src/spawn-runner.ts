import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, openSync, closeSync } from "node:fs";
import { logsDir, ensureRuntimeDirs } from "./paths.js";

/** prod（编译后 dist/server.js）spawn dist/runner.js；dev/test（tsx 跑 src/*.ts）spawn src/runner.ts via --import tsx。
 *  AGENT_FLOW_RUNNER 允许覆盖 runner 脚本路径（测试指向预编译 dist/runner.js，避开 tsx 冷启动延迟）。值为脚本路径，统一用 node 拉起。 */
export function runnerCommand(): { cmd: string; args: (id: string) => string[] } {
  if (process.env.AGENT_FLOW_RUNNER) {
    const runnerBin = process.env.AGENT_FLOW_RUNNER;
    return { cmd: process.execPath, args: (id) => [runnerBin, id] };
  }
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
 *
 * runner 的 stdout/stderr 重定向到 logs/runner-<task_id>.log（追加）：此前 stdio:"ignore"
 * 把 notifier 的失败/重试痕迹（console.error）全部丢弃，通知出问题只能猜——9/3 实测通知
 * 迟到 2 分钟但盘上无任何日志可查（可观测性黑洞）。child 继承的是 dup 后的 fd，
 * spawn 返回后父侧 fd 可立即 close（实验验证：父 close 不影响子进程写入）。
 */
export function spawnDetachedRunner(
  taskId: string,
  onSpawnError?: (e: Error) => void,
): SpawnResult {
  const { cmd, args } = runnerCommand();
  ensureRuntimeDirs();
  const logFd = openSync(join(logsDir(), `runner-${taskId}.log`), "a");
  let child: ChildProcess;
  try {
    child = spawn(cmd, args(taskId), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
  } catch (e) {
    closeSync(logFd);
    throw e;
  }
  closeSync(logFd); // 子进程已 dup，父侧 fd 释放避免泄漏
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