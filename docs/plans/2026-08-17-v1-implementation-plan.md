# agent-flow-ex v1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 [spec v2](../specs/2026-08-16-project-spec-v2.md) 实现 v1：MCP server（submit/status/cancel）+ detached runner + SQLite 任务库 + claude executor + 飞书通知，完整支持 needs_input 答疑续跑循环。

**Architecture:** MCP server 是无状态薄层，只读写 SQLite 并 spawn detached runner；runner 独立进程执行 agent CLI、解析事件流、落库、发飞书通知。SQLite（WAL）是唯一真相源，所有状态流转用原子 UPDATE（`WHERE status IN (期望态)`）。

**Tech Stack:** TypeScript (Node ≥ 22.5)、`@modelcontextprotocol/sdk`、`node:sqlite`（已实证可用）、vitest、tsx（dev 运行）。

**已确认的决策**（与用户对齐）:
- `timeout_sec` 语义 = **每轮超时**：每个 runner 进程独立计时；needs_input 等人答复的墙钟时间不计入、不杀任务。`elapsed_sec` 仅作展示，从首次 `started_at` 起算（含等待）。
- Phase 0 Spike 已于 2026-08-17 完成，结论见下方「Spike 事实」，实现须以事实为准。
- 执行本 plan 的每个 commit 步骤前需向用户确认（用户规则：提交信息英文、提交前确认）。可按任务粒度批量确认。
- **rounds 字段语义 = 当前轮号**（1-indexed，schema `DEFAULT 1`，server 续跑前 +1 后 spawn runner）。`>= MAX_ROUNDS`（=5）作为上限，等价于「最多 5 轮，第 5 轮是最后机会」。三层来源一致（schema / spec §3+§4.1 / plan line 1390 测试断言）。runner 拿到 task.rounds 时它就是正在跑的这一轮的轮号。
- **runner `finalize` 的 transition `from` 收紧为 `["running"]`**（去除死分支 `"queued"`：claimToRunning 成功后状态必为 running，到 close handler 时不可能是 queued）。语义更精确，非功能改动。
- **opencode executor 已落地（2026-08-18）**：实现基于官方文档与社区 cheatsheet 推断，未经真实事件样本验证。runner 不感知底层 executor。新增 `tests/executors-opencode.test.ts`（10 tests）、`tests/fixtures/opencode-events.jsonl`、`config.example.json` 加 `opencode-minimax-3` profile。
 - 已知风险：opencode issue #31404 修复于 commit `0a7cb20`，v1.16.2 之前的版本 `text` 事件不 stream 到 stdout（仅 `step_start`），v1 不写 fallback，由用户版本号决定是否需要。

---

## Spike 事实（2026-08-17 实证，claude v2.1.150 + Node v24.18.0）

| # | 结论 | 影响 |
| :--- | :--- | :--- |
| S1 | `node:sqlite` DatabaseSync 在 Node v24.18.0 可用 | 直接用，不需要 better-sqlite3 |
| S2 | claude bin 在 `/Users/meow/.nvm/versions/node/v24.18.0/bin/claude`（v2.1.150） | config `executors.claude.bin` 用此绝对路径 |
| S3 | minimax-3 provider 环境跑通；完整 env 比 spec §7.3 多 4 个变量（`ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW=384000`、`API_TIMEOUT_MS=3000000`；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` **不能设**，见 S4） | config profile 采用完整 env 集 |
| S4 | 撤回（实测）：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 不影响落盘。完整 env 跑通的 case 落盘到 `~/.claude/projects/-private-tmp-cfgtest-full/<sid>.jsonl`，与去掉该 flag 的对照无差异 | config 模板按用户 shellrc 原样保留（含该变量）；runner env 构造不做任何过滤 |
| S5 | `stream-json` 事件形状（实证）：<br>• `{"type":"system","subtype":"init","session_id":...}` 携带 session_id（所有事件都带 session_id）<br>• assistant：`.message.content[]` 块数组，`{type:"text",text}` / `{type:"tool_use",name,input}`，input 含 `file_path`（Write/Edit/Read）、`command`（Bash）<br>• 终止：`{"type":"result","subtype":"success"|"error_during_execution","result":文本,"is_error":bool,"total_cost_usd":...}`<br>• 存在可忽略事件：`system/hook_started`、`system/hook_response`、`user`（tool_result） | claude executor parseEvent 按此实现；测试 fixture 用真实采集行 |
| S6 | `--resume <sid>` 续跑成功：上下文正确恢复，**session_id 保持原值**；stdin 传 prompt + `--resume` 组合可用（`echo "..." \| claude -p --resume <sid>`） | prompt 一律走 stdin（避免长 prompt 撞 argv 限制）；首轮提取 session_id 存库，续跑用 `--resume` |
| S7 | `--dangerously-skip-permissions` 无人值守 Write/Edit 成功；Bash 在 **TRAE RunCommand 沙箱内**会因 `EPERM mkdir ~/.claude/session-env/...` 失败（沙箱限制，非架构问题；用户自己终端正常） | 真实 e2e（Task 10）需用户在自己终端跑，或沙箱放行后跑 |
| S8 | `FEISHU_WEBHOOK_URL` 当前环境缺失 | config 用 `<FEISHU_WEBHOOK_URL>` 占位符，运行时从 env 解析（与 API key 同处理）；notifier 加 `dry_run` 开关（默认 true，调试期不真发）|
| S9 | `claude --help` 确认存在 `--session-id <uuid>`、`--fork-session`（v1 不用，记录备查） | — |

---

## 环境事实：TRAE 沙箱配置（2026-08-17 实地核对）

| 项 | 值 | 来源 |
| :--- | :--- | :--- |
| 沙箱配置文件 | `~/.trae-cn/permission/work/global.json` | 用户确认（UI「设置 → 权限设置 → 自定义配置」打开就是这文件） |
| 沙箱总开关 | `customProfiles.defaultCustomProfile.shellSandbox.enable = true` | 同上 |
| 文件系统默认行为 | `filesystem.default = "read_only"` | 同上 |
| 路径级授权（当前） | `resourceAuthorization.filesystem.readWrite = []`（空） | 同上 |
| 当前激活 profile | `activeProfileId = "auto_approval"` | 同上 |
| 沙箱被拒时行为 | `shellSandbox.onRestrict = "request_permission_retry_sandbox"` | 字段名推断，未确认语义 |

**实测拦截路径**：claude 子进程写 `~/.claude/session-env/<sid>` 时返回 `EPERM`，`~/.claude/projects/<sid>.jsonl` 放行（session 仍落盘），但 `~/.claude/shell-snapshots/snapshot-zsh-*.sh` 也被拦截。意味着 claude 的 Bash 工具在 TRAE 内不可用，Write/Edit/Read 工具可用。

**对 plan 的影响**：
- Task 1~9 全部在 `/Users/meow/workspace/agent-flow-ex/` 与 `~/.agent-flow-ex/` 路径下，**不触发沙箱拦截**，可正常推进
- Task 10 真实 e2e 涉及 claude Bash 工具，**必须在 TRAE 外（用户终端）执行**，或在 UI「自定义配置」面板放行 `~/.claude/session-env/` + `~/.claude/shell-snapshots/` 后再跑
- 字段语义（特别是 `onRestrict`、`approval.reviewer` 取值）**无官方文档**，依赖用户 UI 操作反推；如需精确写 plan 的沙箱段，需用户先在 UI 做一次配置变更看 diff

---

## 文件结构（全景）

```
agent-flow-ex/
├── package.json
├── tsconfig.json
├── .gitignore
├── config.example.json          # 用户 config 模板（含 minimax-3 完整 env）
├── src/
│   ├── paths.ts                 # AGENT_FLOW_HOME 解析（可注入，测试用）
│   ├── config.ts                # config 加载/校验/env 占位符解析
│   ├── store.ts                 # SQLite 封装：schema、原子状态流转
│   ├── prompt.ts                # worker 契约包装 + NEEDS_INPUT 提取
│   ├── notifier.ts              # 飞书 webhook + 退避重试
│   ├── executors/
│   │   ├── types.ts             # AgentEvent / Executor 接口 + registry
│   │   ├── claude.ts            # claude executor（基于 Spike S5/S6 事实）
│   │   └── fake.ts              # 测试用 executor（驱动 fake-agent.mjs）
│   ├── runner.ts                # detached runner 入口（状态机 + 子进程管理）
│   ├── tools/
│   │   ├── submit.ts
│   │   ├── status.ts
│   │   └── cancel.ts
│   └── server.ts                # MCP server 入口（工具注册）
└── tests/
    ├── fixtures/
    │   ├── fake-agent.mjs       # 模拟 claude 行为的脚本（4 种模式）
    │   └── claude-events.jsonl  # 真实采集的 stream-json 事件行
    ├── config.test.ts
    ├── store.test.ts
    ├── executors-claude.test.ts
    ├── prompt.test.ts
    ├── notifier.test.ts
    ├── runner.test.ts           # 进程级测试（spawn 真实 runner + fake agent）
    └── tools.test.ts
