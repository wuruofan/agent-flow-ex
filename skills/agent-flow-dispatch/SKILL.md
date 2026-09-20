---
name: agent-flow-dispatch
description: 通过 agent-flow-ex MCP server（agent_flow_submit / agent_flow_status / agent_flow_cancel）把编码任务派发给后台 worker agent（claude/opencode）执行。当用户想「派个任务给 claude 后台跑」「把 X 丢给 worker 做」「dispatch a task to the worker agent」「agent-flow 派活」「后台任务跑完了没」时使用本 skill。用户希望任务不阻塞当前对话、由独立 runner 进程在指定项目目录里干活、终态推飞书通知的场景都适用。在派发前先用本 skill 的规范拼出自包含的任务 prompt（worker 不共享会话上下文），并遵守同目录不并发、needs_input 续跑等约束。
agent_created: true
---

# Agent Flow Dispatch

## Overview

通过 agent-flow-ex 的 MCP 工具把编码任务派发给**独立后台 worker**（真实 `claude` / `opencode` CLI，detached 子进程），立即返回 `task_id`、不阻塞当前对话；任务终态（完成/失败/取消）自动推飞书，无需轮询。worker 在指定 `project_path` 目录下工作，**不共享当前会话的任何上下文**。

**何时用**：用户想把一项编码任务交给后台 agent 执行（如"把 X 项目这个功能做了""让 claude 后台跑个任务""派活给 worker"）。**何时不用**：① 任务需要当前会话上下文才能完成、需要与用户实时交互、或用户只是想讨论方案；② **返工量小且强依赖本会话上下文**（审阅结论、按 Task 边界拆 commit 的 Task→文件映射、两条 nits）——这些重新喂给 worker 比自己做更贵，而且容易走样。9/15 实测：一个 24 文件的脏树 + 6 处修正，自己做完（8 个 commit）比写一份能覆盖全部上下文的工单更快、更准。

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

不要把"能查的"丢给 worker 自己去查——调度方事前查清能让 prompt 字数翻 3-5 倍但 worker 跑得更快、token 用得更省。派发前对照下面 9 项自查，每项**写进 Context** 而不是口头交代：

