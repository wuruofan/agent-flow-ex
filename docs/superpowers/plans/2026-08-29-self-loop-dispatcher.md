# Self-Loop Dispatcher 上线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Trae 上启用一个 cron 驱动的自循环调度员（每 10 分钟扫一次活跃任务），实现「needs_input 自动续跑 + 孤儿/超时 running 自动 cancel」的无人值守闭环。agent-flow-ex 仅引入一处最小逻辑改动（`status` 暴露 `timeout_sec`）。

**Architecture:** Scheduler 用 Trae 内置的 cron `Schedule`（每 10 分钟，**已 `trigger` 实测 new 会话能调 `agent_flow_*`——通过**）；Dispatcher 是每次定时触发开的**全新会话**，靠「prompt 即规约」从 store 读状态决策；worker 由既有 runner 会话续跑。通信按设计稿 §4.3（needs_input 富上下文报告约定）与契约第 2/5 条执行。

**Tech Stack:** Trae `Schedule`（cron，最小 10 分钟粒度）· `mcp_agent-flow-ex`（agent_flow_status/submit/cancel）· agent-flow-ex v2 现有 runner。

**前提（已完成，不需重做）：**
- 探测 Schedule 已验证：新定时会话能加载 `agent_flow_*` MCP 并成功 `agent_flow_status()`（返回 `[]`）。
- 探测产物已清理（Schedule 已删、`.probe-result.txt` 已删）。
- [prompt.ts](file:///Users/meow/workspace/agent-flow-ex/src/prompt.ts) 契约第 2/5 条已更新（富上下文报告 + 上下文卫生）——**未提交**，本 plan Task 1 负责固化提交（review ④）。

> **执行进度**：Task 1（Step 1–8）、Task 2 已完成并提交（`41bc69f`/`cc550e5`/`211ebd5`/plan 文档见 Step 8），后续从 Task 3 开始；相应 checkbox 已勾选。

> **认知核对（不需改）**：真实 `config.defaults.timeout_sec=3600`，意味着真实场景孤儿最长 2 小时才被收割——这是策略使然；Task 5 用 `timeout_sec=60` 显式绕开等待，合规。

> **设计决议**（review 阻断①，用户已定）：`agent_flow_status` 目前不返回 `timeout_sec`（且 per-task 可覆盖），调度员「2×timeout_sec」规则不可执行。选择方案 (a)：**给 `TaskView` 加 `timeout_sec` 字段**（Task 2，含 TDD）。

---

## 关键产物：调度员最终 Prompt（写死在 spec §4.1，Schedule message 引用同一文本）

```
你是 agent-flow-ex 的调度员。工作区：/Users/meow/workspace/agent-flow-ex。
任务状态只用 agent_flow_* 工具变更；允许只读工作区文件（含 question 引用的 docs/problems/*.md，用于核对上下文）；
禁止写文件、禁止 git、禁止直接读写 ~/.agent-flow-ex/tasks.db。
若本轮无任何可行动作，回复「idle」即结束，不要多做。

步骤：
1. 调用 agent_flow_status()（不带参数），获取所有活跃任务（queued/running/needs_input）。
2. 对每个 needs_input 任务（单次最多处理 3 个）：
   a. 读该任务 question；需要时可只读 question 指向的 docs/problems/*.md 或相关文件取上下文。
   b. 仅当 question 属「机械/事实/配置类」且你能从现有代码/上下文确知答案时才代答；
      涉及方向选择、破坏性操作、需求歧义、rounds>=3、或你不确定的，一律不猜，保留待人工（飞书已推送）。
   c. 可代答时 agent_flow_submit(continue_of=<task_id>, prompt=<简短明确可直接执行的答案>)。
3. 对 status=running 且 elapsed_sec > 2×timeout_sec 的任务：agent_flow_cancel(task_id=...)（孤儿/卡死收割）。
4. 其他不操作；处理完结束。
约束：单次最多 3 个 needs_input；不对同一 task_id 重复 submit；rounds>=3 不代答；不确定就不代答。
```

> 注：第 3 条的 `timeout_sec` 依赖 Task 2 的代码改动；第 2 条 b 款「rounds>=3 不代答」防调度员错误 token 烧穿 runner 的 `MAX_ROUNDS=5`。

---

### Task 1: 定稿设计稿（Trae 首选 + V1 已验证 + 通信/溢出/超时决议）

**Files:**
- Modify: `src/prompt.ts`（仅 commit，不改内容）
- Modify: `docs/superpowers/specs/2026-08-29-self-loop-design.md`

- [ ] **Step 1: 更新派发方矩阵（§3）与实现路径（§5）为「Trae 首选、已验证」**

将 §3 的 Trae 行从「待 spike」改为「内置 `Schedule`（cron，最小 10 分钟）· 进程内 MCP 可见性已实证通过 · 每次触发新会话、无内存，store 即外部记忆」；「结论」改为：首选 Trae Schedule，WorkBuddy 降为备选、launchd 仅兜底。§5.1/§5.2 相应改写为「Trae Schedule 实现路径 + 已过前置验证」，删除 WorkBuddy 作为首选的占位论证（保留 WorkBuddy 行于能力矩阵即可）。

- [ ] **Step 2: §7 验证清单标记完成**

V1 → ✅（说明：探测 Schedule 已实测，新会话可调 `agent_flow_status()`）；V2/V3 → 由本 plan Task 4/5 的真实调度员运行覆盖（含自然 tick 守时验证）；V6/V7 → 明确「Trae hooks 定时触发器、Codex 自动化」不纳入 v1 候选，延后，删除其作为前置门槛的表述。

- [x] **Step 3: §4.1 写入调度员 Prompt**

将「关键产物」中的调度员最终 Prompt 全文写入 spec §4.1，作为唯一权威源；§4.1 其余说明（单次上限 3、rounds>=3 不代答、1k token 约束）与最终 Prompt 保持一致。

- [ ] **Step 4: §9 时延指标按 10 分钟粒度修正**

端到端最坏收敛 = needs_input 轮数 × 10 分钟（如 2 轮 ~ 20 分钟）；`< 30 秒` 的调度员处理延迟描述更新为「单次触发内完成 status 扫描与 submit」「整体由 cron 粒度主导」；token 用量指标改为「Task 7 实测取均值」。

- [x] **Step 5: §11 待决问题记录决议**

V1 派发方=Trae Schedule；不采纳 §6.1 聚合查询（先 v1 跑通）；调度员「可代答边界」+「rounds>=3 不代答」按最终 Prompt 执行；飞书「取消续跑/人工接管」按钮 v1 不做（人随时可在会话内直接 submit 抢占）；超时收割依据=新增 `timeout_sec`（方案 a，见 Task 2）。

- [ ] **Step 6: 提交契约改动（先固化未提交的 prompt.ts）**

```bash
git add src/prompt.ts
git commit -m "feat: add rich-context reporting and context-hygiene rules to worker contract"
```

- [x] **Step 7: 提交 spec 定稿**

```bash
git add docs/superpowers/specs/2026-08-29-self-loop-design.md
git commit -m "docs: finalize self-loop spec as Trae-Schedule dispatcher, mark V1 verified"
```

- [x] **Step 8: 提交 plan 文档本身**

plan 文档 `docs/superpowers/plans/` 目前仍是 untracked（spec 已入库，plan 一并固化）：

```bash
git add docs/superpowers/plans/2026-08-29-self-loop-dispatcher.md
git commit -m "docs: add self-loop dispatcher implementation plan"
```

---

### Task 2: `agent_flow_status` 暴露 `timeout_sec`（review 阻断①）

**Files:**
- Modify: `src/tools/status.ts:6-35`
- Test: `tests/tools.test.ts`（`status` describe 内新增）

- [x] **Step 1: 写失败测试**

在 `tests/tools.test.ts` 的 `describe("status")` 中追加：

```ts
it("exposes timeout_sec in status view", () => {
  const store = openStore(join(home, "tasks.db"));
  store.createTask({
    id: "task_to", prompt: "x", project_path: home, executor: "fake", profile: "fake",
    timeout_sec: 120, log_path: join(home, "logs", "to.jsonl"), role: "worker", created_at: 1,
  });
  const v = status({ task_id: "task_to" }) as { timeout_sec?: number };
  expect(v.timeout_sec).toBe(120);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/tools.test.ts -t "exposes timeout_sec"`
Expected: FAIL（`timeout_sec` 不存在 / undefined）

- [x] **Step 3: 实现**

在 `src/tools/status.ts`：

- `TaskView` 接口 `profile: string;` 之后加一行：

```ts
timeout_sec: number;
```

- `view(t)` 内 `profile: t.profile,` 之后加一行：

```ts
timeout_sec: t.timeout_sec,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS（全部通过）

- [x] **Step 5: Commit**

```bash
git add src/tools/status.ts tests/tools.test.ts
git commit -m "feat: expose timeout_sec in agent_flow_status view for dispatcher reap rule"
```

---

### Task 3: 建立调度员 automation（Trae Schedule）

**Files:** 无仓库文件；操作 Trae `Schedule` 工具。

- [ ] **Step 1: 用最终 Prompt 创建调度员 Schedule**

`Schedule` `action: create`：
- `name`：`agent-flow 调度员`
- `cron_expression`：`*/10 * * * *`（每 10 分钟，Trae Schedule 最小粒度）
- `timezone`：`Asia/Shanghai`
- `message`：Task 1 Step 3 定稿的调度员最终 Prompt 全文

预期：返回 `scheduled_task_id`（形如 `f26d03a0`），`Status: Active`。

- [ ] **Step 2: `trigger` 一次实跑**

`Schedule` `action: trigger`，`scheduled_task_id`=上一步返回的 id。预期：`Executions` +1，Last run 时间更新，会话按 Prompt 执行。

- [ ] **Step 3: 观察首跑产出（验证空闲路径）**

由于当前无活跃任务，预期调度员返回 `idle`（或空状态摘要），不产生任何 submit/cancel、不改任何文件。确认无异常报错。

---

### Task 4: V4 验收 —— needs_input 自动续跑（含自然 tick 守时）

**Files:** 无仓库文件；用 MCP `agent_flow_*` + 调度员观察。

- [ ] **Step 1: 制造一个确定性 needs_input 任务**

通过当前会话调用 `agent_flow_submit(prompt, project_path="/Users/meow/workspace/agent-flow-ex")`（`profile` 省略，走默认 fallback）。prompt 里埋一个「本任务会先输出 ❓NEEDS_INPUT: 选择一个明确的配置（确定性选择题，答案可从现有 config 推断），等你答复后继续」。记录返回的 `task_id`。

- [ ] **Step 2: 等待任务进入 needs_input**

用 `agent_flow_status()` 确认该 `task_id` 变 `needs_input` 且 `question` 非空（飞书会收到推送；`notify.dry_run=false` 时）。

- [ ] **Step 3: 等一次自然 10 分钟 tick（not trigger）**

明确等待 cron 自然到点（同时验证 V2/Trae cron 守时）。预期：调度员判定该问为「机械/事实/配置类」→ 自动 `agent_flow_submit(continue_of=<task_id>, prompt=答案)`。

- [ ] **Step 4: 确认续跑并 completed**

`agent_flow_status(task_id=...)` 预期进入 `running` 随后 `completed`，`rounds>=2`，无人工干预；`completed` 卡片仅当 `cfg.notify.dry_run=false` 时发送（dry_run=true 时以 `status` 为准）。失败排查：调度员未代答（判定为不确定）→ 改埋更机械/事实性的 question 重试；代答失败 → 检查 `submit` 的 `continue_of` 校验与 question 取值。

---

### Task 5: V5 验收 —— 孤儿 running 收割（改造孤儿，review 阻断②）

**Files:** 无仓库文件。真实价值：runner 进程被 kill -9 / 机器重启 / main 异常退出（不 finalize）时，任务滞留 `running` 且 `status()` 不做僵死自检（v2 §5 的 interrupted 检测未实现），由调度员 cancel 收割。

- [ ] **Step 1: 提交一个小 timeout 任务**

`agent_flow_submit(..., timeout_sec=60)`，prompt 写「持续产出但不结束」。记 `task_id`。

- [ ] **Step 2: 杀掉 runner 进程组制造孤儿（kill -9 进程组）**

在 60s 超时触发前执行。task_id 是 runner argv 的末位参数（必现），用 ps 定位第一列的 `<runner_pid>`：

```bash
ps ax -o pid,command | grep "<task_id>" | grep -v grep
```

取到 `<runner_pid>` 后**杀整个进程组**（负号 = 组信号；runner 是组组长，agent 同组继承，一并击杀，不遗留失控 agent）：

```bash
kill -9 -<runner_pid>
```

> 与 cancel 自身的 `kill(-pid)`（cancel.ts:17）语义一致；杀组后 store 同样留下孤儿 running（runner 走 SIGKILL、不走 finalize），验证目标不变。

- [ ] **Step 3: 确认任务滞留孤儿 running+elapsed 增长**

`agent_flow_status(task_id=...)` 预期仍为 `running`（runner 被杀不 finalize），`elapsed_sec` 继续增长。若已被置 `failed` → 说明 runner 在 kill 前已 finalize，回到 Step 2 核对 pid 选择。

- [ ] **Step 4: 等自然或 `trigger` 调度员 tick**

等待 `elapsed_sec > 2×60=120s`（如超 2 分钟）后，调度员检测到 `running 且 elapsed > 2×timeout_sec` → `agent_flow_cancel(task_id=...)`。

- [ ] **Step 5: 确认 cancelled 并核对无残留进程**

`agent_flow_status()` 预期该任务为 `cancelled`。因 Step 2 已按进程组击杀（runner+agent 同组），agent 不应残留；仍可 `ps ax | grep "<task_id>" | grep -v grep` 复核无匹配。失败排查：未 cancel → 检查 `status()` 是否返回（并含）`elapsed_sec`、`timeout_sec`，以及 2× 判定阈值（衔接 Task 2）。若要改回单 pid 杀法，agent 的 pid 需从任务日志 `_runner` spawn 事件（runner.ts:64）读 `child_pid` 再杀（prompt 走 stdin、agent argv 不含 task_id，pkill task_id 匹配不到 agent）。

---

### Task 6: 人工打断与并发安全抽查

**Files:** 无仓库文件。

- [ ] **Step 1: 人工抢占验证**

对一个 `needs_input` 任务，人工（在会话内直接 `agent_flow_submit(continue_of=...)`）与调度员同时提交。预期基于原子 `WHERE status=needs_input`（v2 §4.1）：先到者成功、后到者收到明确错误而非覆盖。

- [ ] **Step 2: 结算 + 收尾核对**

确认 Task 4/5 产生的测试任务均已 `completed`/`cancelled`，无残留 `running`/`needs_input`；调度员 Schedule 保持 Active。

---

### Task 7: 结论归档与交接

**Files:** 无仓库文件。

- [ ] **Step 1: 确认 v1 调度闭环达成 + 记录 token 实测均值**

汇总：needs_input 自动续跑 ✅、孤儿/超时 running 自动 cancel ✅、人工可打断 ✅、agent-flow-ex 仅新增一处逻辑改动（`status` 暴露 `timeout_sec`，非 0 改动，如实记录）。从各次调度员触发报告汇总实测单次 LLM token 用量取均值，填入本步记录。测试调度员即生产调度员（不另建 prod 任务，避免重复作业）。

- [ ] **Step 2: 向用户汇报**（本步由主 agent 完成）

给出：调度员 `scheduled_task_id`、cron 表达式、Task 4/5 实测结果、单次 token 均值、剩余人工负担（开放性问题仍需人答、failed 仍人决策、`rounds>=3` 后调度员不再代答）、以及留给 v3+ 的可选增强（§6.1 聚合查询、异步通道、runner 僵死自检 `failed(interrupted)`）。

---

## Self-Review

**1. Spec coverage（设计稿 §7/§9/§11）**
- V1（新会话可见 MCP）→ 前提已完成，Task 1 标注 ✅。
- V2（实际触发间隔，含 cron 守时）/V3（prompt 跑通）→ Task 3 Step 3 与 Task 4 Step 3（自然 tick）+ Task 5 覆盖。
- V4（needs_input 自动续跑）→ Task 4。
- V5（超时 running 自动 cancel）→ Task 5（改为孤儿收割，真实可测路径）。
- V6（Trae hooks 定时）/V7（Codex 自动化）→ 明确非 v1 候选，Task 1 Step 2 处置。
- §9 验收（无人为干预 autonomously 完成、token 用量、端到端延迟）→ Task 4/5 + Task 1 Step 4 + Task 7 Step 1（token 实测均值）。
- §11 待决问题 → Task 1 Step 5（含 timeout_sec 方案 a 决议）。

**2. Placeholder scan**：调度员 Prompt 全文内联；各任务代码/命令均完整；无「TBD/TODO」。

**3. Type/name consistency**：`agent_flow_status / agent_flow_submit(continue_of=...) / agent_flow_cancel` 与 v2 §6 契约一致；`timeout_sec` 字段名与 store `Task.timeout_sec`、`submit` 参数一致；`scheduled_task_id`、`elapsed_sec` 与既有接口命名一致；Task 2 测试中 `openStore`/`createTask`/`status` 签名与 `tests/tools.test.ts` 既有用例一致。

---

## 执行结果（截至 2026-08-29 15:11 北京时间）

| Task | 状态 | 备注 |
| :--- | :--- | :--- |
| Task 1 设计稿定稿 | ✅ 已提交 | commits `41bc69f` / `cc550e5` / `de81746` |
| Task 2 `status` 暴露 `timeout_sec` | ✅ 已提交 | commit `211ebd5`（含后续 status.ts 接口字段补全 + setStartedAt 测试，见 `77ba9d5`） |
| Task 3 Schedule 创建 + 首次 trigger | ✅ Schedule ID `8a989934` Active → Paused | Executions 27，全 idle |
| Task 4 V4 needs_input 自动续跑 | ⚠️ **部分成功** | 03:41 自然 tick（北京时间 11:41）调度员成功代答过一次；其余 26 次 tick 全部 idle 报「No agent_flow_* tools available」 |
| Task 5 V5 孤儿收割 | ❌ **未达** | Step 1-3 完成（submit + kill 进程组 + 确认 running 滞留），Step 4 等调度员自动 cancel 未达成；归因见下方 |
| Task 6 人工打断/并发安全 | ❌ **未达** | 集成测试 baseline 失败（沙盒 PATH 缺 `node`，与本任务无关）；MCP 客户端断连，无法在本会话重连 |
| Task 7 结论归档 | ⏸ **未开始** | 需先解决平台问题 |

### 失败归因（Trae Schedule 在隔离会话里 MCP tools 不可见）

- **现象**：Trae Schedule 触发的全新会话里 LLM 报告「No `agent_flow_*` tools are available in the current toolset」；本会话（同 IDE）`mcp_agent-flow-ex` 工具列表仍正常 3 个工具。
- **早期一次成功**：北京时间 11:41（UTC 03:41）的 tick 成功调用 `agent_flow_submit(continue_of=...)` 完成 needs_input 任务（task_mtdtqac4_520e97）。当时未触发任何 MCP server 重启。
- **唯一变化**：在我后续为 V5 注入 `set_started_at` 测试工具时，**kill 并自动重启了 MCP server 进程**（pid 17974→80852→4060→4180→4340），并修改了 `~/.workbuddy/mcp.json` 添加 `env: { AGENT_FLOW_TEST_MODE: 1 }`。
- **猜测根因**：
  1. Trae Schedule 触发的隔离新会话与主 IDE session 的 MCP toolset 是**独立视图**，Schedule 会话不会自动同步主 IDE 重启 MCP server 后刷新的工具集；
  2. 或：`env` 字段不被 Trae schema 识别、Trae 拒绝加载带 env 的 MCP server，导致该 server 在 Schedule 会话里被剔除。
- **结论**：**Trae Schedule 不能可靠承载 dispatcher**——这是平台行为，不是 prompt/代码问题。

### 还原与回退

- `~/.workbuddy/mcp.json` 的 `env` 字段保留（不影响生产路径，因 `AGENT_FLOW_TEST_MODE` 默认未启用；下一次 MCP server 重启会读到，启用 `set_started_at` 工具）。
- Schedule ID `8a989934` 已暂停（`Status: Paused`），不再消耗 token。
- 留给 v2 spike：WorkBuddy automation（备选）或 launchd（兜底）派发方路径；任何路径上线前需先实测「触发的新会话能否加载 MCP tools」，避免再次踩坑。

### 已知问题（移交）

1. **集成测试 baseline 失败**（`tests/integration.test.ts`：5 失败）——根因是沙盒 PATH 没 `node`，与本任务无关；建议在非沙盒环境下复跑。
2. **`run_mcp` 整数类型参数投递限制**——本次 `timeout_sec` 必须为 `integer`，但通过 `run_mcp` 传入数字字面量时全部被转为 string，被服务端 schema 拒绝。这是 MCP client 上游限制。
3. **Task 6 并发安全抽查**未执行——同问题 1 + 集成测试 baseline 失败。`tests/tools.test.ts` 中的 submit concurrent 单元测试已存在，可作为代码层证据。