```

**运行时数据**（不入库 git）：`AGENT_FLOW_HOME`（默认 `~/.agent-flow-ex`）下 `tasks.db` + `logs/{task_id}.jsonl`。

---

### Task 1: 仓库脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: git init 与基础文件**

```bash
cd /Users/meow/workspace/agent-flow-ex && git init
```

`.gitignore`:

```
node_modules/
dist/
*.log
```

`package.json`:

```json
{
  "name": "agent-flow-ex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5" },
  "bin": { "agent-flow-ex": "dist/server.js" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "server": "tsx src/server.ts",
    "runner": "tsx src/runner.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 生成 `node_modules/` 与 `package-lock.json`，无 error。

- [ ] **Step 3: 写冒烟测试验证工具链**

`tests/smoke.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

describe("toolchain smoke", () => {
  it("runs vitest with ts + esm", () => {
    const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    expect(id).toMatch(/^task_[a-z0-9]+_[a-f0-9]{6}$/);
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 1 passed。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add package.json package-lock.json tsconfig.json .gitignore tests/smoke.test.ts
git commit -m "chore: scaffold typescript project with vitest"
```

---

### Task 2: paths + config

**Files:**
- Create: `src/paths.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/config.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFlowHome, dbPath, logsDir } from "../src/paths.js";
import { loadConfig, resolveEnvPlaceholders } from "../src/config.js";

const validConfig = {
  executors: {
    claude: { bin: "/usr/local/bin/claude", extra_flags: ["--dangerously-skip-permissions"] },
  },
  profiles: {
    "minimax-3": {
      executor: "claude",
      env: { ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic", ANTHROPIC_AUTH_TOKEN: "<MINIMAX_API_KEY>" },
    },
  },
  notify: { feishu_webhook_url: "https://open.feishu.cn/hook/x" },
  defaults: { profile: "minimax-3", timeout_sec: 3600 },
};

describe("paths", () => {
  beforeEach(() => { process.env.AGENT_FLOW_HOME = mkdtempSync(join(tmpdir(), "afex-")); });
  afterEach(() => { rmSync(process.env.AGENT_FLOW_HOME!, { recursive: true, force: true }); delete process.env.AGENT_FLOW_HOME; });

  it("resolves home from env with fallback to ~/.agent-flow-ex", () => {
    expect(agentFlowHome()).toBe(process.env.AGENT_FLOW_HOME);
    delete process.env.AGENT_FLOW_HOME;
    expect(agentFlowHome()).toBe(join(process.env.HOME!, ".agent-flow-ex"));
    process.env.AGENT_FLOW_HOME = undefined as unknown as string;
  });
  it("derives db and logs paths", () => {
    expect(dbPath()).toBe(join(agentFlowHome(), "tasks.db"));
    expect(logsDir()).toBe(join(agentFlowHome(), "logs"));
  });
});

describe("loadConfig", () => {
  it("loads and validates a valid config", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    writeFileSync(join(home, "config.json"), JSON.stringify(validConfig));
    const cfg = loadConfig(home);
    expect(cfg.profiles["minimax-3"].executor).toBe("claude");
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects profile referencing unknown executor", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.profiles["minimax-3"].executor = "nope";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/executor/);
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects missing defaults.profile target", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.defaults.profile = "ghost";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/ghost/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("resolveEnvPlaceholders", () => {
  it("resolves <VAR> placeholders from process.env", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    expect(resolveEnvPlaceholders({ A: "<MINIMAX_API_KEY>", B: "literal" })).toEqual({ A: "sk-test", B: "literal" });
    delete process.env.MINIMAX_API_KEY;
  });
  it("throws on missing placeholder env", () => {
    delete process.env.NO_SUCH_KEY_XYZ;
    expect(() => resolveEnvPlaceholders({ A: "<NO_SUCH_KEY_XYZ>" })).toThrow(/NO_SUCH_KEY_XYZ/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`src/paths.ts`:

```typescript
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
```

`src/config.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRuntimeDirs } from "./paths.js";

export interface ExecutorConfig {
  bin: string;
  extra_flags?: string[];
}
export interface ProfileConfig {
  executor: string;
  env: Record<string, string>;
}
export interface Config {
  executors: Record<string, ExecutorConfig>;
  profiles: Record<string, ProfileConfig>;
  notify: { feishu_webhook_url: string };
  defaults: { profile: string; timeout_sec: number };
}

/** 将 "<VAR_NAME>" 占位符替换为运行时环境变量；缺失则抛错（避免明文密钥落盘）。 */
export function resolveEnvPlaceholders(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^<([A-Z0-9_]+)>$/.exec(v);
    if (m) {
      const val = process.env[m[1]];
      if (!val) throw new Error(`env placeholder <${m[1]}> not found in process environment`);
      out[k] = val;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(home?: string): Config {
  const dir = home ?? join(process.env.AGENT_FLOW_HOME ?? "", "") || undefined;
  const base = dir ?? (process.env.AGENT_FLOW_HOME ? process.env.AGENT_FLOW_HOME : undefined);
  const cfgPath = join(base ?? defaultHome(), "config.json");
  ensureRuntimeDirs();
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
  validate(cfg);
  return cfg;
}
function defaultHome(): string {
  // 延迟 import 规避循环：直接复算
  const { homedir } = require("node:os") as typeof import("node:os");
  return process.env.AGENT_FLOW_HOME ?? join(homedir(), ".agent-flow-ex");
}

function validate(cfg: Config): void {
  if (!cfg.executors || Object.keys(cfg.executors).length === 0) throw new Error("config.executors is empty");
  if (!cfg.profiles || Object.keys(cfg.profiles).length === 0) throw new Error("config.profiles is empty");
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (!cfg.executors[p.executor]) throw new Error(`profile "${name}" references unknown executor "${p.executor}"`);
  }
  if (!cfg.defaults?.profile || !cfg.profiles[cfg.defaults.profile]) {
    throw new Error(`defaults.profile "${cfg.defaults?.profile}" not found in profiles`);
  }
  if (!cfg.notify?.feishu_webhook_url) throw new Error("notify.feishu_webhook_url is required");
  // dry_run 缺省 = true（只打印到 stderr 不真发），调试期默认安全；想真发改 false
  if (!Number.isInteger(cfg.defaults.timeout_sec) || cfg.defaults.timeout_sec <= 0) {
    throw new Error("defaults.timeout_sec must be a positive integer");
  }
}
```

> 注：`loadConfig` 简化为 `loadConfig(home?: string)`，`home` 缺省时用 `agentFlowHome()`；上面的 `defaultHome`/`require` 写法不要照抄——直接：

```typescript
import { agentFlowHome } from "./paths.js";
export function loadConfig(home?: string): Config {
  ensureRuntimeDirs();
  const cfgPath = join(home ?? agentFlowHome(), "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
  validate(cfg);
  return cfg;
}
```

（最终版 `src/config.ts` 只保留这一份 `loadConfig`，删除 draft 版本。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS（7 tests）。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add src/paths.ts src/config.ts tests/config.test.ts
git commit -m "feat: runtime paths and config loading with env placeholder resolution"
```

---

### Task 3: store（SQLite 任务库）

**Files:**
- Create: `src/store.ts`（内含 Task 类型与状态机常量）
- Test: `tests/store.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/store.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Task, type NewTask } from "../src/store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "afex-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function newTask(p: Partial<NewTask> = {}): NewTask {
  return {
    id: "task_test_000001", prompt: "do it", project_path: "/tmp", executor: "claude",
    profile: "minimax-3", timeout_sec: 60, log_path: join(dir, "task_test_000001.jsonl"),
    role: "worker", created_at: 1000, ...p,
  };
}

describe("store", () => {
  it("creates and gets a task", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    const t = s.getTask("task_test_000001");
    expect(t?.status).toBe("queued");
    expect(t?.rounds).toBe(1);
    expect(t?.files_changed).toEqual([]);
  });

  it("claimToRunning: queued→running sets started_at+pid; second claim on terminal fails", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    expect(s.claimToRunning("task_test_000001", 4242)).toBe(true);
    const t = s.getTask("task_test_000001")!;
    expect(t.status).toBe("running");
    expect(t.started_at).toBeGreaterThan(0);
    expect(t.pid).toBe(4242);
    s.transition(["task_test_000001"] as never, [], "completed", {} as never); // 语法占位防误用？不——见下
  });

  it("transition is atomic: only from expected statuses", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    // queued → completed 不允许（无此路径），失败
    expect(s.transition("task_test_000001", ["running"], "completed", { result: "done", ended_at: 2000 })).toBe(false);
    // queued → cancelled 允许
    expect(s.transition("task_test_000001", ["queued", "running"], "cancelled", { ended_at: 2000 })).toBe(true);
    // 终态后再流转失败（吸收态）
    expect(s.transition("task_test_000001", ["cancelled"], "completed", {})).toBe(true); // cancelled→completed 无路径，应为 false
  });

  it("claimToRunning on cancelled task fails (防竞态)", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    s.transition("task_test_000001", ["queued"], "cancelled", { ended_at: 1500 });
    expect(s.claimToRunning("task_test_000001", 1)).toBe(false);
  });

  it("patch updates non-status fields; files_changed round-trips as array", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    s.patch("task_test_000001", { progress: "Editing a.ts", files_changed: ["/x/a.ts", "/x/b.ts"], session_id: "sid-1" });
    const t = s.getTask("task_test_000001")!;
    expect(t.progress).toBe("Editing a.ts");
    expect(t.files_changed).toEqual(["/x/a.ts", "/x/b.ts"]);
    expect(t.session_id).toBe("sid-1");
  });

  it("listActive returns only queued/running/needs_input", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask({ id: "task_a" }));
    s.createTask(newTask({ id: "task_b" }));
    s.createTask(newTask({ id: "task_c" }));
    s.transition("task_a", ["queued"], "completed", { ended_at: 1 });
    s.transition("task_b", ["queued"], "failed", { error: "x", ended_at: 1 });
    expect(s.listActive().map((t) => t.id).sort()).toEqual(["task_c"]);
  });
});
```

> 上面第 2 个用例中标注「语法占位」的行是笔误演示——**实际写测试时删掉那一行**，第 3 个用例最后一行断言应为 `false`：
> `expect(s.transition("task_test_000001", ["cancelled"], "completed", {})).toBe(false);`

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`src/store.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TaskStatus = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

/** 字段名与 DB 列一致（snake_case），避免映射层。 */
export interface Task {
  id: string;
  status: TaskStatus;
  prompt: string;
  project_path: string;
  executor: string;
  profile: string;
  timeout_sec: number;
  session_id: string | null;
  rounds: number;
  result: string | null;
  question: string | null;
  progress: string | null;
  files_changed: string[];
  pid: number | null;
  error: string | null;
  log_path: string;
  role: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  notify_failed: boolean;
}

export type NewTask = Pick<Task, "id" | "prompt" | "project_path" | "executor" | "profile" | "timeout_sec" | "log_path" | "role" | "created_at">;
export type TaskPatch = Partial<Omit<Task, "id" | "status" | "created_at">>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  prompt TEXT NOT NULL,
  project_path TEXT NOT NULL,
  executor TEXT NOT NULL,
  profile TEXT NOT NULL,
  timeout_sec INTEGER NOT NULL,
  session_id TEXT,
  rounds INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  question TEXT,
  progress TEXT,
  files_changed TEXT NOT NULL DEFAULT '[]',
  pid INTEGER,
  error TEXT,
  log_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  notify_failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`;

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
  }
  createTask(t: NewTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, prompt, project_path, executor, profile, timeout_sec, log_path, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(t.id, t.prompt, t.project_path, t.executor, t.profile, t.timeout_sec, t.log_path, t.role, t.created_at);
  }
  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }
  /** runner 启动时认领：queued|running → running（幂等刷新 pid；started_at 只记首次）。cancelled 后认领失败 → runner 直接退出。 */
  claimToRunning(id: string, pid: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `UPDATE tasks SET status='running', pid=?, started_at=COALESCE(started_at, ?) WHERE id=? AND status IN ('queued','running')`
      )
      .run(pid, now, id);
    return r.changes === 1;
  }
  /** 原子状态流转：仅当当前 status ∈ from 时更新为 to。返回是否成功。终态为吸收态——from 含任何终态直接拒绝。 */
  transition(id: string, from: TaskStatus[], to: TaskStatus, patch: TaskPatch = {}): boolean {
    if (from.length === 0) return false;
    if (from.some((s) => TERMINAL_STATUSES.includes(s))) return false;
    const [sql, args] = buildUpdate(patch, `status=?`, `id=? AND status IN (${from.map(() => "?").join(",")})`);
    const r = this.db.prepare(sql).run(...args, to, id, ...from);
    return r.changes === 1;
  }
  /** 非状态字段更新（progress/session_id/files_changed/result 等）。 */
  patch(id: string, patch: TaskPatch): void {
    const [sql, args] = buildUpdate(patch, "", `id=?`);
    this.db.prepare(sql).run(...args, id);
  }
  listActive(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('queued','running','needs_input') ORDER BY created_at`)
      .all() as Record<string, unknown>[];
    return rows.map(fromRow);
  }
  close(): void {
    this.db.close();
  }
}

export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}

function buildUpdate(patch: TaskPatch, setExtra: string, whereExtra: string): [string, unknown[]] {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k}=?`);
    args.push(k === "files_changed" ? JSON.stringify(v) : k === "notify_failed" ? (v ? 1 : 0) : v);
  }
  if (setExtra) sets.push(setExtra);
  const where = whereExtra ? ` WHERE ${whereExtra}` : "";
  return [`UPDATE tasks SET ${sets.join(", ") || "status=status"}${where}`, args];
}