1. **项目路径 + 技术栈 + 构建/测试命令**：从仓库根 `package.json` / `AGENTS.md` / `README.md` 现拿，不要凭印象。
2. **必读文档**：项目内 spec/plan/调试文档（如 `docs/superpowers/plans/xxx.md`、`docs/debug/yyy.md`）的**绝对路径**——worker 自己 `find` 可能错过。
3. **已跑过的命令与结果**：你（或前序 worker）已经做过的"事实"——如"`bun --version` 输出 1.4.0"、"已 grep 确认 render-node-to-output.ts 双改动共存"、"前序 worker 在 5 次采样中测得 CPU 53%"。**标注来源**（"由调度方已确证 / 由前序 task_xxx result 第 §Y 节确认"）。**计数类结论必须连口径一起给**（数的是什么、在哪份语料上数的）——9/15 实测：一次 `grep` 把"自动压缩触发 0 次"数成 8 次并推出成本论证，语料里命中的全是对话引用的源码文本；口径错的数字会让 worker 照着假前提动手（`references/confidence-check.md` 第 10 条）。
4. **已 grep / 已 cat 过的嫌疑代码行号**：如"`use-selection.ts:116/136 setter 在 127/143 行`"。worker 不用再排查，直接读这些行号就能动手。
5. **已知失败模式 / 排除路径**：如"8-26 文档 §1.6 记载 `--parallel=2` 158s/12 fail 兜底基线"、"已确认不是 `mock.module()` 污染"。让 worker 不要重走已排除的路。
6. **环境陷阱**：机器上并存多个版本（双 bun、双 claude、双 node）、用户的预存在 dev 进程、PATH 注入要求——这些 worker 会踩。
7. **验收标准可证伪吗（派发前先自己跑一遍）**：逐条读 plan/验收清单里的命令，尤其 **grep/search 类**——搜索范围里是否包含**本任务将要新建的文件**？那种「期望无输出」的验收从设计上就不可能成立。9/13 实测：一条 `grep -rn "read_spec_section" gateway/src gateway/test` 期望无输出，而该任务正要新建的 tripwire 里就写着这个字符串 ⇒ 该验收**永远不可能通过**，worker 只能误报 "No matches found"。**发现不可证伪的验收，先改 plan 再派发**；同理，把本机已知的**环境性失败**（如沙箱禁 `ps` 导致某测试必失败）写进 prompt，标注"这些失败不是你造成的"，否则 worker 要么瞎修要么漏报。
   **五个更隐蔽的变体（9/15-9/16 实测，同一份 plan 上先后抓到 5 处 + 10 处 + 3 处）**：
   - **算术不闭合的断言**：验收里的数字**根本够不到它要越的那条线**。9/15 实测：回归 pin 写 `usage.input = 100_000`，而阈值是 `contextWindow - bufferTokens` = 200,000 − 13,000 = **187,000** ⇒ 该断言按字面写**不可能通过**，worker 只会把它"修"成一个**因为错误原因而变绿**的断言。判据：把验收里的**每个数字代入式子算一遍**，别只读文字。同理——断言里若写 `!==` 来区分两个函数，先确认 fixture 上**两者真的不同**（9/15：无 usage 时两个估算函数回落到同一条 walk ⇒ `!==` 恒假，断言是空的）。
   - **plan 的行号会在任务落地后失效**：同一份 plan 里的任务串行落到**同一个文件**时，**先落地的那个任务会让后面所有任务的 `:NNN` 全部偏移**。9/15 实测：B1 给 `context-compactor.ts` 加了 9 行 ⇒ Task 3 的 `:107`/`:142` 变成 `:108`/`:151`；照 plan 字面改会改到**另一行**（`const messages = context.messages;`）而且**改完看起来是对的**。⇒ 派发前对每处 `:NNN` 用 `git log -S`/直接读树**重新推导**，并在 prompt 里给**当前**行号 + 明确写出"这是 post-<前序任务> 行号"。**重新推导必须覆盖该节全部 `:NNN`，抽查不构成核对**：9/16 实测，先抽查 2 处 → 报"2 处失效"、看起来已核完；全量重推 → **6 处失效**（另有 4 处因行号正确而抽查不到）。数字小到像一个正常的抽查结果，正是它危险的地方。
   - **断言的"范围"大于它的"意图" ⇒ 会为错的理由变红**（前两条的镜像）。9/15-9/16 实测：验收写"prompt 里不出现「系统」"，而该断言的**真实意图只是角色标签**（`[系统]` 不该再出现），可是同一任务要新写的 prompt 模板**故意保留中文说明性散文**（跟随 reply-language），正文里合法地出现"系统"二字就让整条断言失败。⇒ 逐条问"这条断言的**主语范围**是否就是我要测的东西"；否定式断言尤其要先划边界（限定到被改造的那一段文本，而不是整个产物）。
   - **验收要用一个"没定义的量" ⇒ worker 会连比较式一起发明**。9/16 实测：Step 写"then check the hard limit (`summaryContextWindow`) for ④"，这是**方向不是算术**（比什么、`>` 还是 `>=`、留多少余量都没写），而同 plan 的测试要点里**有一条必须触发 ④ 的验收** ⇒ 谁写那条 fixture 谁就得顺手发明比较式，再对着自己的发明写测试。⇒ 逐条问"这一步里的每个量，**定义**在哪？"；只要某个量在 plan/spec 里搜不到定义，就**先补定义再派发**（本轮补出 D17，并顺带发现按最自然的读法 ④ 是**永远不会及时生效的死分支**——余量项不能省）。
   - **要求 worker 补 pin，却只给语义不给算术 ⇒ 夹具会没有判别力**（第 4 条的镜像）。9/16 实测：plan 写"两条 `user` 验收行拆成独立测试"，worker 照做了、断言也如实，但**没有任何变异能让它们红**——夹具是"巨大 user + 一条小 assistant"，规则写错也不会有任何 `trimmed.*` 变化（实测把 `user` 计入预算后四个测试文件 **89/89 仍全绿**，而"`user` 不进软预算"正是这轮设计的核心权衡）。判据："这条断言能红"≠"这条断言有判别力"。⇒ 工单里凡是要求"补一条 pin"的地方，必须同时给**算术**：夹具里那个"规则错了就会被销毁"的行 + 一条证明输入真的越线的断言（本例 `serializedChars > SUMMARY_INPUT_TOKEN_BUDGET * 4`）。少了后者，前几条会在下次有人调夹具尺寸时一起变空洞，而它自己不会报错。
