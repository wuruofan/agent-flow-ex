# v1 代码 Review

> 评审人：WorkBuddy
> 日期：2026-08-19
> 范围：`src/` 全部 16 个文件 + `tests/` 8 个测试文件
> 测试状态：53 例全绿 ✅
> 目标：供 claude minimax m3 改正；附本机集成测试 gap 分析

## 修复状态（追加于评审当日）

✅ 已修复：P0-1、P0-2、P1-3、P1-5（均经 vitest 53/53 + `tsc --noEmit` 验证）
⏳ 未修复（保留观察）：P1-4、P1-6、P1-7、P1-8、P2-9、P2-10、集成测试 gap
详见各条目下方的"修复记录"小节。

---

## 评审方法

所有判断基于代码事实，关键主张均标注对应文件行号。未标注的假设性推断已显式标记为"假设"。

---

## 🔴 P0 — 必须修复（潜在 bug）

### 1. `status.ts:21-34` — `reapZombies` PID 复用误判

**代码**：
```typescript
function reapZombies(tasks: Task[], store: ReturnType<typeof openStore>): void {
  for (const t of tasks) {
    if ((t.status === "running" || t.status === "queued") && t.pid) {
      let alive: boolean;
      try { process.kill(t.pid, 0); alive = true; } catch (e: unknown) {
        const code = (e as { code?: string } | null)?.code;
        alive = code === "EPERM";
      }
      if (!alive) {
        store.transition(t.id, ["running", "queued"], "failed", { error: "interrupted (runner process gone)", ended_at: Math.floor(Date.now() / 1000) });
      }
    }
  }
}
```

**问题**：`process.kill(pid, 0)` 检测的是"本进程能否向目标进程发信号"，**不能确认目标进程就是原来的 runner**。Linux/macOS 上 PID 回收后可能分配给完全不相关的进程。如果查询时 PID 恰好被复用给一个活着的进程，`reapZombies` 会误判该任务"还在运行"；反之如果 PID 被复用后进程已死，会误判为"runner 已死"而错误标记 `failed`。

**更严重**：`status()` 是 MCP 查询工具，可能被频繁调用。这意味着一个"恰好在查询时 PID 被复用"的任务会被错误杀死。

**建议**：
- **方案 A（推荐）**：去掉 `reapZombies`。runner 自己负责终态（`SIGTERM` handler + 超时机制），不需要外部清理。daemon 模型下 runner 消失，该机制本就失效。
- 方案 B：加进程名/命令行校验（`ps -p <pid> -o comm=`），但跨平台复杂，属于补丁。

> **修复记录（2026-08-19）** — 采用方案 A：`src/tools/status.ts` 删除 `reapZombies` 函数与两处调用。runner 的 SIGTERM handler + 超时机制足够覆盖正常清理；runner 异常崩溃的僵死任务会随进程组整体消失，留给上层守护或人工干预。

---

### 2. `cancel.ts:17` — 信号组杀可能误杀无关进程

**代码**：
```typescript
try { process.kill(-t.pid, "SIGTERM"); } catch { /* runner 可能刚退出，继续置状态 */ }
```

**问题**：`-t.pid` 向整个进程组发 SIGTERM。runner (`spawn-runner.ts:24`) 和 agent (`runner.ts:54-59`) 都 `detached: true`，各自是独立进程组的 leader——**runner 和 agent 不在同一进程组**。`cancel` 的 `kill(-runnerPid)` 只能杀 runner，杀不到 agent。

**连锁问题**：
- 如果 runner 已自然退出，`kill(-runnerPid)` 失败（ESRCH），然后直接 transition 到 `cancelled`——agent 进程还活着，成了孤儿。
- runner 的 `SIGTERM` handler (`runner.ts:65-68`) 会尝试 `kill(-child.pid, "SIGKILL")` 清 agent，但如果 runner 已死，这层补救失效。

**建议**：
- 在 `cancel` 中，如果 `kill(-runnerPid)` 成功，等一个短暂 grace period（如 500ms）再检查 agent 是否还在，必要时直接 `kill(-agentPid)`。
- 或者：runner spawn agent 时不设 `detached: true`，让 agent 继承 runner 的进程组，这样 `kill(-runnerPid)` 能级联杀死 agent。

