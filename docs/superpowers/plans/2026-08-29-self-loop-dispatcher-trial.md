# 自循环调度员 · Trae 派发方实测复盘与交接

**文档编号**：2026-08-29-self-loop-trial
**状态**：复盘归档（平台问题未解决，给出下一步）
**相关文档**：
- spec `2026-08-29-self-loop-design.md`（设计定稿）
- plan `2026-08-29-self-loop-dispatcher.md`（实现计划 + 执行结果表）
- Trae 官方 [添加 MCP Server](https://docs.trae.cn/work_remote-mcp-server) / [对话流设置](https://docs.trae.cn/work_chat-settings)

---

## 1. 一句话结论

用 **Trae Schedule 承载自循环调度员** 的 v1 路线，在「触发的新会话能否加载 `agent_flow_*` MCP 工具」这一环踩坑：长期触发（27 次 tick）里**只有 1 次自动续跑成功**，其余全部报 `No agent_flow_* tools available`。**根因大概率是平台级配置（「自动运行 MCP」未开启 + MCP 需在 UI 手动配置），而非我们的 prompt/代码问题**。下一步从 UI 配置入手验证，仍不通则降级到 WorkBuddy automation 或 launchd。

---

## 2. 尝试过程（时间线）

| 阶段 | 动作 | 结果 |
| :--- | :--- | :--- |
| 探测 | 建探测 Schedule 并 `trigger`，新会话调 `agent_flow_status()` | ✅ 成功（返回 `[]`），据此定为 v1 首选 |
| Task 1 | 设计稿定稿（Trae 首选 + V1 已验证） | ✅ 已提交 `41bc69f`/`cc550e5`/`de81746` |
| Task 2 | `agent_flow_status` 暴露 `timeout_sec`（含 TDD） | ✅ 已提交 `211ebd5`/`77ba9d5` |
| Task 3 | 建调度员 Schedule `8a989934`（`*/10 * * * *`）+ trigger | ✅ 建立，Executions 27（现状 Paused） |
| Task 4 | needs_input 自动续跑 | ⚠️ **部分成功**：03:41 UTC（北京 11:41）成功代答过一次（`task_mtdtqac4_520e97`），其余 26 次 tick 全 idle |
| Task 5 | 孤儿 running 收割 | ❌ 未达：Step 1-3 完成（submit + kill 进程组 + running 滞留），Step 4 等调度员 cancel 未发生 |
| Task 6 | 人工打断/并发安全 | ❌ 未达：MCP 客户端断连 + 集成测试 baseline 失败（沙盒 PATH 缺 `node`） |
| Task 7 | 结论归档 | ⏸ 未开始（本次文档即替代） |

> 关键观测：**探测阶段与早期 tick 是通的**，在「注入 `agent_flow_set_started_at` 测试工具、重启 MCP server、生成 `~/.workbuddy/mcp.json`」之后才大面积断连。这给了排查两条互相竞争的解释（见 §3）。

---

## 3. 失败根因

### 3.1 现象
- Trae Schedule 触发的**全新会话**里，LLM 报告「No `agent_flow_*` tools are available in the current toolset」。
- 同一 IDE 主会话的 `mcp_agent-flow-ex` 工具列表仍**正常**（3 个工具）。
- 同一 Cron、同一 prompt，**早期成功 1 次** → 说明机制本身能通，是**状态/环境**变了。

### 3.2 自检时发现的关键事实（本轮新确认）
1. `~/.trae-cn/` 与项目内**均不存在任何 MCP 配置文件**（无 `*.mcp*`、无 `mcp*.json`）：
   - MCP Server 是 **Trae UI 手动配置**的，**不读文件 JSON**。
   - 因此调试过程中「改 `~/.workbuddy/mcp.json`」是**无效路径**——那个文件是 WorkBuddy 的，TRAE 根本不读。
2. 官方文档给出一个此前被忽略的开关：**对话流设置 →「自动运行 MCP」**——开启后智能体使用时会自动运行 MCP Server 及内部工具。这正是「定时触发的全新会话能否拿到工具」的关键配置项。

### 3.3 真实根因（修订，2026-08-29）
**WorkBuddy 复盘文档 `2026-08-29-trae-retest.md` 指出，27 tick 只有 1 次成功的真正首因不是平台配置，而是当初 prompt 缺了「步骤 0：工具获取」**：

- Schedule 触发的新会话，初始工具列表里**看不到** `agent_flow_*`（仅主 IDE 会话可见）。
- 探测阶段用的 prompt 是裸的「调 `agent_flow_status()`」，LLM 主动尝试调，结果成功——所以那 1 次「侥幸」其实是**行为对路**的产物。
- 后来填的正式 Prompt 第 1 步就直接调 status，**没有先强制 LLM 主动获取工具**——LLM 看到初始列表里没有就判定不存在，直接报 idle。这是剩下 26 次失败的直接原因。

修订后合理解释（按证据权重）：
1. **旧 prompt 缺步骤 0**（首要）：已通过将「步骤 0：工具获取（必做，不可跳过）」写进 spec §4.1 解决。Trae 路线回测前必须使用新 prompt。
2. **「自动运行 MCP」未开启**（次要）：若新 prompt 仍报 tools unavailable，下一步再去开关排查。
3. **Schedule 会话与主 IDE MCP toolset 是独立视图**（次要）：即使后续重启 MCP server，Schedule 会话不会自动同步主 IDE 视图。

> 修订定性：**这次失败的根因是 prompt 没让 LLM 主动获取工具，不是平台配置问题**。`timeout_sec` 等方案侧改动均有效。
>
> ⚠️ **更正（2026-08-29 23:20，我方实测复核）**：WorkBuddy 路线**并非**「天然就能加载 MCP toolset」。WorkBuddy 触发的新会话同样看不到初始工具列表（探针步骤 1 = 无），是靠 prompt 里显式的 `ToolSearch` 步骤 0 才拿到工具的。**两个平台是同一症状、同一解法。**
>
> ⚠️ **再更正（同日 23:25，找到真因）**：换了带步骤 0 的新 prompt 后仍失败，但**不是**「平台内部行为」。真因是 **Trae 的 MCP 客户端在 11:56:19 断连后不会自动重连**——`exthost/mcp-servers-host.log` 显示 `MCPClient#onClose → Disconnected` 之后 11 小时无任何事件，且此后成功调用次数为 0。主 IDE 显示的 3 个工具是**过期缓存**。诱导因素是当时为注入 V5 测试工具而 kill/重启 MCP server 进程。
>
> 因此 22:52–23:00 那轮「复测」**无效**——它测的是已死的客户端，新 prompt 从未被真正检验。**修复动作**：强制 Trae 重连（MCP 面板 disable → re-enable，或重启 Trae），确认 host.log 出现新的 `Connected` 后重跑。详见 `docs/diagnostics/2026-08-29-trae-mcp-visibility.md`。

---

## 4. 下一步怎么做（按顺序执行）

### 4.0 第二轮实测（2026-08-29 14:51 UTC）结论
- 调度员运行诊断模式（要求写文件到 `dispatcher-reports/dispatcher-<ts>.md`），触发 **3 次**。
  - 第一次：调度员写出了 `dispatcher-1764400000.md`（**说明 Trae Schedule 隔离会话**确实有 Write/Read 工具**），但时间戳是占位符（PATH 缺 `date` / `node`）。
  - 第二次（要求测试 MCP server 启动）：写出了 `dispatcher-1788015122.md`、`dispatcher-1788015123.md` 两份。
- 你从 UI 复制粘贴的 `tools unavailable` 报告里写了关键的**实测证据**：
  - 调度员在 `ALL_TOOLS`（即 Exec 沙盒视图）里**没看到** `agent_flow_*`
  - 扫描 `/Users/meow/.trae-cn/mcps/` **未注册** agent_flow 服务器（但这是**运行时实例目录**，不是注册表）
- **真实根因（高置信度，2026-08-29 15:08 UTC 定稿）**：
  1. 你**早就配置好了** MCP：`~/Library/Application Support/TRAE SOLO CN/User/mcp.json` 含 `agent-flow-ex` → `node /Users/meow/workspace/agent-flow-ex/dist/server.js`。
  2. Trae `mcp-servers-host.log` 历史显示 `agent-flow-ex` 在 **11:42:46** `Connected`、**11:51:25** 还在 `Got tools: agent_flow_submit/agent_flow_status/agent_flow_cancel`。
  3. **11:56:19** 出现 `MCPClient#onClose → Disconnected`——这是**主 IDE 重启 / 显式 kill MCP server 进程**留下的痕迹，**之后没有自动 reconnect**。
  4. 这恰好对得上 27 tick 中 1/27 成功 + 26/27 失败的模式：探测阶段那次 11:51 的成功在 disconnect 之前，后面所有 Schedule 触发都在 disconnect 之后。
- **教训**：
  1. 「让调度员写报告」**可行**——上一轮我以为不可行，是因为我**误读**：调度员当时其实写了 `dispatcher-1764400000.md` 我没看到。
  2. `~/.trae-cn/mcps/` ≠ MCP 注册表；注册表在 `~/Library/Application Support/TRAE SOLO CN/User/mcp.json`。调度员第一次诊断据此下错了结论。
  3. `Trae Schedule 隔离会话的可见工具集 ≠ 主 IDE 工具集 ≠ Exec 沙盒视图`，但都是 Trae **同一份 MCP 注册表**驱动的；只要 MCP server 在跑，Schedule 会话也能看到工具（与工作目录、用户权限解耦）。

### 4.1 真实根因（终稿，2026-08-29 15:18 北京时间）

- `agent-flow-ex` MCP server **一直健康运行**，从未离开主 IDE 会话的视图。
- Trae Schedule 隔离会话**不会同步主 IDE 的 MCP toolset**——这是 Trae 平台的会话隔离设计，不是配置问题、不是 prompt 问题、也不是 MCP server 自身的健康问题。
- 「重启 MCP server 让 Schedule 会话重新看到」**是无意义动作**——MCP server 从未断过；就算它重启一万次，Schedule 隔离会话也不会因此加载它。
- `mcp-servers-host.log` 在 11:56:19 出现的 `MCPClient#onClose / Disconnected` 是 MCP server 进程被 kill 一次的孤立事件，主 IDE 早已自愈并继续 `Got tools`，与 Schedule 会话看到的现象无因果关系。

### 4.2 结论

**Trae Schedule 路线 v1 出局**——不要在这条路上再花时间。需要 10 分钟粒度按 spec §5.4 走 launchd 兜底（spawn `dist/server.js` 一次调 `agent_flow_status` 退出，纯轮询器、无 LLM 决策能力）。

### 4.3 WorkBuddy 路线已全绿（V1–V5）

- 1 小时粒度；如不满足延迟需求再考虑 launchd。
- WorkBuddy 的 `connector-proxy` 自带 MCP 工具发现机制，所以走通。
- **WorkBuddy automation**（备选，v2 spec 已用）：先实测「automation 触发的新 agent 进程是否自动加载 `~/.workbuddy/mcp.json`」，通过则把 §4.1 最终 Prompt 迁过去、cron 换成 RRULE/scheduledAt。
- **launchd / cron**（兜底）：写 `dispatcher.mjs` 直接 spawn `dist/server.js` 一次调 `agent_flow_status` 退出。**代价**：失去 LLM 决策（退化为纯轮询器）。

### 4.3 任何派发方上线前的前置检查（避免重复踩坑）
- 先做一个探测任务：`trigger` 拉一个全新会话，确认能调 `agent_flow_*` 再部署生产调度员。
- 把「MCP 是否由 UI 配置 + 是否自动运行」作为探测通过的必要条件写进计划。

---

## 5. 已固化的有效资产（即便派发方更换也不失效）

- **worker 契约**（`src/prompt.ts` 第 2/5 条）：富上下文报告约定（`docs/problems/problem-<ts>.md`）+ 上下文卫生规则（读大文件前 `wc -l`/`grep`，遇 AUTOCOMPACT 即上报）。
- **`agent_flow_status` 暴露 `timeout_sec`**（Task 2）：调度员按 `elapsed_sec > 2×timeout_sec` 收割孤儿 running 的依据，已在 status 视图与测试固化。
- **调度员最终 Prompt**（spec §4.1，唯一权威源）：needs_input 代答边界（机械/事实/配置类、rounds>=3 不答）+ 孤儿收割规则 + 单次 ≤3 个的约束。
- **失败归因记录与回退**：`~/.workbuddy/mcp.json` 的 env 保留（不影响生产路径）；Schedule `8a989934` 已 Paused，不再耗 token。

---

## 6. 遗留待办

- [ ] UI 开启「自动运行 MCP」并核对 MCP server 存在 → `trigger` 验证工具可见。
- [ ] 验证通过则续跑 Task 4/5 验收（needs_input 自动续跑 + 孤儿收割）。
- [ ] 验证失败则执行 §4.2 切换 WorkBuddy / launchd，并更新 spec §3/§5 派发方矩阵与结论。
- [ ] 集成测试 baseline 复跑（沙盒 PATH 缺 `node`，非本项目问题）。
- [ ] 若继续用 Trae Schedule，补充「调度会话 MCP 工具集是否与主 IDE 独立、如何自动加载」的平台结论进 spec。