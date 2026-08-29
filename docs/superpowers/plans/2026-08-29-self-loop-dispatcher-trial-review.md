# 自循环调度员 · 复盘文档 Review（含 WorkBuddy 派发方实测）

**文档编号**：2026-08-29-self-loop-trial-review
**被评文档**：`2026-08-29-self-loop-dispatcher-trial.md`（Trae 实测复盘）
**评审时间**：2026-08-29 16:00 GMT+8
**评审方式**：代码/配置核对 + **WorkBuddy automation 实跑探针**（非推测）

---

## 1. 一句话结论

复盘文档把 Trae 的失败定性为「平台配置问题，不是 prompt/代码问题」——**这个定性证据不足，且很可能是错的**。WorkBuddy 实测显示：定时触发的**全新会话初始工具列表里同样没有 `agent_flow_*`**（与 Trae 报错同形），但通过 `ToolSearch` + `DeferExecuteTool` **100% 可加载可调用**。因此「工具不可见」更可能是 **prompt 没教 agent 去加载工具**，而非平台玄学配置。这条假设成本极低，复盘里从未验证过，却在 §3.3 被排除掉了。

顺带查出三个未被发现的问题：`src/server.ts` 测试工具**重复注册**（测试模式一开就崩）、`~/.workbuddy/mcp.json` 的 `env` 改动**实际未生效**、以及**复盘「Trae 不存在任何 MCP 配置文件」是事实错误**——真实路径是 `~/Library/Application Support/TRAE SOLO CN/User/mcp.json`（机器上有两个 Trae，复盘搜的是 7/30 已停更的旧版目录）。

另查明：**Trae Schedule 不在本地磁盘**（云端存储），只能走 UI 的 Schedule 工具操作。

---

## 2. WorkBuddy 会不会有相同问题？——实测答案

### 2.1 探针设计

新建一次性 automation（`automation-1787990047742`，2026-08-29 15:57 GMT+8 触发，`cwd` = 项目根），prompt 要求新会话三步自证，结果落盘。探针**未传 `connectorIds`**。

### 2.2 实测结果（原始输出）

| 步骤 | 内容 | 结果 |
| :--- | :--- | :--- |
| 1 | 当前可用工具列表中是否直接存在 `agent_flow_status`？ | **无** |
| 2 | `ToolSearch(tool_names=[mcp__agent-flow-ex__agent_flow_status, ..._submit, ..._cancel])` | **成功，返回 3 个工具 schema** |
| 3 | `DeferExecuteTool(mcp__agent-flow-ex__agent_flow_status, {})` | **成功，返回 `[]`** |

> 探针已删除，结果文件已清理。

### 2.3 判定

| 维度 | Trae Schedule | WorkBuddy automation |
| :--- | :--- | :--- |
| 新会话初始工具列表有 `agent_flow_*` 吗 | **没有**（LLM 报 "No agent_flow_* tools available"） | **没有**（步骤 1 = 无） |
| 能不能拿到 | 27 tick 只有 1 次成功，**机制未知** | **ToolSearch 两步，确定性 100% 成功** |
| 根因 | 未验证（复盘给了 3 条互相竞争的猜测） | 已确认：MCP 工具是 **deferred tools**，需显式加载 |
| 修复手段 | 去 UI 点「自动运行 MCP」（未验证） | **在 prompt 里加一步 ToolSearch**，无需任何外部配置 |

**结论：症状同形，根因不同，WorkBuddy 可解且已实测通过。** `agent-flow-ex` 是 user-level 本地 MCP（`~/.workbuddy/mcp.json`），不是 marketplace connector，实测**不需要配置 `connectorIds`** 即可用——automation 里折腾 connector 是白费功夫。

---

## 3. 复盘文档的问题清单

### 问题 ①（严重）：根因定性越界，"不是 prompt 问题"缺证据

§3.3 写「一站定性：这次失败是平台配置问题，不是调度员 prompt 也不是 agent-flow-ex 代码问题」。