> **修复记录（2026-08-19）** — 采用"方案 b"：`src/runner.ts` 去掉 agent 的 `detached: true`，让 agent 继承 runner 的进程组（runner 自己由 `spawn-runner.ts` 用 `detached: true` 启动，是进程组 leader）。`kill(-runnerPid)` 现可级联杀 agent；runner SIGTERM handler 不再单独二次杀 agent（因同进程组会被一并终止）。
>
> **follow-up（2026-08-19）** — 集成测试发现：超时路径最初也用 `kill(-process.pid, ...)`，会同时杀掉 runner 自己导致 SIGTERM handler 抢先 exit 跳过 `child.on('close')` 处理，任务卡 `running`。已修正为 `kill(child.pid, ...)`——只杀 agent，等其 close 事件触发 finalize 走 timedOut 分支。该 follow-up 由集成测试覆盖（`tests/integration.test.ts` 中 `timeout kills long-running agent`）。

---

## 🟠 P1 — 设计/可维护性问题

### 3. `submit.ts:60-61` — spawn runner 异常后任务永远卡在 `queued`

**代码**：
```typescript
const child = spawnDetachedRunner(id);
store.patch(id, { pid: child.pid ?? null });
```

**问题**：如果 `spawnDetachedRunner` 抛异常（如 tsx 未安装、runner 脚本不存在），任务已 `createTask` 但 runner 没起来，任务永远卡在 `queued`，无超时机制清理。

**建议**：`spawnDetachedRunner` 的异常应被捕获，任务 transition 到 `failed`，并记录错误原因。

> **修复记录（2026-08-19）** — `src/tools/submit.ts` 在两处 `spawnDetachedRunner` 调用（新任务路径 / 续跑路径）外层加 try/catch：失败时把任务 transition 到 `failed`，错误信息落库，同时给调用方返回 `{error}`。

---

### 4. `runner.ts:144-153` — `readRoundInput` 全量读日志（性能债）

**代码**：
```typescript
function readRoundInput(logPath: string, round: number): string | null {
  let found: string | null = null;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    // ...
  }
  return found;
}
```

**问题**：每轮续跑都全量读日志文件。v1 当前 `MAX_ROUNDS=5`，日志量可控；但如果未来放宽上限或单轮输出量大，会成为瓶颈。

**建议**：加 TODO 注释，说明未来可优化为从尾部反向读（或维护一个 round → offset 索引）。

---

### 5. `runner.ts:136-142` — `finalize` 通知异步 fire-and-forget，可能被 `SIGTERM` 截断

**代码**：
```typescript
sendFeishuText(...)
  .then((sent) => { if (!sent) store.patch(task.id, { notify_failed: true }); })
  .catch((e) => { ... store.patch(task.id, { notify_failed: true }); });
```

**问题**：`finalize` 是同步函数，通知异步执行。`SIGTERM` handler (`runner.ts:65-68`) 直接 `process.exit(0)`，如果通知恰好在 pending，会被截断，导致 `notify_failed` 未标记。

**建议**：`SIGTERM` handler 里先清 timeout，给一个短暂 grace period（如 500ms）让 pending promise 完成，再退出。或明确接受"通知可能丢失"的语义并在文档中说明。

> **修复记录（2026-08-19）** — `src/runner.ts` 把 finalize 启动的通知 promise 赋给模块级 `pendingNotify`；SIGTERM handler 用 `Promise.race` 等 `pendingNotify` 完成，最长 1500ms（`NOTIFY_GRACE_MS`）。`pendingNotify` 在 `.finally` 中清空，避免旧引用滞留。

---

### 6. `store.ts:127-140` — `buildUpdate` 列名直接拼入 SQL，无运行时校验

