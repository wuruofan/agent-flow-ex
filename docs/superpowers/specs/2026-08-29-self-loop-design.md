# agent-flow-ex 自循环调度设计

**文档编号**：2026-08-29-self-loop
**状态**：定稿（已吸收 GLM review：Trae 首选/V1 已验证/rounds≥3 不代答/超时收割=timeout_sec）
**最后更新**：2026-08-29
**依赖**：`2026-08-16-project-spec-v2.md`（v2 主规格）

---

## 1. 动机

### 1.1 当前的「人即事件循环」

按 v2 设计（v2 spec §4.4），worker 终态变化只走一条路：飞书卡片推给用户。架构里**没有** worker→agent 的反向通道。用户是 loop 的中继：

```
worker 终态 ─> 飞书卡片 ─> 用户 ─> 回到 IDE ─> 告诉我 ─> 调 agent_flow_* 工具
```

这条链有两个固有缺陷：

1. **用户必须在线 + 必须记得看**：离线时飞书卡片只堆积，没有任何自动推进。
2. **每次循环都引入人类响应延迟**（秒级到天级），且「答案」高度依赖用户当下能否准确描述上下文。

### 1.2 目标

把「用户中继」环节替换成 **自动调度员（dispatcher agent）**。最小可行目标：

- **`needs_input` 任务自动续跑**：调度员读 `question`，组装答案，`agent_flow_submit(continue_of=...)`。
- **保持 agent-flow-ex 0 改动**（v2 spec §11 daemon 化 guard rails 暂不触发）。
- **不绑死任何 IDE/agent**：WorkBuddy、Trae、Codex 任意一家能跑 agent 进程 + 能调 MCP 工具即可。

非目标（v3+ 再议）：

- 自动重试 `failed`（错误类型太多，盲重试风险高，留给人决策）。
- 自动 merge / 自动 commit（破坏性操作，必须人把关）。
- 实时事件驱动（秒级响应），自动化任务最低粒度按分钟级。

---

## 2. 核心抽象：三层模型

```
┌────────────────┐   触发   ┌─────────────────┐   调 MCP 工具   ┌─────────────────┐
│  Scheduler     │ ───────> │  Dispatcher     │ ──────────────> │  agent-flow-ex  │
│  (派发方自带)  │          │  (agent 进程)    │                 │  MCP server     │
└────────────────┘          └─────────────────┘                 └─────────────────┘
                                       │                                  │
                                       └──> worker (按需派) <─────────────┘
```

| 层 | 角色 | 关注点 | 谁实现 |
| :--- | :--- | :--- | :--- |
| **Scheduler** | 计时器/事件源 | 何时触发 | 派发方自带（WorkBuddy automation、Trae hooks、cron、launchd…） |
| **Dispatcher** | agent 进程 | 读 store、决策、调工具 | 一个 prompt 模板 + agent runtime |
| **MCP server + worker** | 任务执行 | 派活、跑、回写状态 | agent-flow-ex 既有实现（v2 spec §2.2） |

**关键不变量**：

- Scheduler 不感知 agent-flow-ex 内部，只知道「到点了要跑一个 prompt」。
- Dispatcher 不感知 Scheduler 存在与否，只知道「我是个 agent，能调 MCP 工具」。
- agent-flow-ex **几乎 0 改动**：所有 loop 逻辑在调度员 prompt 里描述；唯一例外是 `agent_flow_status` 暴露 `timeout_sec`（§6.3，plan Task 2）。

这条不变量保证：

1. 派发方任意切换不影响任务系统。
2. agent-flow-ex 的 daemon 化（v2 spec §11）仍是未来选项，不必为 loop 提前引入常驻进程。

---

## 3. 派发方能力矩阵

下面把候选派发方作为 Scheduler 评估。**前提假设**：所有派发方都能 spawn 一个 agent 进程；不同点在「触发机制 + 进程内 MCP 可见性 + 上下文维持能力」。

