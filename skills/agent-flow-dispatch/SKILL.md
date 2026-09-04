---
name: agent-flow-dispatch
description: 通过 agent-flow-ex MCP server（agent_flow_submit / agent_flow_status / agent_flow_cancel）把编码任务派发给后台 worker agent（claude/opencode）执行。当用户想「派个任务给 claude 后台跑」「把 X 丢给 worker 做」「dispatch a task to the worker agent」「agent-flow 派活」「后台任务跑完了没」时使用本 skill。用户希望任务不阻塞当前对话、由独立 runner 进程在指定项目目录里干活、终态推飞书通知的场景都适用。在派发前先用本 skill 的规范拼出自包含的任务 prompt（worker 不共享会话上下文），并遵守同目录不并发、needs_input 续跑等约束。
agent_created: true
---

# Agent Flow Dispatch

## Overview

通过 agent-flow-ex 的 MCP 工具把编码任务派发给**独立后台 worker**（真实 `claude` / `opencode` CLI，detached 子进程），立即返回 `task_id`、不阻塞当前对话；任务终态（完成/失败/取消）自动推飞书，无需轮询。worker 在指定 `project_path` 目录下工作，**不共享当前会话的任何上下文**。

**何时用**：用户想把一项编码任务交给后台 agent 执行（如"把 X 项目这个功能做了""让 claude 后台跑个任务""派活给 worker"）。**何时不用**：任务需要当前会话上下文才能完成、需要与用户实时交互、或用户只是想讨论方案——直接在当前会话做，不要派发。

## 铁律（违反会导致踩文件 / 丢上下文 / 误操作）

1. **prompt 必须自包含**：worker 看不到本会话内容。prompt 里必须写全：任务目标、项目路径、相关文件路径与现状事实、技术栈/约束、验收标准、Git 纪律、交付物格式。缺上下文 = worker 瞎猜 = 返工。
2. **同一 `project_path` 禁止并发**：多个任务写同一目录会互相踩文件。派发前先查活跃任务；同目录已有 running/queued 任务时必须串行（等它终态）或换目录，或向用户确认。
3. **worker 不做会话外动作**：默认在 prompt 中指示 worker **不要 git commit / push / 发通知**，只改文件并汇报变更摘要——除非用户在任务里显式授权。worker 以 `--dangerously-skip-permissions` 运行，没有二次确认。
4. **不轮询**：任务提交后返回 `task_id` 即结束本轮；终态会推飞书。只在用户主动问进度、或收到飞书/需要续跑时再查 `agent_flow_status`。

## 前置检查（Preflight）

调用工具前确认：

- MCP server 可用：工具名 `agent_flow_submit` / `agent_flow_status` / `agent_flow_cancel`（WorkBuddy 中可能带前缀如 `mcp__agent-flow-ex__*`）。若工具不可用，先检查 `~/.workbuddy/mcp.json` 注册与 `agent-flow-ex/dist/server.js` 是否已 build，**不要**尝试用其他方式派发。
- 需要 worker 干活的机器上 `project_path` 存在且可写；executor 的 agent CLI 已配置（`$AGENT_FLOW_HOME/config.json`，默认 `$HOME/.agent-flow-ex/config.json`）。运行时密钥在 `$HOME/.agent-flow-ex/.env`，**不要**在 prompt/参数里写任何密钥。
- 飞书通知 `dry_run` 状态：`config.json` 中 `notify.dry_run=false` 时终态会**真发飞书**；首次验证链路可先确认该配置。

## Workflow

### Step 1 — 并发检查

调用 `agent_flow_status`（不带 `task_id`）列出活跃任务。若存在 running/queued 任务且与本次 `project_path` 相同 → 遵守铁律 2：等待终态、换目录或向用户确认。不同目录的任务可并行，不受影响。

### Step 2 — 拼自包含 prompt

按 `references/prompt-templates.md` 的模板拼装，核心字段：

| 字段 | 说明 |
|---|---|
| Mission | 一句话目标（做/修/查什么） |
| Context | 项目路径、技术栈、相关文件绝对路径、现状事实（关键！worker 看不到会话） |
| Constraints | 允许/禁止改动范围、遵循的规范（如 commit 风格、目录约定） |
| Acceptance criteria | 可验证的编号验收清单 |
| Git discipline | 默认"不 commit/push，只改文件并输出变更摘要"；用户授权才放宽 |
| Deliverables | worker 最终要交什么（摘要/文件清单/测试结果），以文字汇报给调度方 |

#### 派发前自检清单（来自 9/3 真实任务演进）

不要把"能查的"丢给 worker 自己去查——调度方事前查清能让 prompt 字数翻 3-5 倍但 worker 跑得更快、token 用得更省。派发前对照下面 6 项自查，每项**写进 Context** 而不是口头交代：

