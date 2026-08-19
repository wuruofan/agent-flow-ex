# AgentSession 中间层 + afe daemon 设计

> 状态：草稿，待评审
> 日期：2026-08-18
> 范围：路线 A —— daemon + `AgentSession` 抽象 + 双适配器（opencode 走 serve、claude 走每轮进程）。**不含** claude 长连 / ask 支持（另行评估）。
> 修订：2026-08-19 据评审修订——session_id 持久化、崩溃恢复方案、`needs_input` 检测来源、`--verbose`、RPC 降级为 SQLite 轮询、空闲回收约束、类型/工具迁移标注。

## 1. 背景与动机

v1（当前）架构：

```
MCP server（无状态薄层） --spawn(detached)--> runner（每任务每轮一个进程） --spawn--> agent CLI
        |                                 |                                    |
        +---- SQLite（唯一真相源）<--------+---- 事件解析 / 落库 / 通知 ----------+
```

痛点（均为事实，来自 v1 落地）：
- **每轮 spawn 一个 runner 进程** + 从日志文件 `user_prompt` 行读续跑输入（`readRoundInput`），编排有冷启动和文件间接。
- 任务与 agent 会话的关系散落（SQLite + 日志 + 进程组），无统一的"会话句柄"。
- 无双向控制通道：`needs_input` 只能靠「文本通道 + 续跑」迂回（prompt 契约已禁用 ask 工具）。
- cancel/超时依赖进程组 kill（`kill(-pid)`），游离进程管理成本高。

**方向**：afe 增加常驻 `daemon`（编排进程）+ `AgentSession` 抽象（会话级句柄），把「会话」提升为一等公民，统一事件流与控制通道。

## 2. 设计目标与分层收益（关键事实依据）

daemon 化的收益**分层**，取决于底层 agent 是否有 server 模式：

| 底层 agent | 是否有 server 模式（已核实） | daemon 化收益 |
|---|---|---|
| opencode | **有** `opencode serve` 子命令（常驻进程 + REST + SSE + 权限/问题双向回填方向） | **真正熵减（目标）**：内存持会话、续跑无冷启动、控制平面统一（HTTP 回填 question/permission）。⚠️ 此收益依赖 opencode serve **协议细节**（端点 `/session/:id/prompt`、`/event`、`/permission`、`/question` 与事件形态），**尚未实证**，见 §9；表格"有 serve 模式"仅指存在 serve 子命令，不等同协议已校准 |
| claude | **无**（`claude --help` 无 serve；`-p` 一次性，进程即开即走） | **仅编排层熵减**：runner 常驻、session 注册表、统一事件解析；会话持久化仍靠 claude 自身磁盘 + `--resume` |

结论：`AgentSession` 抽象面向**会话级句柄 + 事件流 + 控制回填**，底层两条适配器实现不同、上层认知一致。

## 3. 目标架构

```
MCP server（无状态薄层：submit/status/cancel/answer）
        |
        |  SQLite 轮询（daemon 监听变化驱动，见 §8；不引入 RPC）
        v
afe daemon（常驻编排进程）
  ├── TaskScheduler：认领任务、驱动状态机、超时/轮次
  ├── SessionRegistry：task -> AgentSession 句柄（内存索引，SQLite 仍为真相源）
  ├── EventDispatcher：统一事件 -> 落库/通知/控制请求
  └── Adapters：
       ├── OpenCodeServeAdapter（per-project serve 实例池）
       └── ClaudeProcessAdapter（每轮 spawn claude -p --resume）
        |
        v
   agent（opencode serve / claude CLI）
```

不变项：
- **SQLite 仍是唯一真相源**，状态流转仍用原子 UPDATE（`WHERE status IN (期望态)`）。
- MCP server 仍是无状态薄层，不持有会话状态。
- **底层 sessionID 必须落盘**：适配器在会话建立 / 首轮事件拿到底层 sessionID 后，立即写回 `tasks.session_id`（复用 v1 `runner.ts:92` 已有列与逻辑）。SessionRegistry 仅为内存索引；daemon 重启 / 崩溃后据此 `--resume`（claude）或重 attach（opencode serve）恢复会话，详见 §9。

## 4. AgentSession 抽象

### 4.1 事件模型（统一）

```typescript
type AgentEvent =
  | { type: "session"; sessionId: string }                    // 会话建立/续跑
  | { type: "assistant_text"; text: string }                  // 增量/整段文本
  | { type: "tool_use"; name: string; file?: string | null }  // 工具调用（进度）
  | { type: "needs_input"; question: string }                 // 文本阻塞（claude 文本通道 / opencode 文本）
  | { type: "permission_request"; id: string; permission: string; metadata?: unknown } // opencode 专用
  | { type: "question_request"; id: string; question: string; options?: unknown }      // opencode 专用
  | { type: "result"; text: string; isError: boolean; subtype?: string };
```