**反驳**：
- Trae 的报错 `No agent_flow_* tools are available in the current toolset` 是 **LLM 的自我陈述**，**不是平台错误码**。它跟 WorkBuddy 探针的「步骤 1 = 无」是**同一种现象**。
- WorkBuddy 证明了：初始不可见 ≠ 不可用。Trae 极可能也是 lazy-load，而调度员 prompt（spec §4.1）从头到尾没写「先加载工具」这一步，agent 于是直接放弃并宣称工具不存在。
- 11:41 那次成功，完全可能是 agent 那一次**碰巧自己试了一下工具**就通了——这与"重启 MCP server 导致失效"的因果链不冲突，但**解释力更强、更简单**（奥卡姆）。

**修正**：把「prompt 未含工具加载步骤」列为与「自动运行 MCP 未开启」并列的**第一优先假设**，且它成本最低。

### 问题 ②（严重）：27 次 tick 的因果链从未做对照实验

§3.3 把失败归因于「注入测试工具 → 重启 MCP server → 改 mcp.json」，但：
- 文档**没有给出 MCP server 重启时刻 vs 各 tick 成败的时间轴对齐**。若"重启后不同步"成立，应呈现「重启前通 / 重启后不通」的清晰断面；现在只有"早期 1 次成功"，无法判定因果。
- 从未做最小对照实验：重启后手动 `trigger` 一次看通不通；或去掉 `env` 再测。

**修正**：补一条时间轴（tick 时刻 × 成败 × MCP server pid 变更时刻）再下结论。

### 问题 ③（严重，事实错误）：「Trae 不存在任何 MCP 配置文件」是错的

复盘 §3.2 第 1 条称「`~/.trae-cn/` 与项目内均不存在任何 MCP 配置文件」。实测核对：

**真实路径是** `~/Library/Application Support/TRAE SOLO CN/User/mcp.json`：

```json
{
  "mcpServers": {
    "agent-flow-ex": {
      "command": "/Users/meow/.nvm/versions/node/v24.18.0/bin/node",
      "args": ["/Users/meow/workspace/agent-flow-ex/dist/server.js"]
    }
  }
}
```

两条关键事实：

1. **本机装了两个 Trae**：`TRAE SOLO CN`（在用，最后活跃 08-29 17:00）与 `Trae CN`（**7/30 起已停更的旧版**）。复盘搜的是 `~/.trae-cn/`，那是**旧版**的 user-data 目录——找错了 app。
2. **这是普通 JSON，可直接编辑，不需要点 UI**。文件 mtime `08-27 07:27`，今天**从未被改动**——再次印证 env 改动打到了 WorkBuddy 的错误路径。

> 补充：`~/.trae-cn/mcps/s_agent-flow-ex-b1bcbfb1/...` 是旧版遗留的 Solo 缓存，与本次无关。

### 问题 ④（中）：`env` 改动"不影响生产路径"的说法不准确，且是隐患

复盘 §5 称「`~/.workbuddy/mcp.json` 的 env 保留（不影响生产路径）」。实测核对：

- 当前运行的 MCP server 进程 `pid 4340`，启动于 `11:57:18`；`ps -E` 检查其环境**没有 `AGENT_FLOW_TEST_MODE`**。
- `~/.workbuddy/mcp.json` 修改于 `11:56`（早于进程启动），却**没生效** → 说明 WorkBuddy 侧真正生效的路由可能是 `~/.workbuddy/.mcp.json` 的 `connector-proxy`（`http://127.0.0.1:62415/mcp`，聚合 agent-flow-ex + agent-mail，修改于 08-28 21:42），**光改 `mcp.json` 无效**。

**即：这个 env 既没帮到 Trae，也没帮到 WorkBuddy——纯无效改动。** 而它的风险是：某次重启一旦生效，就会多注册一个 `agent_flow_set_started_at` 工具（改写任务 `started_at`），污染调度员工具集。