function fromRow(r: Record<string, unknown>): Task {
  return {
    ...(r as unknown as Task),
    files_changed: JSON.parse((r.files_changed as string) ?? "[]") as string[],
    notify_failed: Boolean(r.notify_failed),
  };
}
```

> 注：`transition` 中 `patch` 若为空对象，`sets` 为空导致 `SET ` 语法错误——`buildUpdate` 已兜底 `status=status`；但当 `sets` 只有 `status=?`（to）时永远非空，安全。`patch` 为空且无 `setExtra` 的调用（`transition` 总有 `status=?`）同样安全。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: sqlite task store with atomic state transitions"
```

---

### Task 4: Executor 抽象 + claude executor

**Files:**
- Create: `src/executors/types.ts`, `src/executors/claude.ts`, `src/executors/fake.ts`
- Create: `tests/fixtures/claude-events.jsonl`, `tests/fixtures/fake-agent.mjs`（fake-agent 在 Task 7 使用，此处先建）
- Test: `tests/executors-claude.test.ts`

- [ ] **Step 1: 建立真实事件 fixture（来自 Spike 采集）**

`tests/fixtures/claude-events.jsonl`（真实样例行，敏感无关字段已删减，解析相关字段保持原样）:

```jsonl
{"type":"system","subtype":"hook_started","session_id":"f34332fe-e7d5-4e48-ab6b-d8cfe2a2b889","hook_id":"h1","hook_name":"PreToolUse"}
{"type":"system","subtype":"init","session_id":"f34332fe-e7d5-4e48-ab6b-d8cfe2a2b889"}
{"type":"assistant","session_id":"f34332fe-e7d5-4e48-ab6b-d8cfe2a2b889","message":{"content":[{"type":"thinking","thinking":"...","signature":"x"}]}}
{"type":"assistant","session_id":"f34332fe-e7d5-4e48-ab6b-d8cfe2a2b889","message":{"content":[{"type":"text","text":"pong"}]}}
{"type":"assistant","session_id":"s2","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/private/tmp/spike-proj/hello.txt","content":"v1"}}]}}
{"type":"assistant","session_id":"s2","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/private/tmp/spike-proj/hello.txt","old_string":"v1","new_string":"v1 v2","replace_all":false}}]}}
{"type":"assistant","session_id":"s2","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cat /private/tmp/spike-proj/hello.txt","description":"verify"}}]}}
{"type":"user","session_id":"s2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"v1 v2"}]}}
{"type":"result","subtype":"success","session_id":"s2","result":"DONE","is_error":false,"total_cost_usd":0.001}
{"type":"result","subtype":"error_during_execution","session_id":"s3","result":null,"is_error":true}
not-json-line
```

- [ ] **Step 2: 写失败测试**

`tests/executors-claude.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExecutor } from "../src/executors/types.js";

const lines = readFileSync(join(import.meta.dirname, "fixtures/claude-events.jsonl"), "utf8").split("\n").filter(Boolean);

describe("claude executor", () => {
  const ex = getExecutor("claude");

  it("extracts sessionId from system/init", () => {
    const ev = ex.parseEvent(lines[1]);
    expect(ev?.sessionId).toBe("f34332fe-e7d5-4e48-ab6b-d8cfe2a2b889");
  });
  it("extracts assistant text, skips thinking blocks", () => {
    const ev = ex.parseEvent(lines[3]);
    expect(ev?.assistantText).toBe("pong");
  });
  it("extracts tool_use name + file_path", () => {
    const ev = ex.parseEvent(lines[4]);
    expect(ev?.toolUse).toEqual({ name: "Write", file: "/private/tmp/spike-proj/hello.txt" });
    const bash = ex.parseEvent(lines[6]);
    expect(bash?.toolUse).toEqual({ name: "Bash", file: null });
  });
  it("ignores tool_result user events and unknown system events and non-json", () => {
    expect(ex.parseEvent(lines[0])).toBeNull();
    expect(ex.parseEvent(lines[7])).toBeNull();
    expect(ex.parseEvent("not-json-line")).toBeNull();
  });
  it("extracts result event", () => {
    const ev = ex.parseEvent(lines[8]);
    expect(ev?.result).toEqual({ text: "DONE", isError: false, subtype: "success" });
    const err = ex.parseEvent(lines[9]);
    expect(err?.result?.isError).toBe(true);
  });
  it("builds first-run and resume commands; prompt always via stdin", () => {
    const first = ex.buildCommand("/bin/claude", ["--dangerously-skip-permissions"]);
    expect(first).toEqual(["/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
    const resume = ex.buildCommand("/bin/claude", [], "sid-9");
    expect(resume).toEqual(["/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--resume", "sid-9"]);
    expect(resume.join(" ")).not.toContain("NEEDS_INPUT");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run tests/executors-claude.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现**

`src/executors/types.ts`:

```typescript
export interface AgentEvent {
  sessionId?: string;
  toolUse?: { name: string; file: string | null };
  assistantText?: string;
  result?: { text: string; isError: boolean; subtype: string };
}

export interface Executor {
  name: string;
  /** 返回完整 argv（含 bin）。prompt 一律由 runner 写入 stdin，不在 argv 中。 */
  buildCommand(bin: string, extraFlags: string[], resumeSessionId?: string): string[];
  /** 解析 CLI stdout 的一行；无法识别返回 null。 */
  parseEvent(line: string): AgentEvent | null;
}

import { claudeExecutor } from "./claude.js";
import { fakeExecutor } from "./fake.js";

const registry: Record<string, Executor> = { claude: claudeExecutor, fake: fakeExecutor };

export function getExecutor(name: string): Executor {
  const ex = registry[name];
  if (!ex) throw new Error(`unknown executor "${name}"`);
  return ex;
}
```

`src/executors/claude.ts`（基于 Spike S5/S6 事实）:

```typescript
import type { AgentEvent, Executor } from "./types.js";

