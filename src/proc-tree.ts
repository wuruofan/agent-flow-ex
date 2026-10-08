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

/**
 * ps 快照是否可用。false ⇒ killTree 只能靠组播，逃逸子进程会漏杀。
 *
 * 为什么要显式暴露：本模块原本对 ps 失败静默 `catch → []`，于是「逃逸进程没杀掉」和
 * 「没有逃逸进程」在调用方看来一模一样——cancel 照样返回 cancelled，但 agent 的逃逸子进程
 * 实际还活着。静默降级比报错更危险：它让调用方以为清理已完成。
 *
 * 2026-10-08 实测到的 ps 失败场景（**是受限执行环境，不是本机系统缺陷**）：
 * WorkBuddy 的 Bash 工具把命令包在 `sandbox-exec -p <seatbelt profile> bash -c "…"` 里，
 * 该 profile 是 `(deny default)` + `(allow process-exec)`，但`/bin/ps` 是 setuid root 二进制，
 * Seatbelt 拒绝执行 setuid 程序 ⇒ `spawnSync ps` 直接 `EPERM`（连进程都起不来，不是枚举失败）。
 * 该沙箱只作用于 Bash 工具调用（`generateSandboxProfile` 在 CLI 里只有一个调用点，主 app.asar
 * 里 `sandbox-exec` 出现 0 次），且 app 本身没有 `com.apple.security.app-sandbox` 授权 ⇒
 * **正常部署下（MCP server 由客户端直接拉起，不经 Bash 工具）ps 是可用的**，本函数返回 true。
 * 只有在受限环境里跑测试/任务时才降级，此时调用方靠本信号把降级变成可观测。
 *
 * 调用方（cancel / runner 超时）据此决定是否要告警。
 */
let psAvailable: boolean | null = null;

/** ps 是否可用（探测一次后缓存）。用于把「降级降级」变成可观测信号。 */
export function isPsAvailable(): boolean {
  if (psAvailable === null) {
    try {
      execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      psAvailable = true;
    } catch {
      psAvailable = false;
    }
  }
  return psAvailable;
}

/** 从 rootPid 出发 BFS 收集全部后代 pid（不含 rootPid 自身）。ps 不可用时返回空数组（容错降级为纯组杀）。 */
export function collectDescendants(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  let psOut: string;
  try {
    psOut = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch {
    psAvailable = false;
    return []; // ps 不可用：无法快照，退化为只杀进程组
  }
  psAvailable = true;
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid <= 0) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }

  const descendants: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    descendants.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

export interface KillTreeOptions {
  /** SIGTERM 后等待多少毫秒补 SIGKILL；默认 3000（对齐 runner 的 KILL_GRACE_MS）。 */
  graceMs?: number;
}

export interface KillResult {
  /** 实际收到 SIGTERM 的进程数（含 rootPid、组播覆盖到的进程不计）。 */
  signalled: number;
  /** 后代快照是否拿到了。false ⇒ ps 不可用，逃逸子进程可能漏杀（详见 isPsAvailable）。 */
  treeComplete: boolean;
}

/**
 * 清理 rootPid 及其整棵后代树：
 * 1. 同步：SIGTERM 进程组（-rootPid，若 rootPid 是组 leader）+ rootPid 本体 + 每个后代；
 * 2. 异步（unref，不阻塞调用方退出）：graceMs 后对仍存活者补 SIGKILL（含组内残留）。
 * 对不存在/已死的进程全部容错（ESRCH 静默）。
 *
 * 返回值只是**可观测性信号**，不改变既有行为（历史上返回 void、调用方按无脑成功处理）。
 * `treeComplete: false` 是唯一的降级信号，调用方据此提示「可能残留进程」。
 */
export function killTree(rootPid: number, opts: KillTreeOptions = {}): KillResult {
  // guard: pid<=0 时 kill(0)/kill(-0) 在 POSIX 语义是杀调用方自己的进程组——必须拒绝。
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { signalled: 0, treeComplete: false };
  const graceMs = opts.graceMs ?? 3000;
  const descendants = collectDescendants(rootPid);
  const treeComplete = isPsAvailable();
  const targets = new Set<number>([rootPid, ...descendants]);
  let signalled = 0;

  // SIGTERM 阶段（同步）：组播 + rootPid 本体 + 逃逸后代逐个
  try { process.kill(-rootPid, "SIGTERM"); } catch { /* ESRCH：组不存在或已空 */ }
  for (const pid of targets) {
    try { process.kill(pid, "SIGTERM"); signalled++; } catch { /* 已死 */ }
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

  return { signalled, treeComplete };
}
