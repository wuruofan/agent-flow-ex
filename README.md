# agent-flow-ex

把 AI 编程 Agent（Claude Code / OpenCode）当作「后台任务」来调度的 **MCP Server**。

通过 MCP 工具 `submit` / `status` / `cancel` 提交任务：server 以 detached 子进程拉起**真实** agent CLI，用 SQLite 记录任务状态机，支持 `NEEDS_INPUT` 续跑、超时、取消，并在任务结束时推送飞书通知。

## 特性

- **后台调度**：任务在独立 detached 进程里跑，不阻塞你的对话；随时 `status` 查进度、`cancel` 终止。
- **状态机**：`queued → running → (needs_input → running → …) → completed | failed | cancelled`，最多 5 轮续跑。
- **多 Agent / 多 Provider**：内置 `claude` 与 `opencode` 两个 executor，可配置不同 profile（如 MiniMax、DeepSeek 网关）。
- **NEEDS_INPUT 续跑**：agent 反问时任务进入 `needs_input`，用 `submit(continue_of=…)` 把答案喂回去继续跑。
- **飞书通知**：任务终态（完成 / 失败 / 取消）推送飞书，支持 `dry_run` 调试。
- **密钥零落盘（config）**：`config.json` 只含 `{env:ENV_VAR}` 占位符；真实密钥落在 `$AGENT_FLOW_HOME/.env`（chmod 600，server 启动自动加载），不进 git、不被同步。

## 架构

```
MCP Client (TRAE 等)
   │  stdio: submit / status / cancel
   ▼
server.ts (MCP Server)
   │  submit → 写 SQLite → spawn detached runner
   ▼
runner.ts (detached 子进程)
   │  buildCommand → spawn agent CLI (claude -p / opencode)
   │  逐行解析 agent 事件 → 落库 + 写日志
   ▼
agent CLI (真实 claude / opencode) ── 事件流 ──▶ 终态 + 飞书通知
```

## 要求

- Node.js **>= 22.5**
- 本地已安装要用的 agent CLI（`claude` 或 `opencode`）

## 安全须知

worker 以 agent CLI 的「跳过权限确认」模式运行（claude：`--dangerously-skip-permissions`；opencode：`--auto`），无二次确认。请在**自己的机器、可信的项目目录**上使用；派发任务前想清楚你给了 worker 什么权限。

## 快速开始

```bash
npm i -g agent-flow-ex    # 或免安装：npx agent-flow-ex@latest init
agent-flow-ex init        # 交互式配置：探测 CLI、收集密钥、生成 config + .env
```

`init` 结束时会**直接打印** MCP 注册片段，把它拷进你的 MCP 客户端配置即可（WorkBuddy 为 `~/.workbuddy/mcp.json`）：

```jsonc
{
  "mcpServers": {
    "agent-flow-ex": { "command": "agent-flow-ex" }
  }
}
```

> 用 npx 免安装形态：`{ "command": "npx", "args": ["-y", "agent-flow-ex@latest"] }`。
> 注册后需在客户端里信任/启用该 server（首次接入通常要重启或手动连接）。

> ⚠️ **`command` 必须能被客户端找到。** 客户端拉起 MCP server 时**不一定带你的 shell PATH**，
> 裸写 `agent-flow-ex` 或 `node` 在 PATH 受限的环境下会直接 `ENOENT`。已实测：`PATH=/usr/bin:/bin`
> 下 `node` 与 `agent-flow-ex` 均找不到。若你用 nvm / homebrew / WorkBuddy 托管版 node，
> 建议写**绝对路径**（也可显式补 `env.PATH`）：
>
> ```jsonc
> {
>   "mcpServers": {
>     "agent-flow-ex": {
>       "command": "/Users/<you>/.nvm/versions/node/<v>/bin/node",
>       "args": ["/path/to/agent-flow-ex/dist/server.js"],
>       "env": { "AGENT_FLOW_HOME": "/Users/<you>/.agent-flow-ex" }
>     }
>   }
> }
> ```

之后在对话里说「把 X 派给后台 worker」即可；任务终态会推飞书通知（`init` 里配置过 webhook 的话）。

### 可选：安装 dispatch skill（推荐）