8. **这条验收无人值守跑得动吗？** 两类必须**在派发前挑出来**，否则 worker 只能空跑或伪造：
   - **跑不了的**：需要真实终端 / 交互式 REPL / 人工输入 / GUI 的步骤（9/14 实测：plan 要求 `bun run chat` 后手打一句话、断言模型回复含 `BANANA`——`chat` 是 readline REPL，后台进程无法可靠驱动，模型挂起或凭据缺失时也没有干净的失败信号）。这类**划给会话持有方**，并在 prompt 里明确写「跳过、不要尝试、不要凑一个"看起来过了"的输出」；能管道化的变体（`printf '…\n/exit\n' | bun run chat …`）作为可选替代写进「未决问题」，不要擅自执行。
     **但"跑不了"这个判断本身也要探**：先问这条流程有没有**真实的分发路径**可以无人值守驱动，REPL/UI 往往只是壳。9/15 实测：`chat` 只在 REPL 里特判 `/exit` 与 `/quit`，斜杠命令根本不经过它（分发在 `handlers.ts` 的 `chat.send`，即 WS 路径）⇒ 用一个几十行的 WS 客户端就无人值守跑通了 `/remember` 与 `/rewind`，而且斜杠命令在回合之前短路，**不烧模型额度**。同一轮还纠正了管道变体的失败原因：不是「turn 被截断」（CLI 确实 `await` 了它），而是 readline 丢掉「没有 pending question 时到达的行」且没人在 `close` 上退出 ⇒ `/exit` 被吃、卡在 EOF。**无人值守驱动交互式 CLI 的正确形状**：自己持有 stdin（别用一次性管道），只在看到下一次提示符后再写下一行——提示符即使 stdout 重定向到文件也会落进那个文件，可作就绪信号。
   - **先改 plan，再派发**（当被派发的产物本身就是可提交的 plan 时）：worker 读的是 plan，plan 里写着跑 `chat` 它就会去试、或去凑一个"看起来过了"的输出——**只在 prompt 里单方面绕开是不可靠的**。若本仓有「验收步骤跑不动 / 观测不到 / 不可能失败 ⇒ 改 plan 并把原因写进 commit」的约定，就照做：单开一个 commit 把 Task 拆成「worker 可跑」+「会话持有方（显式标注 skip — do not simulate、reported as not run）」，再派发。9/14 实测：motelet 阶段 2 plan 的 Task 8 拆成 8a/8b 后提交，比在 prompt 里打补丁干净。同一 commit 里顺手写清「环境性失败不归 worker」（如某基线失败源于沙箱禁 `ps`，而 worker 的 detached shell 有 `ps` ⇒ 它报 0 fail 不是矛盾），否则 worker 要么瞎修要么漏报。
   - **自己把自己跑空的**：验收命令解析的是**移动的 ref**，而任务本身会把树改干净。9/14 实测：`bun run test:changed`（= `--changed=HEAD`）在任务全部提交后打印 `--changed: 2 changed files, but no test files are affected` / `Ran 0 tests` —— 「Expected: 0 fail」被"一个测试都没跑"满足，是假通过。⇒ 换成**显式文件清单**。
   - **观测不到的**：验收写「输出应包含 X」，但那条命令的**输出通道根本不携带 X**。9/14 实测：plan 要求跑 `bun run chat` 后断言模型回复含 `BANANA` —— `chat` 的 `sendTo` 只处理 `captain_start`/`captain_end`/`crew_start`，而助手文本以 `captain_<event.type>` 抵达、落进一个**没有 default 分支**的 switch ⇒ 回复永远不会打到 stdout（`cli.ts:159-166`）。⇒ 约定：**对"输出含 X"类验收，先确认通道**；能落到**持久化产物**就断言产物（session jsonl / 日志文件）而不是 stdout —— 日志尤其常见：项目把 DEBUG 写进 `~/.motelet/logs/*.log` 而非 stderr。
   - 通用规则：**「0 fail」必须附带非零的测试数才算证据**（`Ran 0 tests across 0 files` 不是通过）。这条同时写进核验侧。
   - **「X 让 Y 结构上不可能」类实现断言也要探针**：走一遍**真实路径**（往往是「先钩子、后工具」两步），别用单次调用代替。9/15 实测：spec 论证「写层拒绝 ⇒ 工具碰不到 memory ⇒ `backupFile` 不需要谓词」，而钩子在工具**之前**跑 ⇒ 被拒的调用已经进了备份索引。断言"某路径不会到达某个写入者"时先问**谁会先到那里**；守卫要加在唯一写入口上，不能建在"调用方会先拒绝"上（详见 `references/confidence-check.md` 第 8 条）。