| 派发方 | 触发机制 | 触发粒度 | 进程内 MCP 可见性 | 上下文维持 | 状态持久化 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WorkBuddy automation** | `automation_update` + RRULE / `scheduledAt` | 分钟级（RRULE 粒度下限待测） | **已验证**：初始工具列表**不可见**，须 `ToolSearch` 加载后 `DeferExecuteTool` 调用（见 §4.1 步骤 0） | 每次触发新会话；平台另提供 `.workbuddy/automations/<id>/memory.md` 跨轮记忆（v1 不用） | store 即外部记忆 | **v1 首选**（2026-08-29 21:20 端到端实测通过） |
| **Trae IDE hooks** | hooks 框架（trae-hooks）事件触发 | 事件级（写文件、跑命令等） | hooks 默认 deny（v2 spec 提到） | 无 agent 进程概念 | 同上 | 事件型不直接适配「定时调度」 |
| **Trae Schedule** | 内置 `Schedule`（cron） | 10 分钟（最小粒度） | **失败**：27 tick 仅 1 次成功，LLM 报 `No agent_flow_* tools available`。根因待定——可能是缺步骤 0（延迟加载），也可能需开 UI「自动运行 MCP」 | 每次触发新会话，无内存 | store 即外部记忆 | 待 5 分钟回测（见 §11） |
| **Codex CLI** | 待 spike | 待 spike | 待 spike | 待 spike | 待 spike | 不知道是否暴露自动化能力 |
| **launchd / cron** | 系统级 | 分钟级 | 进程独立启动，**必须手动加载 MCP**（启动参数注入或环境变量） | N/A | 文件系统 | 通用兜底，需写调度脚本 |

> **矩阵里「MCP 可见性」这一列的正确测法**（2026-08-29 教训）：不能只问「能不能调通」，必须拆成三问——① 新会话初始工具列表是否直接可见？② 不可见时的加载路径是什么？③ 加载后真实调用返回值如何？
> Trae 那次之所以在这列填了 ✅ 却仍然踩坑，正是因为只测了③、没测①②。

**结论**：

- **首选 WorkBuddy automation**：2026-08-29 21:20 实测端到端通过——定时触发 → `ToolSearch` 加载 3 个工具 → `ToolSearch`/`DeferExecuteTool` 调 `agent_flow_status()` → 返回 `[]` → 判定 idle → 无副作用。
- **Trae 路线降级为待回测**：不是设计问题，是「Trae 调度会话是否提供等价的工具发现能力」未验证。回测成本 5 分钟（§11）。
- **Codex 路线必须 spike**：当前没有任何 Codex 自动化机制的一手知识，不应基于假设设计方案。

---

## 4. 调度员 prompt 模板

Dispatcher 是个 agent 进程，每次触发执行同一个 prompt。**核心原则：prompt 自身即规约**，不依赖 agent 进程跨会话记忆——所有状态从 store 读，所有决策基于现状。

### 4.1 调度员 Prompt（最终版，唯一权威源）

