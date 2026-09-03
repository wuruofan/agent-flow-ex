/**
 * 进程树清理工具：从 rootPid 出发快照后代进程树，组杀 + 逐点 SIGTERM/SIGKILL 级联清理。
 *
 * 背景：runner（detached，进程组 leader）spawn agent 时不设 detached，使 agent 继承 runner
 * 的进程组（见 runner.ts），cancel 原实现 kill(-runnerPid) 组播即可覆盖 runner + agent。
 * 但 agent 的 Bash 工具派生的长命令可能逃出该组（agent CLI 内部对工具子进程做 setsid/detached），
 * 组播信号打不到它们；runner 一死，逃逸进程被 init 收养（ppid→1），血缘断链更无法追踪。
 *
 * 修复策略：不依赖"agent 是否把子进程放进我的组"的假设，改为从 ppid 血缘硬扫——
 * 组杀（覆盖同组）+ 后代树快照逐点杀（覆盖逃逸者）。
 *
 * 关键时序：进程树快照必须在 kill 之前完成——父进程死亡后，逃逸子进程 ppid 会被改写为 1，
 * 届时从 rootPid 出发的 BFS 将找不到它。
 */

import { execFileSync } from "node:child_process";

/** 从 rootPid 出发 BFS 收集全部后代 pid（不含 rootPid 自身）。ps 不可用时返回空数组（容错降级为纯组杀）。 */
export function collectDescendants(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (pid <= 0) continue;
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
  } catch {
    return []; // ps 不可用：无法快照，退化为只杀进程组
  }

  const out: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

export interface KillTreeOptions {
  /** SIGTERM 后等待多少毫秒补 SIGKILL；默认 3000（对齐 runner 的 KILL_GRACE_MS）。 */
  graceMs?: number;
}

/**
 * 清理 rootPid 及其整棵后代树：
 * 1. 同步：SIGTERM 进程组（-rootPid，若 rootPid 是组 leader）+ rootPid 本体 + 每个后代；
 * 2. 异步（unref，不阻塞调用方退出）：graceMs 后对仍存活者补 SIGKILL（含组内残留）。
 * 对不存在/已死的进程全部容错（ESRCH 静默）。
 */
export function killTree(rootPid: number, opts: KillTreeOptions = {}): void {
  // guard: pid<=0 时 kill(0)/kill(-0) 在 POSIX 语义是杀调用方自己的进程组——必须拒绝。
  if (!Number.isInteger(rootPid) || rootPid <= 0) return;
  const graceMs = opts.graceMs ?? 3000;
  const descendants = collectDescendants(rootPid);
  const targets = new Set<number>([rootPid, ...descendants]);

  // SIGTERM 阶段（同步）：组播 + rootPid 本体 + 逃逸后代逐个
  try { process.kill(-rootPid, "SIGTERM"); } catch { /* ESRCH：组不存在或已空 */ }
  for (const pid of targets) {
    try { process.kill(pid, "SIGTERM"); } catch { /* 已死 */ }
  }

  // SIGKILL 兜底阶段（异步 unref）：SIGTERM 未驯服的顽固进程
  const timer = setTimeout(() => {
    try { process.kill(-rootPid, "SIGKILL"); } catch { /* 组已空 */ }
    for (const pid of targets) {
      try { process.kill(pid, 0); } catch { continue; } // ESRCH → 已死
      try { process.kill(pid, "SIGKILL"); } catch { /* 竞态死亡 */ }
    }
  }, graceMs);
  timer.unref();
}