MCP 工具是「底层能力」，dispatch skill 是叠加在上面的**派发规范**：什么时候该派、prompt 怎么写才自包含、
同一目录为什么禁止并发、`needs_input` 怎么续跑、什么时候干脆别派（返工量小且强依赖当前会话上下文时，
自己更快更准）。装了它，你只说「把 X 派给 worker」，它会按规范把任务拆好、检查并发、拼好 prompt 再提交。

```bash
./scripts/install-skill.sh          # 默认装到 ~/.agents/skills + ~/.workbuddy/skills
./scripts/install-skill.sh ~/some/other/skills   # 或指定目录
```

脚本把仓库里的 `skills/agent-flow-dispatch` **软链**到各宿主工具的用户级 skills 目录——
它是仓库的软链，改了立刻生效、不会产生副本漂移。可重复执行（幂等：已指向正确位置会 skip；
若目标路径已有**实体目录**则会中止并提示手动处理，不会覆盖）。

**生效范围是全局的，不是当前仓库**：入口落在用户级 skills 目录（`~/.agents/skills`、`~/.workbuddy/skills`），
WorkBuddy 会扫描这些路径，所以在任何项目里都能用。仓库里的 `./skills/` 是普通目录，**不是**项目级 skill 路径
（那会是 `./.workbuddy/skills`），因此既不会只在本仓库生效，也不会与项目级 skill 冲突。

> ⚠️ 默认目标**不含 Trae**：它的前端在后台任务结束时**不会开新 turn**，所以「派发完就等着收通知」在 Trae 上不成立，
> 只能自己查 `status`。需要时用 `./install-skill.sh ~/.trae-cn/skills` 单独装。
>
> ⚠️ 该脚本是**开发者路线**（依赖本地仓库路径），随 npm 包发布不适用——见下方「已知缺口」。

## 安装（从源码，开发者路线）

```bash
git clone https://github.com/wuruofan/agent-flow-ex && cd agent-flow-ex
npm install
npm run build        # tsc → 生成 dist/
npm run init         # 开发模式跑 init（tsx）
./scripts/install-skill.sh   # 可选：装 dispatch skill
```

## 配置

### 配置目录

配置放在 `AGENT_FLOW_HOME` 指向的目录下，文件名 `config.json`：

```bash
export AGENT_FLOW_HOME="$HOME/.agent-flow-ex"   # 缺省即此；也可指向任意目录
```

### config.json 结构

参考 `config.example.json`，字段如下：

```jsonc
{
  "executors": {
    "claude":   { "bin": "/abs/path/to/claude", "extra_flags": ["--dangerously-skip-permissions"] },
    "opencode": { "bin": "/abs/path/to/opencode", "extra_flags": ["--auto"] }
  },
  "profiles": {
    "minimax-3": {
      "executor": "claude",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "{env:MINIMAX_API_KEY}",
        "ANTHROPIC_MODEL": "MiniMax-M3[1m]"
        // …其余 ANTHROPIC_* / CLAUDE_CODE_* 变量
      }
    }
  },
  "notify": {
    "feishu_webhook_url": "{env:FEISHU_WEBHOOK_URL}",
    "dry_run": true
  },
  "defaults": { "profile": "minimax-3", "timeout_sec": 3600 }
}
```

| 字段 | 说明 |
|---|---|
| `executors.<name>.bin` | agent CLI 的**绝对路径**（见下方「重要」）。 |
| `executors.<name>.extra_flags` | 拼到 agent 命令后的额外参数。权限开关按 executor 区分：claude 用 `--dangerously-skip-permissions`，opencode 用 `--auto`（`init` 会自动写对）。 |
| `profiles.<name>.executor` | 引用 `executors` 里的某个 executor。 |
| `profiles.<name>.env` | 传给 agent 子进程的环境变量；支持 `{env:VAR}` 占位符（见下）。**opencode 一般留空**（provider 由 opencode 自己的 `auth.json`/`opencode.json` 管理）；要给某个 profile 单独指定模型，写 `OPENCODE_CONFIG_CONTENT: "{\"model\":\"provider/model\"}"`——`extra_flags` 是 executor 级，多 profile 无法用它区分模型。另注意 `buildAgentEnv` 只给极简 `PATH`，worker 里的 shell 用不到 `/opt/homebrew/bin` 等，需要时在此显式补 `PATH`。 |
| `notify.feishu_webhook_url` | 飞书机器人 webhook；支持 `{env:FEISHU_WEBHOOK_URL}` 占位符。 |
| `notify.dry_run` | `true`（缺省）→ 只打印通知内容不真发；`false` → 真发。 |
| `defaults.profile` | `submit` 不指定 profile 时用的默认 profile（必须在 `profiles` 中存在）。 |
| `defaults.timeout_sec` | 单轮超时（秒），超时 SIGTERM 杀掉 agent。 |