**修正**：回滚 `env`，并把它从"资产"降级为"待清理项"。

### 问题 ⑤（严重，代码）：`agent_flow_set_started_at` 在 server.ts 里重复注册

`src/server.ts:52-62` 与 `src/server.ts:64-74` 是**两段完全相同的 `if (isTestMode()) { server.tool("agent_flow_set_started_at", ...) }`**。

- 后果：一旦 `AGENT_FLOW_TEST_MODE=1` 真正生效，MCP SDK 会因**同名工具重复注册**抛错，**server 启动即崩**——比"多一个工具"严重得多。
- `tests/tools.test.ts:148-170` 只测了 `setStartedAt()` 函数本身，**没有测 server 注册路径**，所以这个重复没被测出来。

**修正**：删掉 `server.ts:64-74` 的重复块。

### 问题 ⑥（中）：探测方法本身有缺陷

§4.3 提出「任何派发方上线前先做探测任务」——**原则正确，这次救了 WorkBuddy 路线**。但原探测只问「能不能调通」，不问「**什么条件下能调通、失败时 agent 表现如何**」。

**修正**：探测清单升级为三项必答：
1. 新会话初始工具列表是否直接可见？
2. 不可见时的加载路径是什么（工具名是否为完整限定名 `mcp__<server>__<tool>`）？
3. 加载后真实调用一次，记录返回值。

### 问题 ⑦（轻）：文档状态与仓库不一致

| 项 | 现状 | 说明 |
| :--- | :--- | :--- |
| `trial.md` | untracked | 未提交 |
| `plan.md` Task 1 Step 6 | checkbox 未勾 | 实际已提交（`41bc69f` 存在） |
| 遗留待办 | 5 项未勾 | 其中 2 项（§4.1 UI 配置）优先级应下调 |

---

## 4. 已核对一致的部分（无异议）

- `agent_flow_status` 暴露 `timeout_sec`：`src/tools/status.ts:11`（接口）+ `:28`（view），测试 `tests/tools.test.ts:113`，commit `211ebd5`。✅ 与文档一致。
- worker 契约（`src/prompt.ts` 第 2/5 条）：commit `41bc69f`。✅
- 调度员最终 Prompt（spec §4.1）：唯一权威源定位正确，「rounds>=3 不代答」「单次 ≤3 个」约束合理。✅
- 「prompt 即规约」「store 即外部记忆」「不扩展协议」三条设计不变量。✅ 本轮派发方切换**确实**没有触发任何逻辑改动，设计经受住了检验。

---

## 5. 修正后的下一步（按成本排序）

### Step 1：清地雷（10 分钟，必做）

1. 删 `src/server.ts:64-74` 重复注册块。
2. 回滚 `~/.workbuddy/mcp.json` 的 `env: { AGENT_FLOW_TEST_MODE: 1 }`。
3. 重启 MCP server 验证 3 个工具正常。

### Step 2：给调度员 Prompt 加 Step 0（关键修复，平台无关版）

在 spec §4.1 最终 Prompt 的「步骤」前插入。**写成平台无关**，因为 Trae 是否也有 `ToolSearch` 未知，不能替它发明 API：

```
0. 工具获取（必做，不可跳过）：agent_flow_* 是 MCP 工具，可能不在你的初始工具列表里。
   禁止仅凭"初始工具列表里看不到"就判定工具不存在——这是本任务最常见的失败模式。
   按序尝试：
   a. 直接调用 agent_flow_status()（不带参数）。成功则继续步骤 1。
   b. 若报"无此工具"，用你可用的工具发现/搜索能力查找含 "agent_flow" 的工具并加载，
      然后重新调用。若你的环境用 ToolSearch，工具全名是
      mcp__agent-flow-ex__agent_flow_status / _submit / _cancel。
   c. 若仍然拿不到，回复「tools unavailable」并列出你尝试过的具体方式，然后结束。
      不要猜测、不要改文件、不要尝试其他替代手段。
```