> **注意（评审修订）**：
> 1. `needs_input` 来源差异——opencode 可来自结构化 `question_request` 或文本通道；**claude 无原生 `needs_input` 事件**，由 `prompt.ts` 的 `❓NEEDS_INPUT:` 包装契约 + `extractNeedsInput()` 对最终文本启发式判定（`runner.ts:112`），claude 适配器必须复用该契约与检测，而非依赖 executor 产出此事件。
> 2. opencode 优先走结构化 `question_request`；文本 `needs_input` 仅作 claude 兼容回退，二者由适配器按来源判定、不并发现同义事件。
> 3. 本 `AgentEvent` 与 `executors/types.ts` 现有扁平可选字段形态（`assistantText`/`toolUse`/…）不一致；迁移需改写 `parseEvent` 输出或加映射层（见 §10）。

### 4.2 会话句柄

```typescript
interface AgentSession {
  readonly id: string;                 // afe 侧会话 ID（绑定 task_id）
  readonly agentSessionId?: string;    // 底层 agent 侧 session id（claude session_id / opencode sessionID）

  /** 发送一条用户消息并进入流式执行（首轮 = 任务 prompt；续跑 = Trae 答复） */
  send(message: string): AsyncIterable<AgentEvent>;

  /** 控制回填：答问题（opencode question），返回 false 表示该请求已过期或本适配器不支持（claude = 不支持，见 supportsControlCallbacks） */
  answerQuestion(requestId: string, answers: string[]): Promise<boolean>;

  /** 控制回填：批权限（opencode permission） */
  replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<boolean>;

  /** 中止本次执行 */
  abort(): Promise<void>;

  /** 释放资源（结束进程/关闭连接） */
  close(): Promise<void>;
}

interface AgentSessionAdapter {
  readonly kind: "opencode-serve" | "claude-process";
  /** claude-process = false（无权限/问题 HTTP 回调）；opencode-serve = true。调用方应先判此位再调 answerQuestion/replyPermission，避免 claude 路径误判"已过期"。 */
  readonly supportsControlCallbacks: boolean;
  createSession(task: Task): Promise<AgentSession>;
}
```

### 4.3 适配器职责边界

- **opencode-serve**：`createSession` 从 per-project serve 实例池取实例（无则拉起 `opencode serve`），`send` 走 `POST /session/:id/prompt`（流式 JSON）+ `/event` SSE 订阅；`permission_request`/`question_request` 从 SSE/事件流提取，回填走 `/permission`、`/question`。sessionID 从 `step_start`/事件里取，续跑用同一 sessionID。
- **claude-process**：`createSession` 只登记句柄（session_id 从首轮 `system.init` 事件提取）；`send` 每轮 spawn `claude -p --output-format stream-json --verbose --resume <sid>`（round 1 无 resume；**`--verbose` 不可省**，否则只拿到最终 result、无流式 assistant/tool_use 事件，与 v1 `claude.ts:9` 一致），事件解析复用现有 `claudeExecutor.parseEvent`。**无** permission/question 回填；`needs_input` 走文本通道，由 `extractNeedsInput()` 在最终文本上判定（见 §4.1 注意）。

## 5. 状态机变更

任务状态机（`queued/running/needs_input/completed/failed/cancelled`）**保持不变**。变更点：

- `needs_input` 语义不变，但**续跑不再 spawn detached runner 进程**：daemon 在 `SessionRegistry` 内直接对同一句柄 `send(Trae 答复)`，`rounds+1`。注意 claude 路径 `send` 内部仍由 daemon spawn 新 `claude -p --resume` 进程，只是不再经过 v1 的 detached runner 包装。
- 新增控制请求生命周期（opencode 路径，daemon 内存态）：`pending -> answered/rejected`，任务停留在 `running`，不改变任务状态（权限/问题属于会话内部阻塞，由 agent 自身等待回填）。
- `needs_input`（claude 文本通道）仍映射任务状态，因为 Trae 需要外部介入。

## 6. daemon 生命周期

