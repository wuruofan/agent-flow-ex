# Trae Schedule 会话拿不到 MCP 工具 · 诊断归档

**文档编号**：2026-08-29-trae-mcp-visibility
**状态**：**根因已定，且可修**（2026-08-29 23:25 修订）。此前「Trae 平台内部行为、建议放弃」的结论**已撤回**，见 §6。
**时间跨度**：2026-08-27 21:42 – 2026-08-29 23:25
**原始报告**：`raw/` 下 4 份（Trae 侧自动产出，结论互相矛盾，见 §5）

---

## 1. 一句话结论

**Trae 的 MCP 客户端在 2026-08-29 11:56:19 断开后不会自动重连**，导致此后所有 `agent_flow_*` 调用失败（包括主会话与 Schedule 子会话）。主 IDE 工具面板显示的「3 个工具」是**过期缓存**，掩盖了真实状态。

**修复动作**：强制 Trae 重连（MCP 面板 disable → re-enable `agent-flow-ex`，或退出重启 Trae）。

---

## 2. 为什么是 `docs/diagnostics/` 而不是 `docs/debug/`，也不放在 `superpowers/` 下

| 选项 | 取舍 |
| :--- | :--- |
| `docs/debug/` | ❌ 语义隐含「未修完、待修」；且 `specs/ plans/ reviews/ designs/` 全是名词类型，`debug` 是唯一动词 |
| `docs/superpowers/diagnostics/` | ❌ **已改出**。`superpowers` 是**插件名**，其 `specs/`、`plans/` 由该插件的工作流创建；本调查与插件无关，不该寄居在插件命名空间下 |
| **`docs/diagnostics/`**（采用） | ✅ 项目级文档类型，与 `specs/ plans/ reviews/ designs/` 平级，不依赖任何插件 |

同时把 `2026-08-29-trae-retest.md`（回测手册）也一并移入——它同样是本次调查的产物，且与该文档强耦合。

> 注：`docs/superpowers/` 下保留的是由 superpowers 工作流产出的自循环 spec / plan / trial / review 四份文档，它们确实属于该插件的工作流产物。

---

## 3. 根因证据链

### 3.1 决定性证据：`mcp-servers-host.log`

路径：`~/Library/Application Support/TRAE SOLO CN/logs/20260827T214211/window1/exthost/mcp-servers-host.log`
（注意在 `window1/exthost/` 子目录下，不在 `window1/`）

```
11:51:25.688 [info]  MCPServerManager#listTools Listing tools...
11:51:25.693 [info]  MCPServerManager#listTools Got tools:
                     agent_flow_submit, agent_flow_status, agent_flow_cancel
11:56:19.831 [error] MCPClient#onClose
11:56:19.843 [info]  MCPServerManager#onClose Disconnected.
```

**这是该文件最后两行——之后 11 小时无任何事件，没有重连、没有重试。**

### 3.2 三条时间线严丝合缝

| 时刻 | 事件 |
| :--- | :--- |
| 08-27 21:42:46 | `McpClientService startExtension: mcp.config.usrlocalmcp.agent-flow-ex` → 连接建立 |
| 08-29 09:15–11:51 | 主会话调用全部 `code:0`，走完完整状态机 |
| **11:51:25** | **最后一次成功调用**（`agent_flow_status`，`code:0`） |
| **11:56:19** | **`MCPClient#onClose` → `Disconnected`** |
| **11:57:09** | **第一次失败**：`Extension not found` |
| 11:57 起 | 所有后续调用失败，含 15:11 / 22:45 / 22:51 / 22:58 各轮 |

**11:56:19 之后成功调用次数 = 0。**

### 3.3 断连诱因（含两个假设的实测排除）

**现象**：11:56 前后正在为 V5 注入 `agent_flow_set_started_at` 测试工具 → **kill 并重启 MCP server 进程**（pid 17974→80852→4060→4180→4340），同时改了 `~/.workbuddy/mcp.json`。

server 进程被杀 → Trae 的 MCPClient 收到 `onClose` → 标记 Disconnected → **不自动重连**。

#### 假设 A：MiniMax M3 五小时 token 额度在 ~11:51 用尽 → ❌ 不成立

| 检查 | 结果 |
| :--- | :--- |
| Trae 日志 11:45–11:58 的 token / quota / rate / 429 记录 | **零命中** |
| 11:51:25（最后成功）→ 11:57:09（首次失败）之间 | 除 11:56:19 断连外**无任何事件** |
| 机制合理性 | MCP server 是纯 node 进程，**不发起任何 LLM 调用**；token 额度影响的是 worker agent，不会让本地 stdio 进程退出 |

#### 假设 B：WorkBuddy 连上 MCP 后 Trae 就连不上了（互斥）→ ❌ 不成立

**直接实验**（在 WorkBuddy 的 44170 存活期间）：

```sh
# 第二个 server 进程，用同一个 AGENT_FLOW_HOME（同一份 tasks.db）
printf '<initialize>\n<initialized>\n<tools/call agent_flow_status>' \
  | /Users/meow/.nvm/versions/node/v24.18.0/bin/node dist/server.js
```

→ 返回 `[]`，无 error。**同库多进程共存正常**。（此前 `tests/server-tools.test.ts` 也会并发 spawn 两个进程，同样正常。）

机制上也不该互斥：stdio MCP server 是**每客户端各 spawn 一个进程**，无共享 socket；SQLite 走 WAL，支持多进程读写。

#### 那 1.3 秒的「巧合」怎么解释