### 上下文压缩：`[1m]` + `AUTO_COMPACT_WINDOW` + `PCT_OVERRIDE`

worker 的上下文占用到阈值就会触发自动压缩（摘要掉早期对话）。**这三个变量必须成套设置**，否则达不到预期，甚至会适得其反。

claude-code 对**未知模型**（如 MiniMax / DeepSeek 等第三方模型）会回落到 **200k** 窗口兜底，此时 `AUTO_COMPACT_WINDOW` 设多大都会被 `Math.min` 压回 200k，形同虚设。加 `[1m]` 后缀才能拿到 1M 窗口：

| 变量 | 作用 | 缺了会怎样 |
|---|---|---|
| `ANTHROPIC_MODEL` 带 `[1m]` | 窗口 200k → **1M** | 窗口恒为 200k，下面的 window 失效 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 压缩**工作窗口**（绝对值） | 阈值涨到 967k，逼近服务端上限，易撞顶失败 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 在工作窗口上的**百分比** | 退回内置默认（约 92%），压缩来得太晚 |

阈值的计算方式（claude-code v2.1.x）：

```
window  = min(模型窗口, max(100k, AUTO_COMPACT_WINDOW))
阈值    = min(window − 20000 − 13000, (window − 20000) × PCT%)
```

以 `AUTO_COMPACT_WINDOW=512000` + `PCT=90` 为例：`window=512000` → 阈值 ≈ **442,800 tokens**。

| PCT | 512k 窗口下的阈值 |
|---|---|
| 70 | 344,400 |
| 80 | 393,600 |
| 90 | 442,800 |
| 不设 | 479,000 |

> **注意**：`~/.claude/settings.json` 的 `env` 块也会注入这些变量。agent-flow 传了 `HOME` 给子进程，claude 会自行读取该文件——**若那里设了同名 key，agent-flow 的 `profiles.<name>.env` 优先级更高**（仅当该 key 已在 profile 中显式设置）。想完全由 agent-flow 单点控制，就把两个变量都写进 profile env。

**验证是否真的生效**：看任务日志 `result` 事件的 `modelUsage.<model>.contextWindow`——它反映模型窗口（带 `[1m]` 应为 `1000000`）；而**压缩工作窗口**不体现在该字段，要看日志里是否出现 `ran out of context`。

### `executors.<name>.bin`：绝对路径或裸命令名皆可

`runner` 拉起 agent 时，会显式构造子进程环境，其 `PATH` 以 **`dirname(解析后的 bin)` + 系统目录** 组成（`src/agent-env.ts`）。`bin` 支持两种写法：

- **裸命令名** `"claude"`：运行时按 `process.env.PATH` 解析成绝对路径（与启动期 `validate()` 行为一致），`dirname` 取解析结果目录。最省事，推荐。
- **绝对路径** `/abs/path/claude`：直接用，适合多版本 / 非标准安装。

想确认 claude 会被解析到哪：

```bash
which claude        # → /Users/you/.nvm/versions/node/v24.18.0/bin/claude
which opencode      # → /usr/local/bin/opencode
```

> 早期版本要求必须写绝对路径；现已支持裸名自动解析，无需再硬编码 nvm 路径。

### 密钥：config 占位符 + `.env` 真实值

`env` 与 `feishu_webhook_url` 里写成 `"{env:VAR_NAME}"` 形式的值，会在**任务运行时**（runner 进程）从环境变量替换。**config.json 永远不写真实密钥**，真实值放在 `$AGENT_FLOW_HOME/.env`：