export const claudeExecutor: Executor = {
  name: "claude",
  buildCommand(bin, extraFlags, resumeSessionId) {
    return [
      bin, "-p",
      "--output-format", "stream-json",
      "--verbose",
      ...extraFlags,
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    ];
  },
  parseEvent(line) {
    let j: any;
    try { j = JSON.parse(line); } catch { return null; }
    if (j.type === "system" && j.subtype === "init") return { sessionId: j.session_id };
    if (j.type === "assistant") {
      const blocks = j.message?.content;
      if (!Array.isArray(blocks)) return null;
      const tool = blocks.find((b: any) => b.type === "tool_use");
      if (tool) return { toolUse: { name: tool.name, file: tool.input?.file_path ?? null } };
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return text ? { assistantText: text } : null;
    }
    if (j.type === "result") {
      return { result: { text: j.result ?? "", isError: Boolean(j.is_error), subtype: j.subtype ?? "" } };
    }
    return null; // user/tool_result、hook 事件等一律忽略
  },
};
```

`src/executors/fake.ts`（测试专用，驱动 `tests/fixtures/fake-agent.mjs`）:

```typescript
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
```

`tests/fixtures/fake-agent.mjs`:

```javascript
#!/usr/bin/env node
// 模拟 claude -p --output-format stream-json 的输出。FAKE_MODE: ok | needs_input | fail | hang
const mode = process.env.FAKE_MODE ?? "ok";
const sid = process.env.FAKE_SID ?? "fake-sid-0001";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (mode === "hang") {
  emit({ type: "system", subtype: "init", session_id: sid });
  setTimeout(() => {}, 60000); // 挂住等超时
} else if (mode === "fail") {
  process.stderr.write("fake agent boom\n");
  process.exit(3);
} else if (mode === "needs_input") {
  emit({ type: "system", subtype: "init", session_id: sid });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "❓NEEDS_INPUT: which database engine?" }] } });
  emit({ type: "result", subtype: "success", result: "❓NEEDS_INPUT: which database engine?", is_error: false });
} else {
  emit({ type: "system", subtype: "init", session_id: sid });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/fake.txt" } }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
  emit({ type: "result", subtype: "success", result: "all done", is_error: false });
}
// 消费 stdin（runner 会写入 prompt 后 end）
process.stdin.on("data", () => {});
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/executors-claude.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 6: Commit（先向用户确认）**

```bash
git add src/executors tests/executors-claude.test.ts tests/fixtures
git commit -m "feat: executor abstraction with claude stream-json parsing"
```

---

### Task 5: prompt 契约 + NEEDS_INPUT 提取

**Files:**
- Create: `src/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/prompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { wrapInitialPrompt, wrapContinuePrompt, extractNeedsInput, NEEDS_INPUT_MARKER } from "../src/prompt.js";

describe("prompt contract", () => {
  it("wraps initial prompt with worker contract", () => {
    const p = wrapInitialPrompt("实现登录页");
    expect(p).toContain("实现登录页");
    expect(p).toContain(NEEDS_INPUT_MARKER);
    expect(p).toContain("执行工程师");
  });
  it("wraps continue prompt with architect answer framing", () => {
    const p = wrapContinuePrompt("用 SQLite");
    expect(p).toContain("用 SQLite");
    expect(p.startsWith("架构师")).toBe(true);
  });
  it("extracts question from NEEDS_INPUT text", () => {
    const q = extractNeedsInput("❓NEEDS_INPUT: which database engine?");
    expect(q).toBe("which database engine?");
  });
  it("extracts question with 中文冒号 and surrounding whitespace", () => {
    expect(extractNeedsInput("  ❓NEEDS_INPUT：用哪个库？  ")).toBe("用哪个库？");
  });
  it("returns null for normal text", () => {
    expect(extractNeedsInput("all done")).toBeNull();
    expect(extractNeedsInput("NEEDS_INPUT without marker emoji")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/prompt.ts`:

```typescript
export const NEEDS_INPUT_MARKER = "❓NEEDS_INPUT:";

/** spec §8：runner 统一包装行为契约（claude executor 默认值，未来可按 executor 配置化）。 */
export function wrapInitialPrompt(userPrompt: string): string {
  return `你是执行工程师，任务是：${userPrompt}

行为约束：
1. 遇到无法自行决策的阻塞（需求歧义、破坏性操作、方向性选择），
   停止编码，以「${NEEDS_INPUT_MARKER}」开头输出你的问题，不要猜测执行。
2. 能自查的（读代码、跑测试）先自查，只上报真正的决策阻塞。
3. 完成后输出最终结果摘要：改动文件、关键决策、遗留问题。`;
}

/** 续跑轮：答案作为会话中的新 user 消息（--resume 恢复上下文）。 */
export function wrapContinuePrompt(answer: string): string {
  return `架构师对你上一轮问题的答复如下，请基于已有上下文继续执行任务：

${answer}`;
}

/** 从最终 assistant 文本提取问题；不守约（无标记）返回 null。 */
export function extractNeedsInput(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("❓NEEDS_INPUT")) return null;
  const rest = t.replace(/^❓NEEDS_INPUT[:：]?\s*/, "");
  return rest || null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add src/prompt.ts tests/prompt.test.ts
git commit -m "feat: worker prompt contract and needs-input extraction"
```

---

### Task 6: 飞书 notifier

**Files:**
- Create: `src/notifier.ts`
- Test: `tests/notifier.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/notifier.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { sendFeishuText } from "../src/notifier.js";

function mockFetch(sequence: Array<{ ok: boolean; status?: number }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = sequence[Math.min(i++, sequence.length - 1)];
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return {} as Response;
  });
}

describe("sendFeishuText", () => {
  it("sends text message payload once on success", async () => {
    const fetchMock = mockFetch([{ ok: true }]);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [] });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown[])[1]!.body as string);
    expect(body).toEqual({ msg_type: "text", content: { text: "hello" } });
  });
  it("retries 3 times with backoff then gives up", async () => {
    const fetchMock = mockFetch([{ ok: false, status: 500 }, { ok: false, status: 500 }, { ok: false, status: 500 }]);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [0, 0] });
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("succeeds on second attempt", async () => {
    const fetchMock = mockFetch([{ ok: false, status: 429 }, { ok: true }]);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [0] });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("dry_run skips HTTP entirely and returns true", async () => {
    const fetchMock = vi.fn();
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, dryRun: true });
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/notifier.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/notifier.ts`:

```typescript
const MAX_ATTEMPTS = 3;

export interface NotifyOptions {
  fetchImpl?: typeof fetch;
  /** 重试间隔 ms（测试注入空数组）；默认 [1000, 4000] */
  delays?: number[];
  /** dry_run=true 时只打印到 stderr，不发 HTTP，直接返回 true（"逻辑成功"）。默认 false。 */
  dryRun?: boolean;
}

/** 发送飞书自定义机器人文本消息。成功返回 true；重试耗尽返回 false（调用方置 notify_failed）。 */
export async function sendFeishuText(webhookUrl: string, text: string, opts: NotifyOptions = {}): Promise<boolean> {
  if (opts.dryRun) {
    console.error(`[notifier:dry-run] → ${webhookUrl}\n${text}\n---`);
    return true;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.delays ?? [1000, 4000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text } }),
      });
      if (res.ok) return true;
      console.error(`[notifier] HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (e) {
      console.error(`[notifier] ${e} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(delays[attempt - 1] ?? 4000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 三类事件的推送文案（spec §4.4）。 */
export function notifyText(status: "needs_input" | "completed" | "failed", taskId: string, detail: string): string {
  const head = { needs_input: "❓任务需要输入", completed: "✅任务完成", failed: "❌任务失败" }[status];
  return `${head} ${taskId}\n${detail}`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/notifier.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add src/notifier.ts tests/notifier.test.ts
git commit -m "feat: feishu webhook notifier with retry and backoff"
```

---

### Task 7: runner（核心状态机 + 子进程管理）

**Files:**
- Create: `src/runner.ts`, `src/agent-env.ts`（构造 agent 子进程环境）
- Test: `tests/runner.test.ts`（进程级：真实 spawn runner.ts + fake-agent）

**关键设计（全部来自 spec + Spike 事实）:**
1. runner 由 MCP server 以 `detached: true` spawn（新进程组，pgid = runner pid）→ cancel 用 `kill(-runnerPid, SIGTERM)`。
2. agent CLI 由 runner 以 `detached: true` spawn（**独立进程组**）→ 超时时 runner `kill(-childPid)` 自杀式终止 agent 树但 runner 自身存活，能落库 `failed(error=timeout)`。
3. runner 收到 SIGTERM（cancel 场景）→ `kill(-childPid, SIGKILL)` 清理 agent → 直接退出（server 已置 cancelled；runner 的终态落库被原子流转守卫拦下，无需处理）。
4. prompt 走 stdin（Spike S6）；每轮原始输入先追加日志 `{"type":"user_prompt","round":N,"text":...}` 再执行；续跑轮的答案由 MCP server 预先写入日志（Task 8），runner 从日志读当前轮输入。
5. env 显式构造（spec §7.1）：HOME/PATH(bin 目录+系统路径)/TMPDIR + profile env（占位符已解析）。**profile env 全量透传，不做白名单/黑名单**——`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 等用户 shellrc 自有变量按 config 配置原样交给 claude（已实测不影响 session 落盘）。
6. 超时 = 每轮（用户决策）：runner 进程存活超过 `timeout_sec` → SIGTERM，3s 后仍活 SIGKILL。
7. 轮次上限（runner 侧）：NEEDS_INPUT 且 `rounds >= 5` → `failed(error=轮次耗尽)`。

- [ ] **Step 1: 实现 `src/agent-env.ts`**

```typescript
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { resolveEnvPlaceholders } from "./config.js";

/**
 * 显式构造 agent 子进程环境（spec §7.1）：不继承任意 shell 环境。
 * 注意：不设置 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC —— 该变量会禁用 session 持久化，导致 --resume 失效（Spike S4）。
 */
export function buildAgentEnv(bin: string, profileEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    PATH: [dirname(bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    ...resolveEnvPlaceholders(profileEnv),
  };
}
```

- [ ] **Step 2: 实现 `src/runner.ts`**

```typescript
/**
 * detached runner 入口：node runner.ts <task_id>
 * 生命周期：认领任务 → 组装命令 → spawn agent(detached) → 逐行解析事件/落库/写日志 → 终态 + 通知。
 */
import { appendFileSync, createWriteStream, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { openStore, type Task } from "./store.js";
import { loadConfig } from "./config.js";
import { getExecutor } from "./executors/types.js";
import { buildAgentEnv } from "./agent-env.js";
import { wrapInitialPrompt, wrapContinuePrompt, extractNeedsInput } from "./prompt.js";
import { sendFeishuText, notifyText } from "./notifier.js";
import { dbPath } from "./paths.js";
import { createInterface } from "node:readline";

const MAX_ROUNDS = 5;
const KILL_GRACE_MS = 3000;

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) { console.error("usage: runner.ts <task_id>"); process.exit(2); }

  const store = openStore(dbPath());
  const task = store.getTask(taskId);
  if (!task) { console.error(`task ${taskId} not found`); process.exit(2); }
  if (["completed", "failed", "cancelled"].includes(task.status)) process.exit(0); // 防竞态（spec §6）

  if (!store.claimToRunning(taskId, process.pid)) {
    const cur = store.getTask(taskId);
    console.error(`claim failed, task is ${cur?.status ?? "gone"}; exiting`);
    process.exit(0); // 已被 cancel 等
  }

  const cfg = loadConfig();
  const executorCfg = cfg.executors[task.executor];
  const executor = getExecutor(task.executor);
  const profileEnv = cfg.profiles[task.profile]?.env ?? {};

  // 本轮原始输入：round1 用 task.prompt；续跑轮从日志读 server 预写的 user_prompt 行
  const rawInput = task.rounds === 1 ? task.prompt : readRoundInput(task.log_path, task.rounds);
  if (rawInput === null) {
    finalize(store, task, "failed", { error: `round ${task.rounds} input not found in log` }, cfg);
    return;
  }
  const prompt = task.rounds === 1 ? wrapInitialPrompt(rawInput) : wrapContinuePrompt(rawInput);
  appendFileSync(task.log_path, JSON.stringify({ type: "user_prompt", round: task.rounds, text: rawInput }) + "\n");
  const log = createWriteStream(task.log_path, { flags: "a" });

  const args = executor.buildCommand(executorCfg.bin, executorCfg.extra_flags ?? [], task.session_id ?? undefined);
  const child = spawn(executorCfg.bin, args, {
    cwd: task.project_path,
    env: buildAgentEnv(executorCfg.bin, profileEnv),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // 独立进程组：超时 kill(-child.pid) 不伤 runner
  });
  log.write(JSON.stringify({ type: "_runner", event: "spawn", argv: args, round: task.rounds }) + "\n");
  child.stdin!.write(prompt);
  child.stdin!.end();

  // cancel 场景：server kill(-runnerPid)。清掉 agent 后直接退出，不碰库（server 已置 cancelled）。
  process.on("SIGTERM", () => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already dead */ }
    process.exit(0);
  });

  // 每轮超时（用户决策）：SIGTERM → 3s → SIGKILL
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already dead */ } }, KILL_GRACE_MS).unref();
  }, task.timeout_sec * 1000);
  timeoutTimer.unref();

  // 事件流解析（Spike S5）
  let lastAssistantText = "";
  let resultText: string | null = null;
  let resultIsError = false;
  let stderrTail = "";
  const files = new Set<string>(task.files_changed ?? []);

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    log.write(line + "\n");
    const ev = executor.parseEvent(line);
    if (!ev) return;
    const patch: Record<string, unknown> = {};
    if (ev.sessionId && !task.session_id) { patch.session_id = ev.sessionId; task.session_id = ev.sessionId; }
    if (ev.toolUse) {
      if (ev.toolUse.file) files.add(ev.toolUse.file);
      patch.progress = `${ev.toolUse.name} ${ev.toolUse.file ?? ""}`.trim();
      patch.files_changed = [...files];
    }
    if (ev.assistantText) lastAssistantText = ev.assistantText;
    if (ev.result) { resultText = ev.result.text; resultIsError = ev.result.isError; }
    if (Object.keys(patch).length) store.patch(taskId, patch);
  });
  child.stderr!.on("data", (d: Buffer) => {
    const s = d.toString();
    stderrTail = (stderrTail + s).slice(-2048);
    log.write(JSON.stringify({ type: "stderr", text: s }) + "\n");
  });

  child.on("close", (code) => {
    clearTimeout(timeoutTimer);
    log.end();
    const finalText = (resultText ?? lastAssistantText ?? "").trim();
    const question = extractNeedsInput(finalText);
    if (timedOut) {
      finalize(store, task, "failed", { error: `timeout after ${task.timeout_sec}s (round ${task.rounds})`, result: trunc(finalText) }, cfg);
    } else if (question) {
      if (task.rounds >= MAX_ROUNDS) {
        finalize(store, task, "failed", { error: `rounds limit (${MAX_ROUNDS}) reached with pending question`, question: trunc(question) }, cfg);
      } else {
        finalize(store, task, "needs_input", { question: trunc(question), result: trunc(finalText) }, cfg);
      }
    } else if (resultIsError) {
      finalize(store, task, "failed", { error: trunc(stderrTail || finalText || "agent reported error"), result: trunc(finalText) }, cfg);
    } else if (code === 0 && finalText) {
      finalize(store, task, "completed", { result: trunc(finalText) }, cfg);
    } else {
      finalize(store, task, "failed", { error: trunc(stderrTail || `agent exited with code ${code}`) }, cfg);
    }
  });
}

function finalize(
  store: ReturnType<typeof openStore>, task: Task,
  to: "needs_input" | "completed" | "failed", patch: Record<string, unknown>,
  cfg: Awaited<ReturnType<typeof loadConfig>>
): void {
  const ok = store.transition(task.id, ["running", "queued"], to, { ...patch, ended_at: Math.floor(Date.now() / 1000) } as never);
  if (!ok) { console.error(`terminal transition to ${to} lost race; task state changed elsewhere`); return; }
  const detail = to === "needs_input" ? String(patch.question ?? "") : to === "completed" ? trunc(String(patch.result ?? "")) : String(patch.error ?? "");
  sendFeishuText(cfg.notify.feishu_webhook_url, notifyText(to, task.id, detail), { dryRun: cfg.notify.dry_run ?? true })
    .then((sent) => { if (!sent) store.patch(task.id, { notify_failed: true }); })
    .catch((e) => { console.error("[notifier] unexpected:", e); store.patch(task.id, { notify_failed: true }); });
}

function readRoundInput(logPath: string, round: number): string | null {
  let found: string | null = null;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j?.type === "user_prompt" && j.round === round && typeof j.text === "string") found = j.text;
    } catch { /* skip event lines */ }
  }
  return found;
}

function trunc(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
}

main().catch((e) => { console.error("[runner] fatal:", e); process.exit(1); });
```

> 代码要点自查（执行者实现时保持一致）：
> - `finalize` 里 `store.transition` 的 `patch` 参数类型用 `TaskPatch`（`as never` 去掉，改正确类型导入）。
> - `readRoundInput` 全量读日志：v1 任务日志量可控，不做 tail 优化（YAGNI）。

- [ ] **Step 3: 写进程级测试**

`tests/runner.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStore, type NewTask } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const runnerTs = join(root, "src", "runner.ts");
const fakeAgent = join(here, "fixtures", "fake-agent.mjs");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "afex-"));
  process.env.AGENT_FLOW_HOME = home;
  mkdirSync(join(home, "logs"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: process.execPath, extra_flags: [fakeAgent] } },
    profiles: { fake: { executor: "fake", env: {} } },
    notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
    defaults: { profile: "fake", timeout_sec: 60 },
  }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENT_FLOW_HOME; });

function runTask(extra: Partial<NewTask> & { env?: Record<string, string> } = {}) {
  const store = openStore(join(home, "tasks.db"));
  const id = `task_${Date.now().toString(36)}_t${Math.floor(Math.random() * 1e4)}`;
  store.createTask({
    id, prompt: "do the thing", project_path: home, executor: "fake", profile: "fake",
    timeout_sec: 60, log_path: join(home, "logs", `${id}.jsonl`), role: "worker",
    created_at: Math.floor(Date.now() / 1000), ...extra,
  });
  const r = spawnSync(process.execPath, ["--import", "tsx", runnerTs, id], {
    env: { ...process.env, ...(extra.env ?? {}) },
    encoding: "utf8",
    timeout: 30000,
  });
  return { id, store, r };
}

function waitTerminal(store: ReturnType<typeof openStore>, id: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const t = store.getTask(id);
      if (t && ["completed", "failed", "needs_input", "cancelled"].includes(t.status)) resolve(t.status);
      else if (Date.now() - started > timeoutMs) reject(new Error(`timeout waiting terminal state, now=${t?.status}`));
      else setTimeout(tick, 150);
    };
    tick();
  });
}