9. **多文件测试的"调用形式"也要抄对**：同一个文件清单，裸跑 vs 带 `--isolate` 会给出相反结论。9/14 实测：15 个文件的 backup/rewind 清单，**裸跑 `bun test <15 files>` = 104 pass / 55 fail；`bun test --isolate --parallel=4 <同样 15 files>` = 159 pass / 0 fail**（总数同为 159）。worker 报的是后者。⇒ plan 里给的命令若没带 `--isolate`，**先自己跑一遍再加**；否则 worker 会照抄出一个"你这机器上坏了"的结论，或者自己偷偷加上却不汇报。

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

**收到飞书终态卡后的核验流程（防假阳性约定）**：worker 报告**默认不完全采信**。按 `references/confidence-check.md` 走 5 问核对（worker 自报的数字/路径/行号每条能否定位到证据；不能定位即标低置信度）+ 置信度三档（高/中/低）分级。低/中 → 取**完整**报告复核（⚠️ `agent_flow_status` 返回的 `result` **会被截断**，长报告拿不到；全文在 `~/.agent-flow-ex/logs/task_<task_id>.jsonl`，见排错表）；不能闭环 → `agent_flow_submit({ continue_of, prompt: <反问> })` 走 needs_input 反问或 `agent_flow_cancel` 重派。**不要把"看起来完成"的报告直接转给用户**。

**终态是 timeout / 没有报告时**：先看项目根 `HANDOFF.md`（worker 临近预算用尽时会写：已完成的改动、残留部分、下一步、如何验证），再 `git status` + `git diff --stat` + 逐项对照工单，判断是"改完了没验"还是"改到一半"——前者按验收清单自己跑完（**变异必须亲手补跑**，那正是超时时跳过的一步），后者才重派并在工单里写明残留。别因为"没有报告"就当作"没有产出"。另：`error TS` 这类"回到基线"的验收要按**集合**证，不能按计数证（+1 新错误可能被 −1 无关修好抵消）。