1. **项目路径 + 技术栈 + 构建/测试命令**：从仓库根 `package.json` / `AGENTS.md` / `README.md` 现拿，不要凭印象。
2. **必读文档**：项目内 spec/plan/调试文档（如 `docs/superpowers/plans/xxx.md`、`docs/debug/yyy.md`）的**绝对路径**——worker 自己 `find` 可能错过。
3. **已跑过的命令与结果**：你（或前序 worker）已经做过的"事实"——如"`bun --version` 输出 1.4.0"、"已 grep 确认 render-node-to-output.ts 双改动共存"、"前序 worker 在 5 次采样中测得 CPU 53%"。**标注来源**（"由调度方已确证 / 由前序 task_xxx result 第 §Y 节确认"）。
4. **已 grep / 已 cat 过的嫌疑代码行号**：如"`use-selection.ts:116/136 setter 在 127/143 行`"。worker 不用再排查，直接读这些行号就能动手。
5. **已知失败模式 / 排除路径**：如"8-26 文档 §1.6 记载 `--parallel=2` 158s/12 fail 兜底基线"、"已确认不是 `mock.module()` 污染"。让 worker 不要重走已排除的路。
6. **环境陷阱**：机器上并存多个版本（双 bun、双 claude、双 node）、用户的预存在 dev 进程、PATH 注入要求——这些 worker 会踩。

只补必要的，不要把整份调查文档贴进 prompt——worker 会看花眼。**原则：调度方查事实，worker 执行策略**。

### Step 3 — Submit

调用 `agent_flow_submit`，参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | Step 2 拼好的自包含任务工单 |
| `project_path` | 建议恒填 | worker 工作目录；缺省是 MCP server 的 cwd，**不要依赖缺省** |
| `profile` | | 运行 profile 名；缺省 `defaults.profile`（当前为 `default`） |
| `timeout_sec` | | 单轮超时秒数；缺省 3600 |
| `continue_of` | | 仅续跑 `needs_input` 任务时填目标 `task_id`，此时 `prompt` 填对该任务问题的答复 |

返回 `{ task_id, status, rounds }` 或 `{ error }`。

### Step 4 — 提交后

派发后立即把 `task_id` 与任务摘要报给用户，结束本轮。**不轮询、不主动 status**——终态会推飞书唤醒。

**收到飞书终态卡后的核验流程（防假阳性约定）**：worker 报告**默认不完全采信**。按 `references/confidence-check.md` 走 5 问核对（worker 自报的数字/路径/行号每条能否定位到证据；不能定位即标低置信度）+ 置信度三档（高/中/低）分级。低/中 → 走 `agent_flow_status({ task_id })` 拉完整 result 复核；不能闭环 → `agent_flow_submit({ continue_of, prompt: <反问> })` 走 needs_input 反问或 `agent_flow_cancel` 重派。**不要把"看起来完成"的报告直接转给用户**。

### Step 5 — needs_input 续跑

`agent_flow_status` 显示 `status: "needs_input"` 时，返回里有 `question`（worker 的问题）。把问题连同可选项呈现给用户 → 用户给答案后，用 `agent_flow_submit({ continue_of: <task_id>, prompt: <答案> })` 续跑（同一任务最多 5 轮）。答案 prompt 要完整自包含，worker 会带着原上下文继续。

### Step 6 — 取消

任务卡死/派错时：`agent_flow_cancel({ task_id })`。running 任务会 SIGTERM 级联杀进程组；已终态任务幂等返回当前状态。

## 状态机速查

```
queued → running → needs_input →(continue_of)→ running →(≤5 轮)→ completed | failed
                          └───────────────────────────┘
cancelled ← 任意非终态可取消
```

## 排错

| 现象 | 处理 |
|---|---|
| 工具不存在 / MCP 未连 | 检查 `~/.workbuddy/mcp.json` 与 `dist/server.js` 是否 build；重启后重试 |
| 任务 `failed`，`error: failed to spawn runner … ENOENT` | executor `bin` 解析失败（裸名 + PATH 找不到）→ 改 `config.json` 为绝对路径 |
| 飞书不推送 | `notify.dry_run` 还是 `true`；或 `FEISHU_WEBHOOK_URL` 不在 `.env` / server 环境 |
| `{env:VAR}` 报 not found | 对应密钥缺在 `$HOME/.agent-flow-ex/.env`，补上后重启 MCP server |

## Resources

- `references/prompt-templates.md` — 派发工单 / needs_input 答复 / 只读评审 三类提示词模板。
- `references/confidence-check.md` — 收到 worker 终态报告后的防假阳性 5 问 + 置信度三档分级。