```
11:56:19.831  Trae:      MCPClient#onClose → Disconnected
11:56:21.136  WorkBuddy: Connected to custom-mcp:agent-flow-ex   ← +1.3s
11:56:43.295  WorkBuddy: Connected（第二次）
11:57:19.739  WorkBuddy: Connected（第三次）
```

**不是互斥，是同一次 kill 的两个不同反应**：server 进程被杀 → 两个客户端同时掉线 → **WorkBuddy 自动重连（2 秒内，且之后又重连 2 次）**，**Trae 不重连**。

WorkBuddy 的重连能力是可验证的：21:01 我手动 kill 掉它的 server（pid 4340）后，它在 **21:01:13** 自动重连成功，无需任何人工干预。

> 当前磁盘状态佐证：只有一个 `agent-flow-ex` server 进程（pid 44170），父进程是 **WorkBuddy**。**Trae 名下没有 server 进程**——它的客户端确实处于无连接状态。

### 3.4 为什么之前没看出来

主 IDE 的 MCP 面板仍显示 3 个工具——那是**断开前的缓存**，不是实时状态。于是现象变成「工具列表看着正常，但一调用就 `Extension not found`」，极易误判成「Schedule 会话权限/注入问题」。

---

## 4. 排除掉的错误假设

| 假设 | 排除依据 |
| :--- | :--- |
| ❌ prompt 缺「步骤 0」 | 换了带步骤 0 的 prompt 后仍失败——因为客户端根本是断的，prompt 从未被真正检验 |
| ❌ MCP 注册表/配置错误 | `TRAE SOLO CN/User/mcp.json` 正确；手动 spawn + `initialize` 握手合规 |
| ❌ server 自身故障 | 同一份 `dist/server.js` 被 WorkBuddy 正常驱动，V1–V5 全绿 |
| ❌ 「自动运行 MCP」没开 | `updatePluginMcpConfigs` 205 条**恒为** `"enabled":true`（许可已给；但 `serverNames:[]`，供给为空——两回事） |
| ❌ `serverNames:[]` 是原因 | 205 条**从未非空**，包括主会话调用全部成功的时段 → 该通道本就空置，与故障无关 |

> **教训**：`render.log` 只记录调用成败，**连接状态只在 `exthost/mcp-servers-host.log`**。只看前者会得出完全错误的结论——这就是我先前误判「Trae 平台内部行为，建议放弃」的原因。

---

## 5. `raw/` 四份报告的结论演变

**它们互相矛盾**，读 raw 前先看这张表：

| 文件 | 判定 | 依据 | 复核结论 |
| :--- | :--- | :--- | :--- |
| `dispatcher-1764400000.md` | **A**（注册表里没有） | 扫 `~/.trae-cn/mcps/` | ❌ **依据错误** |
| `dispatcher-1788015122.md` | **A**（同上） | 同上 | ❌ 同上 |
| `dispatcher-1788015123.md` | **B**（注册了但注入不到） | 同上 + 配置存在 | ⚠️ 结论对，依据仍错 |
| `dispatcher-1788015569.md` | **B**（自我推翻 A） | 改用注册表视角 + render.log | ⚠️ 结论对，但未定位到断连 |

**A 类判定错在哪**：`~/.trae-cn/mcps/` 是**已停更的旧版 `Trae CN`** 的运行时实例目录（该 app 自 2026-07-30 起停更），不是注册表。拿它判定「未注册」等于看错 app。

**四份都没找到真因**：它们都没读 `exthost/mcp-servers-host.log`，所以都停在「工具不可见」这一层，没往下追到「客户端已断连 11 小时」。

---

## 6. 结论修订记录

| 时间 | 结论 | 依据 | 状态 |
| :--- | :--- | :--- | :--- |
| 23:00 | 「Trae 平台内部行为，建议放弃」 | 仅 `render.log` | ❌ **已撤回** |
| **23:25** | **「Trae MCP 客户端断连不重连，强制重连即可」** | `exthost/mcp-servers-host.log` | ✅ **当前结论** |

**撤回说明**：前一版结论基于不完整证据（漏读 `exthost/` 下的 host 日志）。**22:52–23:00 那轮回测因此无效**——它是在客户端已死的状态下测的，新 prompt 从未被真正检验。

---

## 7. 下一步

1. **强制重连**（二选一，1 分钟）：
   - Trae MCP 面板 → `agent-flow-ex` → disable → re-enable
   - 或直接退出并重启 Trae（更彻底）
2. **验证重连成功**：确认 `exthost/mcp-servers-host.log` 尾部出现新的 `Connected`（或 `listTools Got tools: agent_flow_submit, ...`）。
3. **重跑回测**：按 `2026-08-29-trae-retest.md` 用带步骤 0 的 prompt `trigger` 一次。
4. **记录结果**并回填 spec §3 / §7 / §11。

> ⚠️ 重连后若仍 `Extension not found`，才是真的平台问题。但按当前证据，概率低。

---

## 8. 存在但**不采用**的绕行方案

Schedule 子会话有 `RunCommand`、node 绝对路径可用，纯 shell 走 stdio 可绕过 MCP 客户端：

```sh
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sh","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_flow_status","arguments":{}}}' \
 | /Users/meow/.nvm/versions/node/v24.18.0/bin/node \
   /Users/meow/workspace/agent-flow-ex/dist/server.js
```

→ 返回 `[]`，无需 MCP 客户端。**技术上已验证可行。**

**不采用**：它会让 Trae 版 prompt 与 WorkBuddy 版分叉，破坏「prompt 即规约 / 派发方可替换」这条不变量。真到需要时，更干净的是 spec §5.4 的 launchd 路线（不污染 prompt）。