`failed` 的第三种成因（9/17 实测）：**不是超时，而是模型侧 429 额度上限**（`"error": "API Error: Request rejected (429) … Token Plan 用量上限"`，`rounds: 1`、`elapsed < timeout`）。额度恢复后 **不要重派**——工作树是完好的，按上面的流程自评一遍即可。三个具体点：
- `agent_flow_status` 的 `files_changed` **可能比 `git status` 列得多**（worker 做变异测试时 `cp` 改了又还原本，如 `helpers.ts` / 被 scope out 的文件；9/19 实测另一成因：**只是被 Read 过、从未编辑**的文件也进列表 —— 850 报 6 个、实际改 2 个，多出的正是它自己声明"未碰"的 spec 与脚本）→ 以 `git status` 为准，别当成不一致。**"Read 也算"这条成因 9/20 已修**（runner 侧按工具名过滤，只读工具的路径不再进列表）；`cp` 类"改了又还原"仍是真实的过度报告，下一条复算规则也照旧。**同理，报告里的增删行数也不可直接采信**：850 自报 src `+15/-1` / test `+180/-18`，`git diff --numstat` 实为 `+14/-1` / `+166/-17` —— 一律以 `numstat` 复算。
- 中断点在"源码改完、验收未跑完"时，最容易的残留是**它新写的测试代码自带新 `error TS`**（实测 600→605，5 行 / 3 条唯一，全在新增测试里：类型谓词不可赋值、`toBe` 两侧一边带 `!` 一边是 union、`SessionEntry` 没窄化）。这类修一下就好，但**必须自己修**——那是判"是否回到基线"的分母。
- 取基线的**首选方法**是 `git worktree add --detach /tmp/<name> <base-sha>` + 在两个位置软链 `node_modules`（仓库根与 `gateway/`）→ 在 worktree 里跑本地 bin 的 tsc。**完全不碰当前工作树**，比 `stash`/`checkout --` 安全得多（两者都会把未提交的成果置于风险中），用完 `git worktree remove --force` 收尾。归一化时注意 worktree 会改变相对路径前缀（`../packages/…` vs `packages/…`）与内嵌的绝对路径——先按前缀归一，再 `comm`，否则会看到成对假阳性。