- 启动：读取 config、打开 SQLite、按需拉起 opencode serve 实例；daemon 通过 SQLite 轮询驱动（不引入 RPC，见 §8）。
- 任务驱动：MCP server `submit` 落库 `queued` → daemon 监听 SQLite 变化认领（见 §8）→ daemon 认领 `queued -> running` → 取/建适配器会话 → `send`。
- 续跑闭环：`needs_input`（文本）→ 落库 + 飞书通知 → Trae 调 `answer`（新增 MCP 工具，语义等价于 v1 的 `submit(continue_of=task_id)`；底层写 SQLite 由 daemon 轮询驱动，**不引入 RPC**，见 §8）→ daemon `send(答复)` → 续跑同会话。
- 控制回填闭环（opencode）：`permission_request`/`question_request` 落库（pending）→ 通知 → Trae 回填 → `replyPermission`/`answerQuestion` → agent 继续。
- 空闲回收：opencode serve 实例按 project 池化，**仅当该项目下所有 session 均进入终态时才允许空闲超时关闭**；任务处于 `running`（等 permission/question 回填）或 `needs_input`（等人工）时不得关闭实例，否则内存会话丢失、续跑/回填全部失效。claude 进程每轮即走，无回收问题。

## 7. 双适配器差异汇总

| 维度 | opencode-serve | claude-process |
|---|---|---|
| 进程模型 | 常驻 serve（per-project，池化） | 每轮 `claude -p` 新进程 |
| 会话续跑 | serve 内存持会话，续跑无冷启动 | `--resume <sid>` 重新加载磁盘会话 |
| 事件来源 | SSE `/event` + prompt 流式响应 | stdout stream-json |
| 双向控制 | permission / question HTTP 回填 | 无（文本 needs_input 通道） |
| sessionID 来源 | 事件内 `sessionID` | `system.init` 的 `session_id` |
| 适配器风险 | serve 协议需实证校准（见 §9） | 复用已实证的 executor 解析 + 须迁入 `extractNeedsInput` 文本契约（见 §4.1 注意） |

## 8. 待确认决策

- [x] **daemon 与 MCP server 通信方式（已定）**：**先纯 SQLite 契约（daemon 监听变化/轮询）**，`submit`/`answer` 均落库驱动，RPC 低延迟通知作为后续优化（YAGNI，暂不引入第二套传输）。SQLite 仍为唯一真相源。这样 `answer` 与 `submit` 同构、均经 SQLite，避免 RPC/SQLite 双轨的维护与故障面。
- [ ] **opencode serve 实例粒度**：已核实 serve 单 workspace（`WorkspaceRouterMiddleware` 默认 `process.cwd()`），故 per-project 池化；是否复用 `x-opencode-directory` header 单实例多目录？——待 serve 协议实证后定。
- [ ] 任务轮次上限（现 `MAX_ROUNDS=5`）是否保留。

## 9. 待实证风险点

- [ ] opencode serve 的 `/event` SSE 事件形态与 `prompt` 流式响应结构（现状 `opencode.ts` 基于推断，标注过 ⚠️，需真实样本校准）。
- [ ] opencode serve 单进程多 session 并发隔离性（内存持会话是否互相干扰）。
- [ ] claude 并发任务访问**同一** session 的锁行为（待实测；不同 session 并发无碍）。
- [x] **daemon 崩溃后的任务回收（已定方案）**：daemon 重启 → 扫描 `running`/`needs_input` 任务 → 凭 `tasks.session_id` 重连：
  - claude：新 spawn `claude -p --resume <sid>` 续跑（磁盘会话仍在）。
  - opencode-serve：serve 为独立进程、通常不随 daemon 崩；daemon 重 attach 该实例、按 sessionID 取回未完成会话继续驱动。
  - **pending 控制请求（daemon 内存态）丢失后的逃生**：opencode 路径若 daemon 崩于 question/permission 等待中，serve 会话可能卡死；需提供"拒绝/跳过该 question"的兜底（serve 侧超时或显式 abandon 接口），否则孤儿会话无法回收。此兜底接口待 serve 协议实证后定（见 §2 注）。

## 10. 与 v1 的关系

- v1 的 `runner.ts` 执行逻辑（事件解析、落库、超时、finalize）迁移进 daemon 的 TaskScheduler + EventDispatcher；`executors/claude.ts` 复用为 claude 适配器的事件解析。
- `opencode.ts` executor 的 buildCommand 将被 opencode-serve 适配器取代（`opencode run` 一次性 CLI 不再用于 daemon 路径；保留与否取决于 serve 协议实证结果）。
- `executors/types.ts` 的 `AgentEvent` 扁平形态需升级为 §4.1 区分联合（或加映射层），`parseEvent` 输出随之调整；现有 `claudeExecutor.parseEvent` 不产出 `needs_input`，迁移时须一并迁入 `prompt.ts` 的 `extractNeedsInput` 契约。
- `server.ts` 当前仅注册 `submit`/`status`/`cancel`，**无 `answer` 工具**；路线 A 需新增 `answer`（语义等价于 `submit(continue_of)`），与 §8 的纯 SQLite 驱动一致。
- 不破坏 v1 既有测试目标；迁移按功能等价推进。