describe("runner (process-level, fake agent)", () => {
  it("completes: ok mode → completed with result, progress, files_changed, session_id", async () => {
    const { id, store } = runTask({ env: { FAKE_MODE: "ok" } });
    // spawnSync 等待 runner 主流程结束；runner 内部还有异步 notify，轮询终态
    await expect(waitTerminal(store, id)).resolves.toBe("completed");
    const t = store.getTask(id)!;
    expect(t.result).toBe("all done");
    expect(t.progress).toMatch(/^Write /);
    expect(t.files_changed).toEqual(["/tmp/fake.txt"]);
    expect(t.session_id).toBe("fake-sid-0001");
    expect(t.started_at).toBeGreaterThan(0);
    // notify_failed 置位（webhook 是 example.invalid 发不出去）——重试需 ~5s，这里只验证终态字段最终一致
  }, 30000);

  it("needs_input: question extracted, rounds=5 escalates to failed", async () => {
    const { id, store } = runTask({ env: { FAKE_MODE: "needs_input" } });
    await expect(waitTerminal(store, id)).resolves.toBe("needs_input");
    const t = store.getTask(id)!;
    expect(t.question).toBe("which database engine?");
  }, 30000);

  it("rounds>=5 with NEEDS_INPUT → failed(rounds limit)", async () => {
    const { id, store } = runTask({ env: { FAKE_MODE: "needs_input" } });
    // 直接把 rounds 改到上限再跑一个新任务更简单：这里用第二个任务验证
    const id2 = `${id}_r5`;
    store.createTask({
      id: id2, prompt: "again", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", `${id2}.jsonl`), role: "worker",
      created_at: Math.floor(Date.now() / 1000),
    });
    // 手工置 rounds=5 且 session_id 已有（模拟第 5 轮）
    const db = openStore(join(home, "tasks.db"));
    db.patch(id2, { rounds: 5, session_id: "fake-sid-0001" });
    spawnSync(process.execPath, ["--import", "tsx", runnerTs, id2], { env: { ...process.env, FAKE_MODE: "needs_input" }, encoding: "utf8", timeout: 30000 });
    await expect(waitTerminal(store, id2)).resolves.toBe("failed");
    expect(store.getTask(id2)!.error).toMatch(/rounds limit/);
  }, 60000);

  it("fail mode → failed with stderr detail", async () => {
    const { id, store } = runTask({ env: { FAKE_MODE: "fail" } });
    await expect(waitTerminal(store, id)).resolves.toBe("failed");
    expect(store.getTask(id)!.error).toMatch(/boom|exited with code 3/);
  }, 30000);

  it("hang mode → per-round timeout kills agent → failed(timeout)", async () => {
    const { id, store } = runTask({ env: { FAKE_MODE: "hang" }, timeout_sec: 2 });
    await expect(waitTerminal(store, id, 20000)).resolves.toBe("failed");
    expect(store.getTask(id)!.error).toMatch(/timeout/);
  }, 30000);

  it("continue round: reads answer from log user_prompt line and completes", async () => {
    const { id, store } = runTask({ env: { FAKE_MODE: "ok" } });
    await waitTerminal(store, id);
    // 构造第二轮：server 侧动作模拟——置 needs_input → 追加答案 → rounds+1 → spawn runner
    store.transition(id, ["completed"], "needs_input", {}); // 测试捷径：直接改状态
    appendLine(join(home, "logs", `${id}.jsonl`), { type: "user_prompt", round: 2, text: "use sqlite" });
    const t = store.getTask(id)!;
    store.transition(id, ["needs_input"], "running", { rounds: t.rounds + 1 });
    spawnSync(process.execPath, ["--import", "tsx", runnerTs, id], { env: { ...process.env, FAKE_MODE: "ok" }, encoding: "utf8", timeout: 30000 });
    const t2 = store.getTask(id)!;
    expect(t2.rounds).toBe(2);
    expect(["completed", "running"]).toContain(t2.status); // fake ok 模式会完成，但 spawnSync 返回时 notify 异步未毕——轮询更稳
    await waitTerminal(store, id);
    expect(store.getTask(id)!.status).toBe("completed");
    // 日志含两轮 user_prompt + spawn 记录
    const logText = readFileSync(join(home, "logs", `${id}.jsonl`), "utf8");
    expect(logText.match(/"type":"user_prompt"/g)?.length).toBeGreaterThanOrEqual(3); // round1+answer(round2 by server)+round2 by runner? 见下注释
  }, 30000);
});

function appendLine(p: string, o: object) {
  writeFileSync(p, JSON.stringify(o) + "\n", { flag: "a" });
}
```

> 日志断言注释：round1 的 user_prompt 由 runner 写；round2 的答案 user_prompt 由「server」（测试）写、runner 读。runner 对 round2 **不重复写** user_prompt（实现里 `rounds === 1` 才 append 原始输入——若实现按此写，断言为 2；执行者跑通后按实际行为把断言固定为精确值 `2`，删除含糊的 `>= 3`）。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/runner.test.ts`
Expected: PASS（6 tests）。若 `--import tsx` 方式异常，改用 `npx tsx` 直接调（`spawnSync("npx", ["tsx", runnerTs, id])`），二选一并保持全部用例一致。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add src/runner.ts src/agent-env.ts tests/runner.test.ts
git commit -m "feat: detached runner with per-round timeout, needs-input loop and notify"
```

---

### Task 8: MCP 工具（submit / status / cancel）

**Files:**
- Create: `src/spawn-runner.ts`（server 侧 spawn detached runner 的公共函数）、`src/tools/submit.ts`、`src/tools/status.ts`、`src/tools/cancel.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: 实现 `src/spawn-runner.ts`**

```typescript
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
    env: { ...process.env }, // runner 自身环境：需要 PATH/HOME/AGENT_FLOW_HOME；agent env 由 runner 显式构造
  });
  child.unref();
  return child;
}
```

- [ ] **Step 2: 实现 `src/tools/submit.ts`**

```typescript
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../store.js";
import { loadConfig } from "../config.js";
import { logsDir, dbPath } from "../paths.js";
import { spawnDetachedRunner } from "../spawn-runner.js";

export interface SubmitArgs {
  prompt: string;
  project_path?: string;
  profile?: string;
  continue_of?: string;
  timeout_sec?: number;
}

export function submit(args: SubmitArgs): { task_id: string; status: string; rounds: number } | { error: string } {
  if (!args.prompt?.trim()) return { error: "prompt is required" };
  const cfg = loadConfig();
  const store = openStore(dbPath());

  // ---- 续跑：needs_input 任务答疑 ----
  if (args.continue_of) {
    const t = store.getTask(args.continue_of);
    if (!t) return { error: `task ${args.continue_of} not found` };
    if (t.status !== "needs_input") return { error: `task ${args.continue_of} is "${t.status}", expected "needs_input"` };
    const rounds = t.rounds + 1;
    const ok = store.transition(args.continue_of, ["needs_input"], "running", { rounds });
    if (!ok) return { error: `task ${args.continue_of} state changed concurrently (now "${store.getTask(args.continue_of)?.status}")` };
    appendFileSync(t.log_path, JSON.stringify({ type: "user_prompt", round: rounds, text: args.prompt }) + "\n");
    const child = spawnDetachedRunner(args.continue_of);
    store.patch(args.continue_of, { pid: child.pid ?? null });
    return { task_id: args.continue_of, status: "running", rounds };
  }

  // ---- 新任务 ----
  const profileName = args.profile ?? cfg.defaults.profile;
  const profile = cfg.profiles[profileName];
  if (!profile) return { error: `unknown profile "${profileName}"` };
  if (!cfg.executors[profile.executor]) return { error: `profile "${profileName}" references unknown executor` };

  const timeout_sec = args.timeout_sec ?? cfg.defaults.timeout_sec;
  if (!Number.isInteger(timeout_sec) || timeout_sec <= 0) return { error: "timeout_sec must be a positive integer" };

  const project_path = args.project_path ?? process.cwd();
  try {
    if (!statSync(project_path).isDirectory()) return { error: `project_path "${project_path}" is not a directory` };
  } catch {
    return { error: `project_path "${project_path}" not accessible` };
  }

  const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  store.createTask({
    id, prompt: args.prompt, project_path, executor: profile.executor, profile: profileName,
    timeout_sec, log_path: join(logsDir(), `${id}.jsonl`), role: "worker",
    created_at: Math.floor(Date.now() / 1000),
  });
  const child = spawnDetachedRunner(id);
  store.patch(id, { pid: child.pid ?? null });
  return { task_id: id, status: "queued", rounds: 1 };
}
```

- [ ] **Step 3: 实现 `src/tools/status.ts`**

```typescript
import { openStore, type Task } from "../store.js";
import { dbPath } from "../paths.js";

export interface StatusArgs { task_id?: string }

/** 僵死检测（spec §5/§10）：running/queued 且 pid 不存活 → failed(interrupted)。EPERM 视为存活（进程存在但属他人）。 */
function reapZombies(tasks: Task[], store: ReturnType<typeof openStore>): void {
  for (const t of tasks) {
    if ((t.status === "running" || t.status === "queued") && t.pid) {
      let alive: boolean;
      try { process.kill(t.pid, 0); alive = true; } catch (e: any) { alive = e?.code === "EPERM"; }
      if (!alive) {
        store.transition(t.id, ["running", "queued"], "failed", { error: "interrupted (runner process gone)", ended_at: Math.floor(Date.now() / 1000) });
      }
    }
  }
}

function view(t: Task) {
  const now = Math.floor(Date.now() / 1000);
  return {
    task_id: t.id, status: t.status, rounds: t.rounds, profile: t.profile,
    elapsed_sec: t.started_at ? (t.ended_at ?? now) - t.started_at : null,
    progress: t.progress, files_changed: t.files_changed,
    ...(t.status === "needs_input" ? { question: t.question } : {}),
    ...(t.result ? { result: t.result } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.notify_failed ? { notify_failed: true } : {}),
  };
}

export function status(args: StatusArgs): unknown {
  const store = openStore(dbPath());
  if (args.task_id) {
    reapZombies([...(store.getTask(args.task_id) ? [store.getTask(args.task_id)!] : [])], store);
    const t = store.getTask(args.task_id);
    if (!t) return { error: `task ${args.task_id} not found` };
    return view(t);
  }
  const active = store.listActive();
  reapZombies(active, store);
  return store.listActive().map(view); // reap 后重读，反映 interrupted
}
```

- [ ] **Step 4: 实现 `src/tools/cancel.ts`**

