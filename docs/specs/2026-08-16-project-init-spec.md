# 项目规格说明书 (Specification)

**项目名称**：`cc-connect-flow` (简称 `cc-flow`)  
**版本**：v1.0  
**状态**：设计阶段  
**最后更新**：2026-08-16

---

## 1. 项目背景与目标

### 1.1 背景
当前 `cc-connect` 已实现飞书与 Claude Code 的双向通信，用户可通过飞书远程指挥 Claude Code 执行编码任务。但在 IDE（如 Trae）中，高级模型（如 GPT/Claude）做方案设计后，需人工将 Prompt 复制粘贴给飞书发送给 `cc-connect`，且需长时间等待任务完成，体验割裂且易超时。

### 1.2 目标
构建一个 **MCP (模型上下文协议) 标准服务**，作为 `cc-connect` 的上层工作流网关（Workflow Gateway）。使 IDE 中的 AI 助手能自主、异步地派发任务给 Claude Code（M3），并解决 IDE MCP 默认 60 秒超时的难题。

---

## 2. 核心架构

本服务作为胶水层，严格遵循“异步非阻塞”设计。

| 层级 | 组件 | 角色 |
| :--- | :--- | :--- |
| **客户端** | Trae / Cursor / Claude Desktop | 支持 MCP 的 IDE 或 AI 客户端，担任“高级指挥官” |
| **MCP 服务层** | **cc-connect-flow** | 基于 MCP SDK 开发的独立进程，暴露标准化工具，担任“调度网关” |
| **执行网关** | cc-connect | 常驻后台的守护进程，通过 Management API 接收指令并管理 Claude Code 子进程 |
| **工人** | Claude Code (模型: M3) | 实际执行代码编写、测试、重构等任务 |

### 2.1 架构图

```mermaid
flowchart LR
    Client[IDE客户端<br>Trae/Cursor] -->|MCP协议| Flow[cc-connect-flow<br>MCP服务/调度层]
    Flow -->|HTTP API异步调用| Gateway[cc-connect<br>执行网关/守护进程]
    Gateway -->|子进程 exec| Claude[Claude Code -p<br>工人(M3)]
    Claude -->|实时日志| Gateway
    Gateway -.->|自动同步推送| Feishu[飞书 Channel<br>用户可见]
```

---

## 3. 核心数据流（关键设计）

针对 IDE 端 MCP 工具默认 60 秒超时的硬限制，必须采用 **“提交-轮询” (Submit-Polling)** 模式。

### 3.1 任务提交流程（瞬间完成，耗时 < 200ms）

1. 用户在 Trae 中通过自然语言描述需求，AI 决定调用 MCP 工具 `cc_flow_submit`。
2. MCP 服务（cc-connect-flow）将 Prompt 通过 HTTP 转发给 `cc-connect` 的 Management API（`POST /api/v1/projects/{name}/prompt`）。
3. `cc-connect` 立即返回 `session_id`（即 `task_id`）。
4. MCP 服务将 `task_id` 返回给 IDE，本次 MCP 调用结束，**绝不触发 60 秒超时**。

### 3.2 状态轮询流程（循环查询）

1. IDE（或用户手动点击）调用 MCP 工具 `cc_flow_status`，传入 `task_id`。
2. MCP 服务查询 `cc-connect` 的会话状态接口（`GET /api/v1/projects/{name}/sessions/{id}`）。
3. MCP 服务返回结构化状态给 IDE：
   - 执行中：`{ "status": "running", "elapsed_sec": 15 }`
   - 已完成：`{ "status": "completed", "result": "...", "files_changed": [...] }`
   - 已失败：`{ "status": "failed", "error": "..." }`

### 3.3 飞书同步机制（无额外开发工作量）

- `cc-connect` 原生特性保证：**无论消息来源是 MCP API 还是飞书，所有对话记录均会双向同步推送到绑定的飞书会话中**。
- 即：通过 Trae 发出的指令，会像你在飞书里发送的一样，实时出现在飞书机器人对话框中；Claude Code 的回复也会同时推送到飞书和 Trae。

