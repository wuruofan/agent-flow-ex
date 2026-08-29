# Trae 调度员回测操作手册

**用途**：给在 Trae 里手动执行的人照着做。预计 5–10 分钟。
**前置结论**：WorkBuddy 路线已全绿（V1–V5），所以这次回测**不是救火**，而是决定「要不要从 60 分钟粒度换回 10 分钟粒度」。

---

## 0. 为什么值得做

| | WorkBuddy（已验证） | Trae（待回测） |
| :--- | :--- | :--- |
| 派发粒度 | **1 小时**（`MINUTELY` 不支持，`BYMINUTE` 被静默忽略） | **10 分钟**（内置 cron） |
| 最坏收敛 | 轮数 × 60 分钟 | 轮数 × 10 分钟 |
| 可靠性 | ✅ 实测通过 | ❓ 27 tick 只成功 1 次，原因待定 |

**Trae 若能跑通，是 6 倍的延迟优势**，值得花这 5 分钟验证。

---

## 1. 本地已核对、无需你改的项

别浪费时间在这些上面，我都查过了：

| 项 | 状态 |
| :--- | :--- |
| MCP server 配置 `~/Library/Application Support/TRAE SOLO CN/User/mcp.json` | ✅ 已正确注册 agent-flow-ex，**不用动** |
| agent-flow-ex 代码 | ✅ 0 改动 |
| 调度员 prompt 除「步骤 0」外的部分 | ✅ 与 WorkBuddy 完全一致 |
| Schedule 的本地文件 | ❌ **不存在**——Schedule 存云端，全盘搜 `8a989934` 无任何痕迹，只能走 UI |

> 注意：本机装了两个 Trae。`TRAE SOLO CN` 是在用的；`Trae CN`（`~/.trae-cn/`）7/30 起已停更，别在那边找。

---

## 2. 操作步骤

### Step 1 · 确认 Schedule 还在不在（1 分钟）

在 Trae 里列出现有 Schedule，找 `8a989934`（`agent-flow 调度员`）：

- **还在、且是 Paused** → 直接 Step 2
- **还在、且是 Active** → 先 Pause，再 Step 2（避免改 message 期间它自己触发）
- **已经不在了** → 新建一个：
  - `name`：`agent-flow 调度员`
  - `cron_expression`：`*/10 * * * *`
  - `timezone`：`Asia/Shanghai`
  - `message`：Step 2 的全文

### Step 2 · 把 message 换成下面这段（务必整段替换）

关键点在**步骤 0**。旧版 prompt 少了这一步——这正是疑似失败原因。

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

最后用一句话报告本轮结果（idle / 处理了哪些 task_id / tools unavailable），不要写任何文件。
```

### Step 3 · trigger 一次，然后看**它说了什么**

判定不看「成功/失败」，看**调度员报告的具体内容**：

| 报告内容 | 结论 | 下一步 |
| :--- | :--- | :--- |
| `idle` / 列出了活跃任务 | ✅ **Trae 复活** | Step 4 |
| `tools unavailable` + 列出尝试过的方式 | ❌ 步骤 0 三分支都走不通 | Step 5 |
| 直接说「No agent_flow_* tools available」且**没提尝试过什么** | ❌ prompt 没生效 | 检查 message 是否整段替换成功 |

> **「没提尝试过什么」是重要信号**：说明步骤 0 根本没被执行（message 没换成功），而不是平台问题。

### Step 4 · 成功 → 迁回 Trae

1. 让 Schedule 保持 Active，观察 2–3 个自然 tick（20–30 分钟），确认守时。
2. 确认无问题后，**暂停 WorkBuddy 的 `automation-1788012019991`**（保留配置，作为已验证的备用）。
3. 更新 spec §3 / §5 / §11：派发方改回 Trae，WorkBuddy 降为备选。

### Step 5 · 失败 → 开「自动运行 MCP」

1. Trae **设置 → 对话流（Work）→ 自动运行 MCP**，打开。
2. 重启 Trae（让 MCP server 重新加载）。
3. 再 `trigger` 一次。
   - 通了 → 走 Step 4
   - 仍不通 → **Trae 出局**，保持 WorkBuddy 现状（1 小时粒度，但已验证可靠），把结论补进 spec。

---

## 3. 回测时要注意的两件事

1. **不要先去点「自动运行 MCP」开关**。先换 prompt trigger 一次——这样才能分清是「prompt 缺步骤 0」还是「平台不给工具」。先点开关的话，即使生效你也分不清是开关起作用还是 Trae 重启起作用，信息量为零。
2. **WorkBuddy 的调度员此时仍在运行**（整点触发）。回测期间两边会同时扫任务，但 `submit(continue_of=)` 有原子校验，先到先得、后到返错，不会互相踩坏——不过为了避免结果混淆，回测时最好让 WorkBuddy 那边暂时 Paused。

---

## 4. 结果回填

回测完请把结论写进 spec（`docs/superpowers/specs/2026-08-29-self-loop-design.md`）：

- §3 派发方能力矩阵：Trae 行的「进程内 MCP 可见性」
- §7 V2：10 分钟粒度是否守时
- §11.1：派发方最终选型