```typescript
import { openStore, TERMINAL_STATUSES } from "../store.js";
import { dbPath } from "../paths.js";

export interface CancelArgs { task_id: string }

/** 状态感知、幂等取消（spec §6）。 */
export function cancel(args: CancelArgs): { task_id: string; status: string } | { error: string } {
  if (!args.task_id) return { error: "task_id is required" };
  const store = openStore(dbPath());
  const t = store.getTask(args.task_id);
  if (!t) return { error: `task ${args.task_id} not found` };
  if (TERMINAL_STATUSES.includes(t.status)) return { task_id: t.id, status: t.status }; // 幂等

  if (t.status === "running" && t.pid) {
    try { process.kill(-t.pid, "SIGTERM"); } catch { /* runner 可能刚退出，继续置状态 */ }
  }
  const ok = store.transition(t.id, [t.status], "cancelled", { ended_at: Math.floor(Date.now() / 1000) });
  if (!ok) {
    const cur = store.getTask(t.id)!;
    return { task_id: t.id, status: cur.status }; // 并发变化：返回实际状态
  }
  return { task_id: t.id, status: "cancelled" };
}
```

- [ ] **Step 5: 写测试**

`tests/tools.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.js";
import { submit } from "../src/tools/submit.js";
import { status } from "../src/tools/status.js";
import { cancel } from "../src/tools/cancel.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgent = join(here, "fixtures", "fake-agent.mjs");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "afex-"));
  process.env.AGENT_FLOW_HOME = home;
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: process.execPath, extra_flags: [fakeAgent] } },
    profiles: { fake: { executor: "fake", env: {} } },
    notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
    defaults: { profile: "fake", timeout_sec: 60 },
  }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENT_FLOW_HOME; });

describe("submit", () => {
  it("creates queued task with generated id and spawns runner (pid recorded)", () => {
    const r = submit({ prompt: "hello", project_path: home, env: { FAKE_MODE: "ok" } } as never);
    expect(r).toMatchObject({ status: "queued", rounds: 1 });
    const id = (r as { task_id: string }).task_id;
    const t = openStore(join(home, "tasks.db")).getTask(id)!;
    expect(t.pid).toBeGreaterThan(0);
    expect(t.log_path).toContain(join(home, "logs"));
  });
  it("rejects unknown profile", () => {
    expect(submit({ prompt: "x", profile: "ghost", project_path: home })).toEqual({ error: 'unknown profile "ghost"' });
  });
  it("rejects bad project_path", () => {
    expect(submit({ prompt: "x", project_path: "/no/such/dir" })).toEqual({ error: 'project_path "/no/such/dir" not accessible' });
  });
  it("continue_of rejects non-needs_input task", () => {
    const r = submit({ prompt: "x", project_path: home, env: { FAKE_MODE: "ok" } } as never);
    const id = (r as { task_id: string }).task_id;
    expect(submit({ prompt: "answer", continue_of: id })).toEqual({ error: `task ${id} is "queued", expected "needs_input"` });
  });
});

describe("status", () => {
  it("no-arg returns active list; zombie reaped to failed(interrupted)", async () => {
    const store = openStore(join(home, "tasks.db"));
    // 死 pid：spawn 一个速死进程取 pid
    const dead = spawn("true");
    const deadPid = dead.pid!;
    await new Promise((r) => dead.on("exit", r));
    store.createTask({
      id: "task_zombie", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "z.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_zombie", deadPid);
    const list = status({}) as Array<{ task_id: string; status: string; error?: string }>;
    const z = list.find((x) => x.task_id === "task_zombie");
    expect(z?.status).toBe("failed");
    expect(z?.error).toMatch(/interrupted/);
  });
  it("single task returns question when needs_input", () => {
    const store = openStore(join(home, "tasks.db"));
    store.createTask({
      id: "task_q", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "q.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_q", process.pid);
    store.transition("task_q", ["running"], "needs_input", { question: "which db?" });
    const v = status({ task_id: "task_q" }) as { question?: string };
    expect(v.question).toBe("which db?");
  });
});

describe("cancel", () => {
  it("cancels needs_input task (no live process)", () => {
    const store = openStore(join(home, "tasks.db"));
    store.createTask({
      id: "task_c1", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "c1.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_c1", process.pid);
    store.transition("task_c1", ["running"], "needs_input", { question: "q" });
    expect(cancel({ task_id: "task_c1" })).toEqual({ task_id: "task_c1", status: "cancelled" });
  });
  it("kills running process group and marks cancelled", async () => {
    const store = openStore(join(home, "tasks.db"));
    const sleeper = spawn("sleep", ["30"], { detached: true }); // 独立组，模拟 runner
    const pid = sleeper.pid!;
    store.createTask({
      id: "task_c2", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "c2.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_c2", pid);
    expect(cancel({ task_id: "task_c2" })).toEqual({ task_id: "task_c2", status: "cancelled" });
    const exited = await new Promise<boolean>((r) => sleeper.on("exit", () => r(true)));
    expect(exited).toBe(true); // SIGTERM 组杀生效
    expect(cancel({ task_id: "task_c2" })).toEqual({ task_id: "task_c2", status: "cancelled" }); // 幂等
  });
  it("returns error for unknown task", () => {
    expect(cancel({ task_id: "nope" })).toEqual({ error: "task nope not found" });
  });
});
```

> 注意：`submit` 测试里传了 `env` 字段 —— submit 本身不收 env；FAKE_MODE 需在 spawnDetachedRunner 传递的环境里。测试中 `beforeEach` 已设 `process.env.AGENT_FLOW_HOME`，FAKE_MODE 直接设到 `process.env`（`process.env.FAKE_MODE = "ok"`）即可被 runner 继承（spawn env `...process.env`）。**执行时把 `env: {...}` 参数删掉，改在用例内 `process.env.FAKE_MODE = "ok"`，并在 afterEach `delete process.env.FAKE_MODE`。**

- [ ] **Step 6: 运行**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS（9 tests）。再跑全量：`npm test`，全绿。

- [ ] **Step 7: Commit（先向用户确认）**

```bash
git add src/spawn-runner.ts src/tools tests/tools.test.ts
git commit -m "feat: mcp tool implementations submit status cancel"
```

---

### Task 9: MCP server 入口 + stdio 冒烟

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: 实现**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { submit } from "./tools/submit.js";
import { status } from "./tools/status.js";
import { cancel } from "./tools/cancel.js";
import { ensureRuntimeDirs } from "./paths.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

async function main() {
  ensureRuntimeDirs();
  const server = new McpServer({ name: "agent-flow-ex", version: "0.1.0" });

  server.tool(
    "agent_flow_submit",
    [
      "派发编码任务给外部 worker（detached runner），立即返回 task_id，不阻塞。",
      "prompt 需包含完整上下文、约束与验收标准——worker 不共享 Trae 上下文。",
      "任务已提交，卡住/完成会推飞书，无需轮询。",
      "多个任务写同一 project_path 会互相踩文件——plan 负责串行派发或确保改动文件不重叠。",
      "对 needs_input 任务答疑续跑时传 continue_of=task_id，prompt 填答案，worker 将带着原上下文继续。",
    ].join("\n"),
    {
      prompt: z.string().describe("任务工单（首轮）或对 worker 问题的答复（续跑）"),
      project_path: z.string().optional().describe("工作目录，默认 MCP server cwd"),
      profile: z.string().optional().describe("运行 profile 名，默认取 config defaults.profile"),
      continue_of: z.string().optional().describe("续跑目标任务 id（该任务须为 needs_input）"),
      timeout_sec: z.number().int().positive().optional().describe("每轮超时秒数，默认取 config"),
    },
    async (args) => json(submit(args))
  );

  server.tool(
    "agent_flow_status",
    ["查询任务状态。无参数调用返回全部活跃任务，用于一次性概览；", "needs_input 任务会返回 question 字段。"].join("\n"),
    { task_id: z.string().optional().describe("任务 id；缺省返回全部活跃任务") },
    async (args) => json(status(args))
  );

  server.tool(
    "agent_flow_cancel",
    "取消任务（状态感知、幂等）：running 杀整个进程组；已终态则原样返回当前状态。",
    { task_id: z.string().describe("任务 id") },
    async (args) => json(cancel(args))
  );

  await server.connect(new StdioServerTransport());
  console.error("[agent-flow-ex] mcp server ready (stdio)");
}

main().catch((e) => { console.error("[agent-flow-ex] fatal:", e); process.exit(1); });
```

> 说明：SDK 1.x 的 `server.tool(name, description, zodShape, handler)` 四参形式为稳定 API；若构建时报参数签名不匹配，以 `node_modules/@modelcontextprotocol/sdk` 当前版本的 README 为准调整为 `registerTool` 等价调用（语义不变）。

- [ ] **Step 2: 构建 + stdio 冒烟**

```bash
npm run typecheck && npm run build
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | AGENT_FLOW_HOME=$(mktemp -d) node dist/server.js | head -c 2000
```

Expected: 输出包含 `agent_flow_submit`、`agent_flow_status`、`agent_flow_cancel`。

再冒烟 tools/call（空 status）：

```bash
H=$(mktemp -d); mkdir -p "$H/logs"
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_flow_status","arguments":{}}}' \
  | AGENT_FLOW_HOME=$H node dist/server.js