**验收型脚本（探针）的复核另有一套六问**——它的产物是"一次观测"，不是断言本身，所以"跑绿了"不等于"验到了"。9/17 实测：一份结构完全正确、隔离严密、RED/GREEN 都能判别的探针，**它跑的那次压缩其实什么都没压**，而它自己写的"确实切掉了东西"断言恒真，没能拦住。
- **它观测到的主体动作真的发生了吗？** 别用脚本自己报的"PASS"当证据，去读被观测对象的**持久化产物里的真值字段**。同一个"压缩是否生效"的例子里，`marker 是否还在` 是启发式，`details.removedCount` 是事实——优先事实。
- **断言的候选集里有没有"事件之后才产生"的元素？** 有就恒真。上例的判据集是 `全部标记 − kept 段里的标记`，而其中一个标记是**验证轮**（边界之后）才生成的提示词，天然不在 kept 段里 ⇒ 永远非空 ⇒ 断言不可能失败。写判据时先问：这个元素在事件发生前存在吗？
- **脚本里有没有 `skip` 分支？** `if (… ) { fail } else { console.log("skipping …") }` 是回归的藏身处——真正该做的是把 else 也变成 fail，或说明为什么那条路走不到。一个验证脚本里出现"跳过断言"就是缺陷本身。
- **报"观测成功"时附上它测的量级**。上例若早报一句 `removedCount=0, serializedChars=0`，"成功"会立刻露出问题。
- **参数是否让被测行为不可达？** 两个不同口径的量（触发用的 usage 口径含系统提示开销，切分用的 char 口径只看消息）会让触发先于切分预算达成 ⇒ 被测动作结构上不可能发生。这类问题改参数，不是改代码，但**必须改**，否则整轮验证没有意义。
- **改法：把尺寸从"试出来的常量"改成"运行时测量 + 不满足就拒绝"**。上例的定式（可直接套）：先在第一轮观测里**测出**固定开销 `H`（= 首轮 `tokens − 2×prompt`），规则是 `H < threshold − 4P`（第 k 轮触发满足 `tokens(k) = H + (k+2)P`，要 k ≥ 3 才代表上下文里已有两轮重消息、切分才切得到种子标记），由此**反推** window/prompt 两个默认值（实测 H ≈ 7 179 → window 66 000 / prompt 48 000）。再补两条便宜但关键的自检：**期望的 threshold 必须等于被观测进程报出的 threshold**（否则配置替换没落地，后面所有算术都是虚构的）、**验证轮若又触发一次压缩就算失败**（否则它那条 `messages=` 是压缩前的数，报告会自己骗自己）。拒绝要带**可执行的修复值**（"re-run with --context-window X"），不要只说"参数不对"。
- **谁改：诊断已在手里、改动只有几行时，自己改比再派一轮快**，而且省一次上下文传递（这次就是这么做的：改 4 处、自己跑 GREEN/RED、恢复用 `cmp` 证明）。只有当修复需要**新的探索**（根因还没定位，或要改动被测代码本身）时才重派，并且工单里要带上已有诊断，别让 worker 从头再查一遍。
- 复核完毕记得**清现场**：探针的临时根里常有配置副本（可能含密钥），跑完核对该副本与用户真实配置都没被动过，再删。

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
| **`agent_flow_status` 的 `result` 只给到一半**（长报告在句子中间断掉、承诺的小节没出现） | **不要重派、不要据此猜结论**。全文落在 `~/.agent-flow-ex/logs/task_<task_id>.jsonl`（每行一个 JSON）。抽法：逐行 `json.loads` → 递归收集 `{"type":"text"}` 的 `text` → **先打印每块的字符数**，最终报告是其中最长的那块（**别盲取最后一块**：实测 T0 报告是第 2 块、阶段 2 是第 18 块）。9/20 一天踩了三次（11 088 字符的报告 MCP 只回一半）。一段可直接用的提取：`/Users/meow/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -c` 里做上面的 walk，把最长块写到 `/tmp/t<stage>_report.md` 再 `Read`。|
| **要回读「工单正文」而不是报告**（核对某阶段当初派了什么 / 查 task_id ↔ 阶段的对应） | 工单是 JSONL 的**第一条**记录，形状 `{"type":"user_prompt","round":…,"text":"…"}` —— **顶层 `text` 字段**，**不是** `message.content`（后者是 assistant 侧文本块的形状）。字段用错会**静默拿到空串**：9/20 实测按 `type=="user"` + `message.content` 抽 12 个文件全空，差点误判成"日志没存工单"。另：`task_id` 带随机后缀 + 阶段号只写在工单正文里 ⇒ 想知道「阶段 N 是哪个 task_id」只能这样回读，不要凭记忆写进 spec。|

## Resources

- `references/prompt-templates.md` — 派发工单 / needs_input 答复 / 只读评审 三类提示词模板。
- `references/confidence-check.md` — 收到 worker 终态报告后的防假阳性 5 问 + 置信度三档分级 + 采信前的十个机械核对（git 数改动 / 重量行为断言 / 检查 plan 是否偏离消费方 / 测试结论先对齐沙箱 / 「无输出」类验收自己重跑 / 接口字段逐条对测试 / 「0 fail」必须附非零测试数 / 「结构上不可能」类断言用探针走完整路径 / plan 断言表与测试名对表 / 计数先定口径、按结构字段数）+ 把交付按 Task 边界落成 commit 时的文件重叠规则 + 「这条断言在旧代码上会失败」要自己用最小 mutation 跑出来（含基线测量的文件级 cp 法）+「plan 步骤本身不可满足时先修 plan，不要改 worker 已正确的代码」。
