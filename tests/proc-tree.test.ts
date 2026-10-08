// proc-tree 单元测试：真实进程树验证。
// 拓扑（模拟 P0-2 逃逸场景）：
//   R (runner 角色) ──spawn──> S (agent 角色, 同组)
//                               └─spawn(detached:true)──> G (逃逸孙进程, 脱离 R 的进程组)
// G 是 R 的血缘后代但不在 R 的进程组内 —— 旧 kill(-pgid) 打不到它，killTree 的 ppid 快照能。
// G 持续写心跳文件：killTree 后心跳停止 = 逃逸进程被清。
import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDescendants, isPsAvailable, killTree } from "../src/proc-tree.js";

// 依赖 `ps` 才能发现「逃逸孙进程」的用例：ps 不可用时（如 WorkBuddy Bash 工具的 Seatbelt 沙箱
// 拒绝执行 setuid 的 /bin/ps）显式跳过，而不是以「假红」形式报错。详见 src/proc-tree.ts 的
// isPsAvailable() 注释。跳过是诚实的：这项能力在该环境下确实无法验证。
const hasPs = isPsAvailable();
const psRequired = it.skipIf(!hasPs);

const GCODE = `
const fs = require("fs");
let i = 0;
const t = setInterval(() => { fs.appendFileSync(process.env.HB_PATH, i++ + "\\n"); }, 40);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;

const SCODE = `
const { spawn } = require("child_process");
const fs = require("fs");
const g = spawn(process.execPath, ["-e", process.env.GCODE], { detached: true, env: { ...process.env }, stdio: "ignore" });
g.unref();
fs.writeFileSync(process.env.G_PIDFILE, String(g.pid));
fs.writeFileSync(process.env.S_PIDFILE, String(process.pid));
setInterval(() => {}, 1000); // S 保持存活（模拟 agent hang）；否则 S 退出会把 detached G 收养断链
`;

const RCODE = `
const { spawn } = require("child_process");
const s = spawn(process.execPath, ["-e", process.env.SCODE], { env: { ...process.env } });
setInterval(() => {}, 1000);
`;

interface Tree {
  root: ChildProcess;
  sPidfile: string;
  gPidfile: string;
  hb: string;
}

/** R 默认与测试进程同组（模拟 runner spawn agent 同组）；detachedRoot=true 时 R 自成一进程组 leader（模拟 spawnDetachedRunner）。 */
function spawnTree(home: string, hbPath: string, detachedRoot = false): Tree {
  const sPidfile = join(home, "s.pid");
  const gPidfile = join(home, "g.pid");
  const env = { ...process.env, SCODE, GCODE, S_PIDFILE: sPidfile, G_PIDFILE: gPidfile, HB_PATH: hbPath };
  const root = spawn(process.execPath, ["-e", RCODE], { detached: detachedRoot, env });
  return { root, sPidfile, gPidfile, hb: hbPath };
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timeout waiting for ${path}`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hbLines(hb: string): number {
  if (!existsSync(hb)) return 0;
  return readFileSync(hb, "utf8").split("\n").filter(Boolean).length;
}

let trees: Tree[] = [];
let home: string;

afterEach(() => {
  for (const t of trees) { try { killTree(t.root.pid ?? 0); } catch { /* 已清 */ } }
  trees = [];
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 已删 */ } }
});

describe("collectDescendants", () => {
  psRequired("finds descendants by ppid lineage even when detached (escaped) from the group", async () => {
    home = mkdtempSync(join(tmpdir(), "afex-pt-"));
    const { root, sPidfile, gPidfile } = spawnTree(home, join(home, "hb.txt"));
    trees.push({ root, sPidfile, gPidfile, hb: join(home, "hb.txt") });
    await waitForFile(sPidfile);
    await waitForFile(gPidfile);
    const sPid = Number(readFileSync(sPidfile, "utf8"));
    const gPid = Number(readFileSync(gPidfile, "utf8"));

    const found = collectDescendants(root.pid!);
    expect(found).toContain(sPid); // 同组直子
    expect(found).toContain(gPid); // detached 逃逸孙（血缘仍在）
  }, 15_000);

  it("returns empty array for unknown pid without throwing", () => {
    expect(collectDescendants(999_999_999)).toEqual([]);
  });
});