```

Expected: 返回 `[]`（无活跃任务）。

- [ ] **Step 3: Commit（先向用户确认）**

```bash
git add src/server.ts
git commit -m "feat: mcp stdio server with three tools registered"
```

---

### Task 10: 真实环境 e2e（claude executor + 全链路）

**前置：**
- `~/.agent-flow-ex/config.json` 已就位（Task 11 的模板生成后填写；webhook URL 待用户提供）。
- **沙箱注意（实测）**：TRAE RunCommand 沙箱会拦截 claude 子进程写 `~/.claude/session-env/`（Bash 工具初始化需要），导致 Bash 工具返回 EPERM；写文件/读文件/落盘 session **不受影响**（沙箱放行 `~/.claude/projects/`）。因此：
  - **完成路径 E2E-1**（写文件 + Read）可在 TRAE 内跑
  - **needs_input E2E-2**（写 export.js + 跑 Bash 验证）需在用户终端跑，或在 Trae 设置中放行 `~/.claude/session-env/` 后跑
  - 涉及真实 API 调用（消耗 MiniMax 额度）与真实飞书推送，执行前向用户确认。

- [ ] **Step 1: 准备 config**

按 `config.example.json`（Task 11）写 `~/.agent-flow-ex/config.json`，`ANTHROPIC_AUTH_TOKEN` 用 `<MINIMAX_API_KEY>` 占位，并在启动 server 的环境里 export `MINIMAX_API_KEY`。

- [ ] **Step 2: E2E-1 完成路径**

用 `src/tools` 直接驱动（不经 stdio，便于观察）：

```bash
cd /Users/meow/workspace/agent-flow-ex
cat > /tmp/e2e1.mjs <<'EOF'
process.env.MINIMAX_API_KEY ??= process.env.MINIMAX_API_KEY;
const { submit } = await import("./dist/tools/submit.js");
const { status } = await import("./dist/tools/status.js");
const r = submit({ prompt: "在当前目录创建 e2e.txt，内容为 'agent-flow-ex e2e ok'，然后回复 DONE", project_path: "/tmp/afex-e2e" });
console.log("submit:", r);
const id = r.task_id;
for (let i = 0; i < 120; i++) {
  await new Promise((r2) => setTimeout(r2, 3000));
  const s = status({ task_id: id });
  console.log(new Date().toISOString(), s);
  if (["completed", "failed", "needs_input", "cancelled"].includes(s.status ?? "")) break;
}
EOF
mkdir -p /tmp/afex-e2e && npx tsx /tmp/e2e1.mjs
```

Expected: 终态 `completed`，`result` 含 DONE；`/tmp/afex-e2e/e2e.txt` 存在；`files_changed` 含该文件；session_id 非空；飞书群收到完成推送（webhook 就位时）。

- [ ] **Step 3: E2E-2 needs_input 循环**

```bash
cat > /tmp/e2e2.mjs <<'EOF'
const { submit } = await import("./dist/tools/submit.js");
const { status } = await import("./dist/tools/status.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitTerminal = async (id) => {
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const s = status({ task_id: id });
    if (["completed", "failed", "needs_input"].includes(s.status ?? "")) return s;
  }
  throw new Error("timeout");
};
// prompt 设计成大概率触发提问：故意留决策空白
let r = submit({ prompt: "实现一个数据导出功能。要求：先问我用什么格式（json 或 csv），不要自行决定。得到答复后再实现 export.js 并回复完成。", project_path: "/tmp/afex-e2e2" });
let s = await waitTerminal(r.task_id);
console.log("round1:", s.status, s.question ?? "");
if (s.status !== "needs_input") throw new Error("expected needs_input, got " + s.status);
const r2 = submit({ prompt: "用 json 格式。", continue_of: r.task_id });
console.log("continue:", r2);
const s2 = await waitTerminal(r2.task_id);
console.log("round2:", s2.status, s2.result ?? s2.error ?? "");
EOF
mkdir -p /tmp/afex-e2e2 && npx tsx /tmp/e2e2.mjs
```

Expected: round1 `needs_input` + question；round2 `completed`，export.js 存在且为 json 导出；两轮 `task_id` 相同、`rounds=2`；session_id 保持一致（--resume 生效）。

- [ ] **Step 4: E2E-3 cancel**

```bash
cat > /tmp/e2e3.mjs <<'EOF'
const { submit } = await import("./dist/tools/submit.js");
const { status } = await import("./dist/tools/status.js");
const { cancel } = await import("./dist/tools/cancel.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = submit({ prompt: "写一个 2000 行的 README，慢慢写，写完回复 DONE", project_path: "/tmp/afex-e2e3", timeout_sec: 600 });
await sleep(20000);
console.log("before cancel:", status({ task_id: r.task_id }));
console.log("cancel:", cancel({ task_id: r.task_id }));
await sleep(2000);
console.log("after:", status({ task_id: r.task_id }));
EOF
mkdir -p /tmp/afex-e2e3 && npx tsx /tmp/e2e3.mjs && pgrep -fl "runner.js|claude" | grep -v pgrep || echo "no leftover processes"
```

Expected: cancel 返回 cancelled；after 显示 cancelled（非 interrupted/failed）；无残留 claude/runner 进程。

- [ ] **Step 5: E2E-4 崩溃恢复**

kill 掉 MCP server（若经 stdio 接入则重启 Trae 会话），任务照跑；`agent_flow_status` 历史任务可查、running 任务正常完成（观察 E2E-2 期间重启 server 进程验证）。Expected: 任务不受影响。

- [ ] **Step 6: 验收清单核对（spec §13）**

逐条核对并在最终汇报中给出结果；不通过项修复后重跑。

- [ ] **Step 7: Commit（如有修复，先向用户确认）**

```bash
git add -A && git commit -m "fix: address issues found in real e2e"
```

（无修复则跳过。）

---

### Task 11: config 模板 + Trae 接入

**Files:**
- Create: `config.example.json`

- [ ] **Step 1: 写模板（基于 Spike S2/S3 事实）**

```jsonc
{
  "executors": {
    "claude": {
      "bin": "/Users/meow/.nvm/versions/node/v24.18.0/bin/claude",
      "extra_flags": ["--dangerously-skip-permissions"]
    }
  },
  "profiles": {
    "minimax-3": {
      "executor": "claude",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "<MINIMAX_API_KEY>",
        "ANTHROPIC_MODEL": "MiniMax-M3[1m]",
        "ANTHROPIC_SMALL_FAST_MODEL": "MiniMax-M3[1m]",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M3[1m]",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M3[1m]",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M3[1m]",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "384000",
        "API_TIMEOUT_MS": "3000000"
      }
    }
  },
  "notify": {
    "feishu_webhook_url": "<FEISHU_WEBHOOK_URL>",
    "dry_run": true
  },
  "defaults": {
    "profile": "minimax-3",
    "timeout_sec": 3600
  }
}
```

> 说明：
> - `notify.dry_run=true`（默认）：仅打印到 stderr，不真发飞书。调试期默认安全。
> - 想真发飞书：把 `dry_run` 改为 `false`，并确保 Trae MCP env 里有 `FEISHU_WEBHOOK_URL`。
> - bin 路径含 node 版本号，升级 node 后需同步更新（spec §7.3 注）。

- [ ] **Step 2: Trae MCP 配置（给用户的接入参数，不入库）**

```json
{
  "mcpServers": {
    "agent-flow-ex": {
      "command": "node",
      "args": ["/Users/meow/workspace/agent-flow-ex/dist/server.js"],
      "env": {
        "MINIMAX_API_KEY": "<你的 key>",
        "FEISHU_WEBHOOK_URL": "<webhook url>"
      }
    }
  }
}
```

> 提示：刚启动阶段建议先保持 `~/.agent-flow-ex/config.json` 里 `notify.dry_run=true`，Trae MCP 配置里**也填** `FEISHU_WEBHOOK_URL`（避免日后忘了）。需要真发飞书通知时改 `dry_run=false`。

（或 dev 模式 `npx tsx src/server.ts`。密钥走 Trae MCP env → config 占位符解析，不落盘。）

- [ ] **Step 3: 在 Trae 中实测自然语言触发**

对话说「用 agent-flow 派个任务：在 /tmp/afex-e2e 创建 today.txt 写入今天日期，完成通知我」→ 期望模型调 `agent_flow_submit` 即时返回 task_id；完成后飞书收到推送。

- [ ] **Step 4: Commit（先向用户确认）**

```bash
git add config.example.json
git commit -m "chore: add config example with verified minimax-3 env"
```

---

## 自查记录（Self-Review）

- **Spec 覆盖**：§2 架构（server/runner/DB/飞书）→ Task 7/8/9；§3 schema → Task 3；§4.1 提交（<200ms、continue_of 同 id）→ Task 8；§4.2 即查即返 + 无参概览 → Task 8 status；§4.3 needs_input 循环 → Task 5/7/8 + E2E-2；§4.4 三类通知 + 重试 + notify_failed → Task 6/7；§5 状态机含轮次上限/超时/僵死 → Task 3/7/8；§6 工具契约与文案 → Task 8/9；§7 executor/profile/env 显式构造 → Task 2/4 + agent-env；§8 契约包装 → Task 5；§9 选型 → Task 1；§10 非功能（原子流转/WAL/摘要截断）→ Task 3/7；§12 spike → 已完成（本文档「Spike 事实」）；§13 验收 → Task 10；§15.4 role 字段 → Task 3。opencode executor 为 Phase 2（spec §7.5），不在本计划。
- **类型一致性**：`Task`/`TaskStatus`/`TaskPatch`（Task 3）在 runner/tools 中复用；`AgentEvent`/`Executor`/`getExecutor`（Task 4）被 runner 使用；`wrapInitialPrompt/wrapContinuePrompt/extractNeedsInput/NEEDS_INPUT_MARKER`（Task 5）签名与 runner 调用一致；`sendFeishuText/notifyText`（Task 6）与 runner finalize 一致。
- **占位符扫描**：plan 中两处测试代码内的「笔误演示」注释块（Task 3 Step 1、Task 8 Step 5）是给执行者的显式修正指令，非未完成项；其余无 TBD/TODO。

## 遗留开放项（不阻塞实现）

1. `FEISHU_WEBHOOK_URL` 待用户提供 → Task 10 真实推送验证与 config 填写。
2. 真实 e2e（Task 10）需在用户终端跑或放行沙箱（Spike S7）。
3. opencode executor（spec §7.5 Phase 2）另立计划。