```
你是 agent-flow-ex 的调度员。工作区：/Users/meow/workspace/agent-flow-ex。
任务状态只用 agent_flow_* 工具变更；允许只读工作区文件（含 question 引用的 docs/problems/*.md，用于核对上下文）；
禁止写文件、禁止 git、禁止直接读写 ~/.agent-flow-ex/tasks.db。
若本轮无任何可行动作，回复「idle」即结束，不要多做。

步骤：
0. 工具获取（必做，不可跳过）：agent_flow_* 是 MCP 工具，可能不在你的初始工具列表里。
   禁止仅凭"初始工具列表里看不到"就判定工具不存在——这是本任务最常见的失败模式。
   按序尝试：
   a. 直接调用 agent_flow_status()（不带参数）。成功则跳到步骤 1。
   b. 若报"无此工具"，用你可用的工具发现/搜索能力查找含 "agent_flow" 的工具并加载，再重新调用。
   c. 若仍拿不到，回复「tools unavailable」并列出你尝试过的具体方式，然后结束。
      不要猜测、不要改文件、不要尝试其他替代手段。
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

> 注：第 3 条的 `timeout_sec` 依赖 `agent_flow_status` 暴露该字段（§6.3，Plan Task 2 实现）；第 2 条 b 款「rounds>=3 不代答」防调度员错误 token 烧穿 runner 的 `MAX_ROUNDS=5`。本处为唯一权威源，各派发方的 `message` 全文引用同一文本。

#### 步骤 0 为什么存在（2026-08-29 实测补入）

**步骤 0 是唯一「平台相关」的一步，其余步骤在所有派发方完全一致。**

实测发现：**定时触发的全新会话，初始工具列表里可能没有 `agent_flow_*`**——不是工具不存在，而是需要 agent 主动加载。这是 2026-08-29 Trae 路线失败的表面现象（LLM 报 `No agent_flow_* tools available`），也是 WorkBuddy 探针（automation 触发的新会话）确认的同形现象。

各派发方的差异**只在「怎么加载」**，不在「要不要加载」：

| 派发方 | 初始可见 | 加载方式 | 实测状态 |
| :--- | :--- | :--- | :--- |
| WorkBuddy automation | 否 | `ToolSearch(tool_names=["mcp__agent-flow-ex__agent_flow_status", ..._submit, ..._cancel])` → `DeferExecuteTool` | ✅ 已验证（2026-08-29 15:57 探针） |
| Trae SOLO CN Schedule | 否（据失败现象推断） | **未知**——Trae 是否提供等价的工具发现能力未验证 | ❓ 待验证 |

**因此步骤 0 写成「按序尝试」而非硬编码某个 API**：先直接调、失败再找发现机制、再失败才放弃并如实上报。这样同一份 prompt 在两个平台上都能工作，且即使某个平台完全没有发现机制，调度员也会回报「tools unavailable + 我尝试过什么」，而不是静默地假装工具不存在。

**反模式（务必避免）**：不要写「若看不到 `agent_flow_*` 工具则说明环境有问题，直接结束」——这正是 2026-08-29 那 26 次 tick 全 idle 的行为模式。

### 4.2 为什么不需要「decision log」

- agent 进程是**短命**的（每次触发是新会话），不需要持久化决策历史。
- store 里的 `rounds`、`question`、`result` 字段就是全部决策上下文。
- 调度员的「记忆」= `~/.agent-flow-ex/tasks.db`（SQLite），由 agent-flow-ex 维护，调度员只读不写。

### 4.3 通信协议：worker→dispatcher 富上下文报告约定

**现状通道（v2 spec §4.3/§8，已实现）**：worker→dispatcher 只有一条**阻塞式 needs_input** 通道——worker 在决策阻塞时以「❓NEEDS_INPUT:」开头输出问题，runner 解析进 `question` 字段并推飞书；dispatcher→worker 走 `continue_of` 把答案回填会话。dispatcher→dispatcher 的轮询由 `agent_flow_status()`（10 分钟粒度）承担。

**缺口**：needs_input 只承载一句问题文本。若 worker 遇到的问题需要较长背景/多方论证，单条 question 承载不下；直接写文件又没有信号机制通知 dispatcher 去看。

**约定（推荐，零协议扩展）**：

```
worker 卡住
  ├─ 问题两句话说得清 → 直接 ❓NEEDS_INPUT:<问题>
  └─ 问题需长篇背景/多方论证 → 先写 docs/problems/problem-<时间戳>.md
        （背景/已尝试/卡点/可选方案）→ 再输出
        ❓NEEDS_INPUT:<一句话> 详见 docs/problems/problem-<时间戳>.md
                                        │
dispatcher（同工作区，可 Read 该文件）→ 读文档 → 组织答案
                                        ▼
                      agent_flow_submit(答案, continue_of=task_id)