// 2026-10-08：`collectDescendants` 原本对 ps 失败静默 catch → []，于是「逃逸进程没杀掉」与
// 「没有逃逸进程」在调用方看来完全一样，cancel 照样报 cancelled。新增契约：降级必须可观测。
describe("ps 降级可观测性", () => {
  it("isPsAvailable() 与 collectDescendants 的降级状态一致（同一结论，不会一个说可用另一个说不可用）", () => {
    // 主动跑一次快照，让内部状态确定下来
    collectDescendants(process.pid);
    const available = isPsAvailable();
    expect(typeof available).toBe("boolean");
    // ps 不可用 ⇒ 快照必然是空的（反之亦然）；两条路径不得互相矛盾。
    if (!available) expect(collectDescendants(process.pid)).toEqual([]);
  });

  it("killTree 返回 treeComplete 标记降级，且 pid<=0 时不误报", () => {
    const bad = killTree(0);
    expect(bad.signalled).toBe(0);
    expect(bad.treeComplete).toBe(false); // 未真正执行，不宣称完成
    const bad2 = killTree(-1);
    expect(bad2.signalled).toBe(0);
  });
});

describe("killTree", () => {
  psRequired("kills the whole lineage including the escaped heartbeat process (heartbeat stops)", async () => {
    home = mkdtempSync(join(tmpdir(), "afex-pt-"));
    const hbPath = join(home, "hb.txt");
    const { root, sPidfile, gPidfile, hb } = spawnTree(home, hbPath);
    trees.push({ root, sPidfile, gPidfile, hb });
    await waitForFile(sPidfile);
    await waitForFile(gPidfile);
    const sPid = Number(readFileSync(sPidfile, "utf8"));
    const gPid = Number(readFileSync(gPidfile, "utf8"));

    // 让心跳先跑一会儿，确认 G 活着且在写
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(gPid)).toBe(true);
    expect(hbLines(hb)).toBeGreaterThan(0);

    // 核心：killTree 根进程 → 逃逸的 G 也应被清
    killTree(root.pid!, { graceMs: 800 });

    // 等 SIGTERM 传播
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(sPid)).toBe(false); // 同组 agent 死
    expect(pidAlive(gPid)).toBe(false); // 逃逸孙进程死（旧实现会活着）

    // 心跳文件停止增长（逃逸清理的最终证据）
    const linesAtStop = hbLines(hb);
    await new Promise((r) => setTimeout(r, 600));
    expect(hbLines(hb)).toBe(linesAtStop);
  }, 15_000);

  it("no-ops safely on pid 0 (POSIX kill(0) would hit own group) and unknown pids", () => {
    // guard: pid<=0 直接返回，绝不 kill(0)/kill(-0)
    expect(() => killTree(0)).not.toThrow();
    expect(() => killTree(-1)).not.toThrow();
    expect(() => killTree(999_999_999)).not.toThrow();
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    dead.unref();
    expect(() => killTree(dead.pid ?? 0, { graceMs: 100 })).not.toThrow();
  });
});

describe("killTree with real runner group semantics", () => {
  psRequired("kills group leader (detached runner) plus its tree incl. escaped grandchild", async () => {
    home = mkdtempSync(join(tmpdir(), "afex-pt-"));
    const hbPath = join(home, "hb.txt");
    const { root, sPidfile, gPidfile, hb } = spawnTree(home, hbPath, true); // R detached → 组 leader
    trees.push({ root, sPidfile, gPidfile, hb });
    await waitForFile(sPidfile);
    await waitForFile(gPidfile);
    const sPid = Number(readFileSync(sPidfile, "utf8"));
    const gPid = Number(readFileSync(gPidfile, "utf8"));
    await new Promise((r) => setTimeout(r, 200));

    killTree(root.pid!, { graceMs: 800 });
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(root.pid ?? 0)).toBe(false); // 组 leader 本体死（组杀语义保持）
    expect(pidAlive(sPid)).toBe(false);
    expect(pidAlive(gPid)).toBe(false);
  }, 15_000);
});