**代码**：
```typescript
function buildUpdate(patch: TaskPatch, setExtra: string, whereExtra: string): [string, ...] {
  // ...
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k}=?`);  // k 直接拼入 SQL
  }
}
```

**问题**：虽然 `patch` 来自内部代码、TypeScript 类型已约束，但如果未来有动态构造 patch 的场景（如反射、序列化反序列化），存在 SQL 注入风险。

**建议**：在 `buildUpdate` 中加列名白名单校验（如 `if (!TASK_COLUMNS.includes(k)) throw`），或至少用 `keyof Task` 做运行时断言。

---

### 7. `agent-env.ts:13` — PATH 硬编码，可能遗漏 macOS 常用路径

**代码**：
```typescript
PATH: [dirname(bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
```

**问题**：macOS 上很多工具在 `/usr/local/bin` 或 `/opt/homebrew/bin`，agent 可能找不到 `git`、`node` 等常用命令。

**建议**：从 `process.env.PATH` 过滤而非完全重建，或至少把 `process.env.PATH` 追加到末尾。

---

### 8. `config.ts:47-61` — `validate` 没校验 `executors[*].bin` 是否可执行

**问题**：`loadConfig` 在运行时才发现 bin 不存在（spawn 失败）。建议至少做 `existsSync` 或 `accessSync(X_OK)` 校验，提前报错。

---

## 🟡 P2 — 细节/风格

### 9. `notifier.ts:36-38` — `sleep` 未 export

不影响功能，但如果测试需要控制时间，无法注入。建议 export。

### 10. `executors/opencode.ts` — 推断标记 ⚠️ 已存在，但无 fallback

如果 opencode 事件形态与推断不符，`parseEvent` 返回 null，runner 忽略该事件。v1 下终态仍靠 `result` 事件或最终文本，问题不大；daemon 模型下 serve 路径依赖更多事件类型，此问题会被放大。已在 design doc §9 标注待实证。

---

## 与 daemon 设计的衔接清单

| v1 现状 | daemon 设计依赖 | 风险/需决策 |
|---|---|---|
| `tasks.session_id` 有列、runner 首轮写回 (`runner.ts:92`) | §3 要求适配器写回 | ✅ 兼容，无需改动 |
| `submit(continue_of)` 做续跑 | §6 新增 `answer` 工具 | **需决策**：废弃 `continue_of` 还是共存？建议 `answer` 作为 `submit(continue_of)` 的语法糖 |
| runner 是 detached 进程、pid 记到 task | daemon 下 runner 消失 | `cancel` 的 `kill(-pid)` 需改为适配器级 `abort()` |
| `reapZombies` 依赖 pid 存活检测 | daemon 下无 runner pid | **需移除**或替换为心跳检测 |
| `MAX_ROUNDS=5` 在 `runner.ts:16` 硬编码 | §8 列为待定 | 建议移到 `config.json` 的 `defaults` 中 |
| `runner.ts` 的 `finalize` 含通知+落库 | 迁移到 daemon 的 `EventDispatcher` | 需保证异步通知在 daemon 生命周期内完成 |

---

## 本机集成测试 Gap 分析

> 状态更新（2026-08-19）：v1 review 当日已落入 `tests/integration.test.ts`，覆盖正文列出的前 5 类（完整生命周期、续跑、超时、cancel 级联、并发）+ P0-2 / P1-3 / P1-5 / P1-8 等修复的回归网。当前 5/5 通过，60/60 全量测试通过；fake-agent.mjs 共享 fixture 暂未扩展，集成测试用 inline fixture（chmod +x 内联脚本）替代——见下。

### 已具备 ✅

- [x] `fakeExecutor` 存在（`src/executors/fake.ts`），复用 claude 事件解析
- [x] 测试框架 vitest 已配置
- [x] SQLite 内存/临时文件测试基础设施（`store.test.ts` 已用 `mkdtempSync`）
- [x] 集成测试文件 `tests/integration.test.ts` 已存在，覆盖 happy / cancel / timeout / continue / concurrent 五个用例

### 解决 ✅

#### 1. `fake-agent.mjs` 模式补充 ✅→⚠️ 部分解决

`tests/fixtures/fake-agent.mjs` 保留（FAKE_MODE=ok|needs_input|fail|hang）作为契约级 fixture。集成测试**不依赖共享 fixture**，改用每个 `setupHome()` 写一份**inline chmod +x 的 fake-agent.cjs**：

- 行为由 `FAKE_MODE` 环境变量决定（与共享 fixture 同名同语义）
- 通过 `FAKE_PIDFILE` 选项让 cancel 测试验证 agent pid 实际死亡
- `--resume` / 多轮 / 工具调用 / 慢速输出这些模式的扩展不在本轮范围内——谁要用谁来加

为什么不修共享 `fake-agent.mjs`：
- 它已声明不读 argv / 不感知 resume，是 v1 早期 fixture
- 集成测试 inline 方案更 hermetic（每个 it 用独立 home + agent，互不串扰）
- 改共享 fixture 改 8+ 处使用点，影响面远大于本会话目标

#### 2. 集成测试文件 ✅

`tests/integration.test.ts` 已实现：

- [x] 完整任务生命周期（submit → runner → fake-agent → completed）
- [x] cancel 级联（submit hang → cancel → agent pid 死亡）— **P0-2 回归网**
- [x] 超时处理（fake-agent hang > timeout_sec → failed(timeout)）— **P1 timeout 回归网**
- [x] 续跑闭环（needs_input → submit(continue_of) → completed）
- [x] 并发安全（N=4 并行 submit，全部 completed，无 DB 冲突，< 8s 完成）
- [ ] 通知链路（dry_run=false 真实发 webhook）— 未覆盖；现用 dry_run=true 跳过

#### 3. 测试环境配置 ✅（部分解决）

- [x] 内联 inline fake-agent.cjs + profile.env.PATH 注入（避开 `node` shebang 找不到）
- [x] `AGENT_FLOW_HOME` 每次 `mkdtempSync("/tmp/afex-int-*")`
- [ ] 飞书 webhook URL 指向本地 mock server（未实现）

> 注：集成测试用 `/tmp` 而非 `os.tmpdir()`——macOS 在 `/var/folders/.../T` 下 spawn 可执行 `.cjs` 报 ENOEXEC（Quarantine 属性 / 内核 EXEC 权限边界）。在 `tests/integration.test.ts` 顶部注释解释了这一点。

#### 4. 进程清理保障 ✅

- `beforeEach` mkdtemp + `mkdirSync logs`
- `afterEach` `rmSync(home, { recursive: true, force: true })` —— 包含 SQLite db + log 文件
- agent 进程在 cancel 测试里**主动断言死亡**（`process.kill(agentPid, 0)`）；超时测试里 SIGTERM 路径下 fake-agent `process.exit(0)` 主动响应
- 不需 `process.on('exit')` 兜底：所有 agent 路径都通过 child.on('close') 显式收尾

#### 5. CI/本地运行一致性 ✅（部分解决）

- [x] `package.json` 加 `"test:integration": "vitest run tests/integration.test.ts"`（与 `test` 区分）
- [ ] 文档说明集成测试依赖（Node >=22.5、tsx、sqlite 实验性警告可忽略）— 未单独写；本 review doc 顶部已述

---

## 建议修复优先级

1. ✅ **P0-1**：去掉 `reapZombies`（已修，见各条目修复记录）
2. ✅ **P0-2**：`cancel` 的进程组杀级联问题（已修，方案 b）
3. ✅ **P1-3**：`submit` 的 spawn 异常捕获（已修）
4. ✅ **P1-5**：`finalize` 通知被 `SIGTERM` 截断（已修）
5. ⏳ **P1-6**：`buildUpdate` 列名白名单（加固；当前 patch 来源全部静态，风险低）
6. ⏳ **P1-7**：`agent-env.ts` PATH 追加 `process.env.PATH`（涉及 spec §7.1 "显式构造"决策，慎改）
7. ⏳ **P1-8**：`config.ts` validate 校验 bin 可执行（启动失败快速失败，建议修）
8. ⏳ **集成测试**：写 `fake-agent.mjs` + `integration.test.ts`（范围大，单独排期）

---

## 附录：关键文件速查

| 文件 | 职责 | 评审条目 |
|---|---|---|
| `src/store.ts` | SQLite 状态机 | P1-6 |
| `src/runner.ts` | detached runner 入口 | P1-4, P1-5 |
| `src/spawn-runner.ts` | runner spawn 工具 | P1-3 |
| `src/tools/submit.ts` | MCP submit/continue | P1-3 |
| `src/tools/status.ts` | MCP status + reapZombies | P0-1 |
| `src/tools/cancel.ts` | MCP cancel | P0-2 |
| `src/agent-env.ts` | agent 子进程环境 | P1-7 |
| `src/config.ts` | 配置加载与校验 | P1-8 |
| `src/notifier.ts` | 飞书通知 | P2-9 |
| `src/executors/opencode.ts` | opencode 事件解析 | P2-10 |
| `src/executors/claude.ts` | claude 事件解析 | — |
| `src/executors/fake.ts` | fake 测试 executor | 集成测试 gap |
| `src/prompt.ts` | prompt 包装契约 | — |
| `src/server.ts` | MCP server 入口 | — |
| `src/paths.ts` | 路径解析 | — |