```

- **不扩展协议**：dispatcher 本就运行在项目工作区，`Read` 该文档即可；question 字段保持短句（路径 + 一句话），细节落在文件里。
- **文件名带时间戳**：worker 不知道自身 task_id，多轮 needs_input 时各轮文档互不覆盖（用任务名/round 命名会因信息缺失而失败）。
- **落实在契约层而非 dispatcher 措辞**：该约定写死进 worker 行为契约 `src/prompt.ts` 的 `wrapInitialPrompt` 第 2 条（已更新），保证所有派发、所有未来 dispatcher 自动遵守。
- **不建异步非阻塞通道**（v1）：工人对真正决策阻塞本应停下；非阻塞信息由 10 分钟 poll 的 `progress`/`files_changed` 覆盖。异步侧信道 = 新机制 + 延迟 + 忽略风险，收益小，推迟到 v3+。

**上下文溢出（autocompact thrash）处理**：headless CLI（claude -p 等）整读超大文件时可能反复 autocompact→上下文回填→再次撑满，遂报错退出或卡死。当前机制只**兜底**不**解决**：报错退出 → `failed(error=stderr 尾)`；卡死 → 等 `timeout_sec` 后 `failed(error=timeout)`（真凶丢失，且最长等 1 小时）。要「降低触发」并把「卡死」引导成一条**可诊断的 needs_input**，关键靠契约预防而非运行时兜底——已在 worker 契约 `src/prompt.ts` 的 `wrapInitialPrompt` 追加第 5 条上下文卫生规则：不整读超大文件、读前先 `wc -l`/`grep` 探规模、遇 AUTOCOMPACT 反复警告即停止并按第 2 条带嫌疑文件路径/规模/已尝试上报，不要硬撑。这样 dispatcher 可回「读片段 / grep 收敛 / 排除该文件」等可执行答案续跑，根因由这一来一回解决；计时超时仍保留为最终兜底。因盲重试必然撞同一超大文件，故不启用 auto-retry failed（延续 v1 非目标）。

---

## 5. 各派发方实现路径

### 5.1 WorkBuddy automation（首选，已验证 2026-08-29）

**前置验证（已完成）**：`automation-1788009370311`（一次性）21:20 触发实测——新会话 `ToolSearch` 加载 3 个工具成功，`DeferExecuteTool` 调 `agent_flow_status()` 返回 `[]`，判定 idle、无副作用，run `success=true`。故 v1 派发方定为 WorkBuddy automation。

**5.1.1 调度员 automation 配置**

- `automation_update` `mode: create`：
  - `name`：`agent-flow 调度员`
  - `scheduleType`：`recurring`，`rrule`：`FREQ=MINUTELY;INTERVAL=10`（粒度下限待测）
  - `cwds`：`/Users/meow/workspace/agent-flow-ex`
  - `prompt`：§4.1 最终 Prompt 全文
- **不需要** `connectorIds`：agent-flow-ex 是 user-level 本地 MCP，非 marketplace connector，实测不配置即可用。
- 每次触发 = 全新会话，无进程内存；调度员状态全部从 store 读取。

**5.1.2 实测记录（2026-08-29 21:20）**

```
21:20:27  [SchedulerEngine] Automation is due
21:20:50  [ConnectorMcpProxy] callTool agent-flow-ex_agent_flow_status args={} → "[]"
21:21:06  [AutomationService] Run finalized: success=true, outputLen=179
```

调度员自述：ToolSearch 返回 3 个工具；`status()` 返回 `[]`；本轮 idle，未 submit / 未 cancel / 未写工作区文件。

**5.1.3 附带发现**

- 触发会话由 `--mcp-config` 注入 `connector-proxy`（`defer_loading: true`），agent-flow-ex 三工具以 `agent-flow-ex_agent_flow_*` 名注册，经 `transparent_proxy` 转发。
- 平台为每次 automation 提供 `.workbuddy/automations/<id>/memory.md` 跨轮记忆文件。**v1 不使用**——调度员的所有状态仍从 store 读，保持「prompt 即规约」不变量。

**5.1.4 V4 验收：needs_input 自动续跑（2026-08-29 21:43，通过）**

构造：提交 `task_mteffyqz_4af841`，prompt 要求 worker 先以 `❓NEEDS_INPUT:` 问「`config.example.json` 里 `defaults.timeout_sec` 是多少秒」，收到答复后写入 `/tmp/agent-flow-v4-probe.txt`。

结果（全部独立核对，非调度员自述）：

| 项 | 证据 |
| :--- | :--- |
| 进入 needs_input | `status` 返回 `needs_input`，`rounds=1`，question 与 result 均为预期文本 |
| 调度员判定与代答 | 调度员记录：判定为事实类，从工作区文件核实取值 3600，代答并续跑 |
| 续跑成功 | `rounds` 1 → 2，`status=running` → `completed` |
| 答案正确 | `cat /tmp/agent-flow-v4-probe.txt` → `timeout_sec=3600`（与 `config.example.json` 一致） |
| 无副作用 | `git status --short` 为空，仓库未被改动 |

**这次真正证明了什么**：调度员不只是「能跑起来」，而是能完成闭环核心动作——读 question → 判定可答 → 从工作区取证 → 组织答案 → `submit(continue_of=)` → worker 带着答案续跑至完成。

**观察方法注记**：`~/.workbuddy/traces/<pid>/*.json` 不完整（缺 `DeferExecuteTool` 的 span），且触发后不再刷新——**不能用作判成败的依据**。可用的是任务 status 转换、产物文件，以及调度员自己写的 `.workbuddy/automations/<id>/memory.md`。

### 5.2 Trae SOLO CN Schedule（备选，待 5 分钟回测）

**配置位置**：MCP server 在 `~/Library/Application Support/TRAE SOLO CN/User/mcp.json`（普通 JSON，可直接编辑）。**该文件的 agent-flow-ex 注册已正确，无需改动。**
Schedule 存在账号侧/云端，**只能经 Trae UI 的 `Schedule` 工具操作，本地无文件可改**。

命中时**无需改动调度员 prompt**（同为「prompt 即规约」），仅需把 §4.1 Prompt 迁到 Schedule 的 `message`。回测动作见 §11。

**5.2.1 沿用自 v1 的风险与缓解**（派发方无关，两个平台同样适用）

| 风险 | 缓解 |
| :--- | :--- |
| cron 触发延迟 > 10 分钟 | 实测守时（Plan Task 4 Step 3 自然 tick 校验），若抖动偏大可再评估 |
| 同一任务被多次续跑（race） | `submit(continue_of=)` 内部原子 `transition`（v2 spec §4.1），重复调用直接返回错误 |
| 调度员误判（猜开放性问题） | 最终 Prompt 明确「方向选择/破坏性/需求歧义/rounds>=3 一律不代答」 |
| 调度员上下文爆 | 单次最多 3 个 needs_input + prompt ≤ 1k tokens |
| 孤儿 running 滞留 | 最终 Prompt 规则：`running 且 elapsed_sec > 2×timeout_sec` → `agent_flow_cancel`（依赖 `status` 暴露 `timeout_sec`，§6.3） |

### 5.3 Codex CLI（必须 spike）

**当前未知**：

- Codex CLI 是否有任何自动化机制（`codex schedule`? GitHub Action? web UI?）？
- 是否能加载外部 MCP server？
- agent 进程调度能力？

**前置 spike 清单**：

1. 查 Codex 官方文档是否有 `schedule` / `cron` / `automation` 关键字。
2. 实测一次 `codex exec --help` 看是否有相关 flag。
3. 若均无：不纳入 v1 派发方候选，延后到 v2 评估。

### 5.4 launchd / cron（通用兜底）

若所有 IDE 派发方都失败，可走系统级路线：

```
~/Library/LaunchAgents/com.agent-flow-ex.dispatcher.plist
└── 每 10 分钟启动一次: <node> <dispatcher.mjs>
```

`dispatcher.mjs`：直接 spawn `dist/server.js` 一次，调 `agent_flow_status`，退出。

**代价**：失去 agent 的 LLM 决策能力（没有 prompt 模板，没有「猜答案」环节）—— 退化为「纯轮询器」。**仅兜底**；v1 已选 WorkBuddy automation，本路线暂不需要。

---

## 6. agent-flow-ex 是否需要新增能力？

按 §2 的「不变量」原则，loop 全部在调度员 prompt 里实现，agent-flow-ex **不必须**改。但有两个**可选**增强值得考虑：

### 6.1 聚合查询（可选，nice-to-have）

**现状**：`agent_flow_status()` 无参返回所有活跃任务，但混在 `queued/running/needs_input` 一个数组里。调度员只关心 needs_input + 超时 running。

**建议**（不阻塞 v1）：

```typescript
// 新工具
agent_flow_list_needs_input(): { task_id, question, rounds, elapsed_sec }[]
```

**收益**：调度员 prompt 更短（不用过滤），单次触发的 LLM token 更省。

### 6.2 双向通知（可选，v3+）

**现状**：飞书是单向（worker → 人）。调度员可通过 store 反查，但延迟 = 调度间隔。

**未来选项**：

- runner 在终态时向 webhook POST 一个「可回调 URL」（含 task_id），调度员在那个 webhook 上监听。
- 或：worker 终态时直接唤醒调度员（实现复杂，涉及 agent 进程模型）。

**建议**：v1 不做；v3+ 真有秒级响应需求再设计。

### 6.3 最小必改：`agent_flow_status` 暴露 `timeout_sec`（已决议）

调度员「孤儿/超时 running 收割」规则「`running 且 elapsed_sec > 2×timeout_sec`」需要 `timeout_sec`（且 per-task 可覆盖，不能用 config 默认值猜——会误杀用大 timeout 提交的健康任务）。实测 `status()` 当前不返回该字段。**决议（Plan Task 2，含 TDD）**：给 `TaskView` 加一行 `timeout_sec` 字段。这是对「几乎 0 改动」的唯一例外，如实记录。

---

## 7. 前置验证清单（按顺序）

| 序号 | 验证项 | 状态 |
| :--- | :--- | :--- |
| V1 | 派发方触发的新会话能否拿到 `agent_flow_*` 工具并成功 `agent_flow_status()`？ | ✅ **已完成**（WorkBuddy automation 21:20 端到端实测：ToolSearch 加载 3 工具 → `status()` 返回 `[]` → idle）。Trae 侧 ❌ 27 tick 仅 1 次成功，根因待定 |
| V2 | 实际触发间隔（10 分钟是否守时）？ | 待 recurring automation 上线后由自然 tick 覆盖 |
| V3 | §4.1 prompt 在调度员会话跑一遍，能否成功调 `agent_flow_status` 无参并返回 idle？ | ✅ **已完成**（同上，run `success=true`） |
| V4 | 制造一个 needs_input 任务，验证调度员自动 `submit(continue_of=)` 续跑成功 | ✅ **已完成**（2026-08-29 21:43，`task_mteffyqz_4af841`：rounds 1→2，`completed`，见 §5.1.4） |
| V5 | 制造一个孤儿 running 任务（kill runner），验证调度员按 `elapsed_sec > 2×timeout_sec` 自动 cancel | ⏸ 待跑 |
| V6 | Trae hooks 是否支持「定时触发器」 | 不纳入 v1 候选；v1 已选 WorkBuddy automation，本项延后 |
| V7 | Codex CLI 是否有自动化机制 | 不纳入 v1 候选；无一手知识，延后 spike |

V1/V3 已完成；V2 随 recurring 上线覆盖；V4/V5 是**真正的验收项**——目前只证明调度员「能跑起来并正确判定空闲」，还没证明「能自动续跑/收割」。V6/V7 不再是 v1 前置门槛。

---

## 8. 风险与限制

| 风险 | 等级 | 缓解 |
| :--- | :--- | :--- |
| 调度员误答开放性问题 | 中 | prompt 强制「猜不到就放弃，让人介入」；人永远有最终否决权（飞书仍推送） |
| 同一任务被多次续跑（race） | 低 | `submit(continue_of=)` 内部原子校验 `status=needs_input`（v2 spec §4.1） |
| automation 触发延迟（分钟级） | 低 | 与现状一致（现状连分钟级自动都没有） |
| 调度员 agent 上下文爆 | 低 | 单次 ≤ 5 任务 + prompt ≤ 1k tokens |
| WorkBuddy automation 跑不通（mcp.json 未加载） | 中 | 退回 launchd 兜底 |
| Codex / Trae 路线 spike 失败 | 低 | 暂不纳入候选，后续 spike |
| 调度员和用户「同时答 needs_input」冲突 | 中 | 「同 task_id 的 needs_input 只能被 submit 一次」，后到的答案直接被 `submit` 拒绝；用户回复优先（用户在会话里调工具时，调度员同时也在调 → 先到先得，输者返错） |

---

## 9. 验收标准

- [ ] V1（派发方选定）完成：Trae Schedule 进程内 MCP 可见性实测通过。
- [ ] 一个 needs_input 任务在无人工干预下被自动续跑并完成；飞书卡片到达。
- [ ] 调度员单次触发的 LLM token 用量实时测取均值并记录（Plan Task 7 汇总）。
- [ ] 端到端延迟由 cron 粒度主导：最坏收敛 = needs_input 轮数 × 10 分钟；单次触发内完成 status 扫描与 submit（不对调度员处理承诺 30 秒级延迟）。
- [ ] 用户随时可通过「我在飞书里直接答 / 回到 IDE 自己调工具」打断调度员的决策；后到者收到明确错误而非覆盖。
- [ ] agent-flow-ex 仅新增一处最小改动：`agent_flow_status` 暴露 `timeout_sec`（§6.3，Plan Task 2）。
- [ ] WorkBuddy / Trae / Codex 任意一家派发方切换时，调度员 prompt 与 agent-flow-ex 实现不动。

---

## 10. 与 v2 spec 的关系

| 维度 | v2 spec | 本 spec（v3 增量） |
| :--- | :--- | :--- |
| 任务模型 | 工单表 + worker | 不变 |
| 通知 | 单向（飞书） | 不变；可选升级（§6.2）留 v4 |
| 派发方 | IDE 内 MCP client | 不变；loop 由派发方自带的「自动化任务」驱动 |
| daemon 化（§11） | guard rails 不满足则不做 | 不变；loop 全部在派发方进程内，agent-flow-ex 无需常驻 |
| Executor 抽象 | claude + opencode | 不变 |
| needs_input 循环 | 人工中继 | **自动中继**（调度员 + 人工兜底） |

---

## 11. 待决问题（评审决议）

1. **V1 派发方选型**：**已改决议（2026-08-29）** = **WorkBuddy automation**（端到端实测通过，见 §5.1.2）。Trae Schedule 降备选、launchd 仅兜底。
   **Trae 回测（5 分钟，未做）**：只把 Schedule `8a989934` 的 `message` 换成带步骤 0 的 §4.1 Prompt 并 `trigger` 一次——通了说明 Trae 也只是延迟加载问题，可迁回；不通再去 UI 开「对话流设置 → 自动运行 MCP」。
   Trae 侧**无需改动**的项：MCP server 配置（`~/Library/Application Support/TRAE SOLO CN/User/mcp.json`，已正确注册 agent-flow-ex）、agent-flow-ex 代码（0 改动）、调度员 prompt 的其余部分。
2. **是否采纳 §6.1「聚合查询」新工具**？**已决议** = v1 不采纳，先让调度员直接消费 `agent_flow_status()`；待 v1 跑通后按需再加。
3. **调度员 prompt 是否需要随 profile 变化**？**已决议** = v1 统一用最终 Prompt（§4.1），不随 profile 变化；调度员用派发方自身 runtime，不强制复用 worker profile。
4. **「调度员误答」的人兜底**：v1 **不**做「取消续跑/人工接管」按钮。人随时可在会话内直接 `agent_flow_submit(continue_of=)` 抢先，原子 `status=needs_input` 保证后到者返回明确错误。
5. **超时/孤儿收割依据**：`agent_flow_status` 新增暴露 `timeout_sec`（§6.3，Plan Task 2）；调度员按「running 且 `elapsed_sec > 2×timeout_sec`」cancel。
6. **是否使用平台的 automation memory（`.workbuddy/automations/<id>/memory.md`）**？**已决议** = v1 不用。调度员状态一律从 store 读，保持「prompt 即规约」与派发方可替换性；引入平台专属记忆会给切换派发方增加隐性依赖。