```bash
# $AGENT_FLOW_HOME/.env（示例；init 命令会自动生成，chmod 600）
MINIMAX_API_KEY=sk-xxxx
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

- **server 启动时自动加载 `.env`** 灌进 `process.env`（`src/env-file.ts`；只补缺失，不覆盖真实环境变量），runner 是 server 的 detached 子进程，自动继承——所以**密钥不用写进 MCP 注册的 `env` 字段**。
- 占位符在运行时缺失 → 加载/解析直接报错（避免明文密钥意外落盘）。
- 想让 `.env` 生效，重启 server 进程即可。

### 飞书 dry_run

调试期把 `notify.dry_run` 设为 `true`（也是缺省值），通知内容只打到 stderr，不会真正 POST。确认链路无误后再改为 `false`。

## 运行

### 作为 MCP Server（stdio）

生产形态（全局安装后）用 bin 名注册，**不要写绝对路径**（换机器/挪目录都不断）：

```jsonc
{
  "command": "agent-flow-ex",
  "env": {
    "AGENT_FLOW_HOME": "/abs/path/to/your/home"   // 可省，缺省 ~/.agent-flow-ex
    // 密钥不用放这里：server 启动时会自动读 $AGENT_FLOW_HOME/.env
  }
}
```

开发模式（直接跑 TS，无需先 build）：

```bash
npm run server      # = tsx src/server.ts
```

### 手动跑单条任务（调试用）

`runner` 一般被 server 自动 spawn。需手动验证时，先确保 SQLite 里已有一条任务记录（通常由 `submit` 创建），再：

```bash
npm run runner <task_id>     # = tsx src/runner.ts <task_id>
```

### 跑测试

```bash
npm run build && npm test            # 单元 + 集成 = 75 全绿
npm run test:integration            # 只跑集成（会自动先 build）
npm run typecheck                   # 仅类型检查
```

集成测试直接跑预编译的 `dist/runner.js`（与生产同款），避免 dev 路径下 tsx 冷启动拖慢 timing 断言。

## MCP 工具

### `submit`

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 任务描述 / 指令。 |
| `project_path` | | agent 的工作目录，缺省为 server 进程 cwd。 |
| `profile` | | 用哪个 profile，缺省 `defaults.profile`。 |
| `continue_of` | | 填已有 `needs_input` 任务 id，把 `prompt` 作为该轮回答续跑。 |
| `timeout_sec` | | 单轮超时，缺省 `defaults.timeout_sec`。 |

返回 `{ task_id, status, rounds }` 或 `{ error }`。

### `status`

| 参数 | 说明 |
|---|---|
| `task_id` | 不填则返回所有活跃任务；填了返回单条。 |

返回字段含 `status / rounds / profile / elapsed_sec / progress / files_changed`，终态时含 `result` / `error`，`needs_input` 时含 `question`，通知失败时含 `notify_failed`。

### `cancel`

| 参数 | 必填 | 说明 |
|---|---|---|
| `task_id` | ✅ | 取消指定任务。 |

对终态任务幂等（返回当前状态，不改写）；对 `running` 任务会 SIGTERM 级联杀掉 agent 进程。

## 状态机

```
        submit
          │
          ▼
       queued ──spawn──▶ running ──agent 反问──▶ needs_input
          │                  │                        │
          │                  │ answered (submit continue_of)
          │                  │                        │
          │                  ▼                        ▼
          │               running ◀──────────────────┘   (最多 5 轮)
          │                  │
          ├──────────────────┤
          ▼                  ▼
     completed           failed
          │
          ▼
   cancelled (任意非终态可取消)
