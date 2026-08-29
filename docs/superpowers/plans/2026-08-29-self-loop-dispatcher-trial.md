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

### 3.3 合理解释（按证据权重排序）
1. **「自动运行 MCP」未开启**（高概率）：Schedule 触发的新会话不会自动加载/运行 MCP 工具，于是整批 tick 无工具可用。早期那 1 次成功可能是当时配置/状态恰好满足加载条件，后续环境变化后失效。
2. **Schedule 会话与主 IDE 会话的 MCP toolset 是独立视图**（中概率）：主 IDE 重启 MCP server 后刷新了工具集，但 Schedule 隔离会话不自动同步，仍引用旧视图 → 工具消失。
3. **`env` 字段不被 Trae UI schema 接受**（低概率，已被本轮 UI 配置证据排除部分）：Trae 以 UI 配置为准，不读含 `env` 的文件 JSON，故该条目本就无意义。

> 一站定性：**这次失败是「调度会话拿不到 MCP 工具」的平台配置问题，不是调度员 prompt 也不是 agent-flow-ex 代码问题**。task 状态机、`timeout_sec` 暴露等方案侧改动均有效。

---

## 4. 下一步怎么做（按顺序执行）

### 4.1 先验证 UI 配置（成本最低，最高概率）
在 Trae UI 里完成两件事（代理无法代改 UI，需人工操作）：
1. **设置 → MCP**：确认 `agent-flow-ex` server 存在；没有则「手动配置」：
   ```json
   {
     "command": "node",
     "args": ["/Users/meow/workspace/agent-flow-ex/dist/server.js"],
     "env": { "AGENT_FLOW_TEST_MODE": "1" }
   }
   ```
   `dist/server.js` 已含 V5 测试工具，可直接用。
2. **设置 → 对话流（Work）/ 自动运行 MCP**：开启 **「自动运行 MCP」**。

完成后：把 Schedule `8a989934` 恢复 Active 并 `trigger` 一次，验证新会话能否 `agent_flow_status()`。

### 4.2 若仍不通：切换派发方（备选，prompt 无需改动，因为「prompt 即规约」）
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