并加约束：**禁止**在未完成上述尝试前声称「No agent_flow_* tools available」。

### Step 3：Trae 配置在哪（本次查清）

| 配置项 | 位置 | 能否直接改文件 |
| :--- | :--- | :--- |
| **MCP server** | `~/Library/Application Support/TRAE SOLO CN/User/mcp.json` | ✅ **能**，普通 JSON |
| **Schedule `8a989934`** | **不在本地磁盘** | ❌ 只能走 Trae UI 的 `Schedule` 工具 |

「Schedule 不在本地」的证据（全为本次实测）：

- `TRAE SOLO CN/User/globalStorage/state.vscdb`（100 个 key）中无 `schedul|cron|reminder|timer|agent.?flow` 任何匹配
- 同目录 `storage.json`、`Local Storage/leveldb`、`Session Storage`、`IndexedDB` 全目录搜 `8a989934` / `scheduled_task` / `cronExpression` → 无匹配
- 全盘（home）grep `8a989934`：命中的**全是自家副本**——本项目 3 个 md + `~/.workbuddy/traces/*` 与 `artifact-index`（WorkBuddy 读文档时产生的副本）。**Trae 侧零命中**。

→ 结论：Schedule 存**账号侧/云端**，只能经 UI 的 `Schedule`（update / trigger）操作。

（`find` 命中的 `Trae CN/logs/**/tasks.log` 是 VS Code 构建任务日志，且全在已停更的旧版目录里，与 Schedule 无关。）

**因此复盘 §4.1「去 UI 点自动运行 MCP」里，只有开关那一半需要 UI；MCP server 配置这一半直接改文件即可，比点 UI 快且可核对。**

### Step 4：Trae 回测操作清单（需人在 Trae 内执行，约 5 分钟）

不改 MCP 配置、不点任何开关，**只换 prompt**：

1. 在 Trae 里 `Schedule` `action: update`，`scheduled_task_id: 8a989934`，`message` 换成「§4.1 最终 Prompt + Step 2 的 Step 0」全文。
2. `action: trigger` 跑一次。
3. 看结果：
   - **通了**（能 `agent_flow_status()`）→ Trae 也是延迟加载问题，v1 首选**原地复活**，WorkBuddy 继续当备选。
   - **仍报 tools unavailable** → 再去做 UI「自动运行 MCP」开关。

这个顺序比"先去点开关"信息量高一个量级：点开关即使生效，你也**无法区分**是开关起作用还是 Trae 重启起作用。

### Step 5：续跑 Task 4/5 验收

V4（needs_input 自动续跑）、V5（孤儿收割）在当前 prompt 下重跑。V5 若不想等 2×timeout_sec，再用测试工具（Step 1 修好后再开 `env`）。

---

## 6. 执行记录与遗留待办

### 已完成（2026-08-29 21:00）

- [x] `src/server.ts` 删除重复注册 + 补「注册路径」回归测试 → commit `6d25e1d`
- [x] 回滚 `~/.workbuddy/mcp.json` 的 `env` → 已清；MCP server 已重启（新 pid `44170`，`ps -E` 确认环境无 `AGENT_FLOW_*`，工具集 = 3 个）
- [x] 提交 `trial.md` 与本文档 → commit `a200254`

### 待办

- [ ] spec §4.1 最终 Prompt 加入 Step 0（工具获取，平台无关版）
- [ ] **Trae 回测**：`Schedule update` 换 prompt → `trigger` 一次（人在 Trae UI 内执行）
- [ ] 建 WorkBuddy automation 调度员（RRULE 粒度实测）
- [ ] 续跑 Task 4/5 验收
- [ ] 修正 spec/trial 中的 Trae MCP 配置路径：`~/Library/Application Support/TRAE SOLO CN/User/mcp.json`（非 `~/.trae-cn/`）
- [ ] 集成测试 baseline 复跑（沙盒 PATH 缺 `node`，非本任务问题）