---

## 4. 接口契约（MCP Tools 定义）

MCP 服务至少需暴露以下 2 个核心工具（Tools）：

| 工具名 | 描述 | 输入参数 (JSON Schema) | 输出示例 |
| :--- | :--- | :--- | :--- |
| **`cc_flow_submit`** | 向 Claude Code 提交一个复杂编程任务 | `{ "prompt": "string (required)", "project_path": "string (optional)" }` | `{ "task_id": "sess_abc123", "status": "queued", "message": "Task submitted successfully" }` |
| **`cc_flow_status`** | 查询任务的执行状态和结果 | `{ "task_id": "string (required)" }` | `{ "status": "running", "elapsed_sec": 15 }` <br>或 <br> `{ "status": "completed", "result": "finish reason...", "files_changed": [...] }` |
| *(可选)* **`cc_flow_cancel`** | 取消正在运行的任务 | `{ "task_id": "string" }` | `{ "status": "cancelled" }` |

---

## 5. 与非功能性需求 (NFR)

| 需求 | 说明 |
| :--- | :--- |
| **超时规避** | 所有 MCP 工具内部**严禁**出现同步阻塞等待（如 `sleep` 循环轮询），必须即查即返。 |
| **状态持久化** | `cc-connect` 重启会导致内存中的会话丢失。建议 MCP 服务维护轻量级本地缓存（SQLite 或 JSON 文件），记录 `task_id` ↔ `session_id` 的映射关系及最终结果，防止查询失效。 |
| **日志可见性** | 完全依赖 `cc-connect` 的飞书同步机制，无需在 MCP 层额外实现日志通知。 |
| **并发安全** | MCP Server 需支持同时处理多个 IDE 客户端的并发请求，不产生资源竞争。 |

---

## 6. 技术选型建议

| 组件 | 推荐方案 |
| :--- | :--- |
| **编程语言** | TypeScript (Node.js) 或 Python。推荐 Node.js 以便与 `cc-connect` 生态（Go）互补，且 MCP SDK 官方支持良好。 |
| **MCP SDK** | `@modelcontextprotocol/sdk` (npm) 或 `mcp` (PyPI) |
| **HTTP 客户端** | Axios (Node) / Requests (Python) |
| **本地缓存** | `node:fs` 读写 JSON 文件 或 `better-sqlite3` |
| **进程管理** | MCP Server 本身以独立子进程运行，由 IDE 客户端（Trae）负责启动和销毁。 |

---

## 7. 验收标准 (Acceptance Criteria)

- [ ] 在 Trae 中通过自然语言触发 `cc_flow_submit`，能立即获得 `task_id`，且 Trae 对话框不卡顿。
- [ ] 调用 `cc_flow_status` 能正确返回 `running` / `completed` / `failed` 状态。
- [ ] 任务执行期间，飞书机器人对话框中能实时看到 Trae 发起的指令和 Claude Code 的回复。
- [ ] 任务完成后，Trae 能获取到 Claude Code 的完整执行结果（或文件路径）。
- [ ] MCP Server 崩溃重启后，已提交的 `task_id` 仍可查询到状态（依赖持久化缓存）。

---

## 8. 附录：与 `cc-connect` 交互的 API 映射

| MCP 工具 | cc-connect API 端点 | 方法 |
| :--- | :--- | :--- |
| `cc_flow_submit` | `/api/v1/projects/{project}/prompt` | POST |
| `cc_flow_status` | `/api/v1/projects/{project}/sessions/{session_id}` | GET |
| `cc_flow_cancel` | `/api/v1/projects/{project}/sessions/{session_id}/cancel` | POST |

> 注：实际 `project` 名称需在 MCP Server 配置文件中预置，或由用户在提交时传入。

参考项目：[cc-connect](https://github.com/chenhg5/cc-connect) 已经 clone 到 当前项目的 `../cc-connect` 目录。