```

`needs_input` 续跑示例：

1. `submit({ prompt: "给项目加登录页", profile: "minimax-3" })` → 拿到 `task_id`。
2. `status({ task_id })` 看到 `status: "needs_input"`、`question: "用哪种数据库？"`。
3. `submit({ continue_of: task_id, prompt: "PostgreSQL" })` → 继续跑。

## 排错

- **`executor "claude" bin "…" not found or not executable`**：`bin` 路径不对或没 `+x`，改绝对路径。
- **任务 `failed`，`error: failed to spawn runner: … ENOENT`**：`bin` 用了裸名导致子进程 PATH 找不到 agent，改绝对路径（见上「重要」）。
- **飞书不推送**：检查 `dry_run` 是否还是 `true`；检查 `.env` 里 `FEISHU_WEBHOOK_URL` 是否存在（或 server 进程环境是否已 `export`）。
- **`{env:VAR}` 报错 `not found in process environment`**：对应密钥不在 `.env` 里，也没 `export` 到 server 进程环境。加到 `$AGENT_FLOW_HOME/.env` 后重启 server。
- **任务频繁超时，且日志里反复出现 `ran out of context`**：上下文被反复压缩，agent 丢失状态后重复劳动。查压缩阈值配置（见上「上下文压缩」）——若 `ANTHROPIC_MODEL` 没带 `[1m]`，窗口会被锁在 200k；工单过大（工具调用 ≫150 次）也会撞阈值，应先拆单。

## 快速初始化（`init` 命令）

不想手拼 JSON？用交互式 `init` 自动探测 CLI 路径、收集密钥，并生成 `config.json` + `.env`：

```bash
npm run init                 # 开发模式（tsx）
# 或生产形态：
node dist/server.js init    # 即 `agent-flow-ex init`
```

交互流程（claude executor 为例）：

1. 用哪个 agent CLI（`claude` / `opencode`，自动探测并提示检测到的路径）；bin 用检测到的绝对路径（回车即采用）；
2. profile 名（默认 `default`）；
3. provider 预设（`minimax` / `deepseek` / `custom`）：
   - **预设**：内置 base_url + 默认模型 + 对应密钥变量名（`MINIMAX_API_KEY` / `DEEPSEEK_API_KEY`）。检测到该环境变量时**掩码展示**（`sk-…wXYZ`）并问 `Use this value? [Y/n]`——`Enter`/`Y` 直接采用；`n` 后粘贴新值，或 `Enter` 跳过。
   - **custom**：只问 `ANTHROPIC_BASE_URL` 与模型名；密钥**只粘贴**（无标准变量名可检测），占位符变量名从 profile 名派生（如 `myprov` → `MYPROV_API_KEY`）。
4. 飞书 webhook：检测到 `FEISHU_WEBHOOK_URL` 同样 `[Y/n]` 确认，否则粘贴或跳过（仍生成占位符 + `dry_run`）；
5. 默认超时秒数。

结束后：

- 写 `config.json`（**只含 `{env:VAR}` 占位符**，零明文）并自动用 `loadConfig()` 自校验；
- 把确认/粘贴到的密钥写进 `$AGENT_FLOW_HOME/.env`（**chmod 600**，幂等——同值不重写）；
- 若密钥最终没进 `.env`，会打印 ⚠ 提醒「运行时必须有该变量，否则任务失败」；
- 末尾提示可编辑 `config.json` 调整模型别名与通用默认 env（如 `API_TIMEOUT_MS`）。

> 已有 `config.json` 时 `init` 会先确认是否覆盖。opencode executor 不询问 provider——它由 opencode 自己的配置管理（`opencode auth login` / `opencode.json`），agent-flow 只负责拉起。

## 发布（npm）

包名 `agent-flow-ex`，MIT。发布配置已在 `package.json` 就位：

| 字段 | 值 | 说明 |
|---|---|---|
| `bin` | `dist/server.js` | 全局安装后 `agent-flow-ex` 可直接跑 server |
| `files` | `dist` / `config.example.json` / `README.md` | 源码、`tests/`、`docs/` 不进包 |
| `prepublishOnly` | `build` + `test` | 发布前自动构建并跑全量测试，测试红则发布中止 |
| `engines.node` | `>=22.5` | 依赖 `node:sqlite`（server 与 runner 都要用） |

```bash
npm run build && npm test      # prepublishOnly 也会跑，但建议先手动确认
npm publish --access public
```

发布者需自备 npm 账号并 `npm login`（包名当前在公共 registry 上未被占用）。

> ⚠️ **npm 包不含 dispatch skill**：`skills/` 与 `scripts/` 不在 `files` 白名单里，且 `install-skill.sh`
> 依赖本地仓库路径（软链到 `<repo>/skills/…`），对 npm 用户不成立。要给 npm 用户装 skill，
> 需要另做分发（随包带上 + 改成「复制」而非「软链」，或让 skill 走独立的 skills 市场）。

## 后续（planned）

- v2 daemon（设计文档见 `docs/designs/2026-08-18-session-adapter.md`，代码未启动）。
