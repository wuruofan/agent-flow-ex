# Worker 报告置信度核对

worker（后台 agent CLI）的终态报告**默认不完全采信**——M3 worker 整体诚实但有边界（见 SKILL.md Step 4）。收到飞书终态卡后必须走这份核对，再决定是否把结果转给用户。

## 为什么不能直接采信

来自 9/3 真实任务的两个边界场景：

- **截断**：notifier 推飞书时 `MAX_RESULT_LEN=4012` 字符，长报告的 §止血建议 / §遗留问题经常被切掉——只看卡片可能漏关键信息。
  **补救路径（9/19 实测）**：全文在 `~/.agent-flow-ex/logs/task_<id>.jsonl`（完整 worker 会话）。
  用 python 取收尾报告：逐行 `json.loads`，`type=="assistant"` 时遍历 `o["message"]["content"]` 里
  `c["type"]=="text"` 的 `c["text"]`（取最后一条含 `## ` 的），或 `type=="result"` 的 `o["result"]`。
  两个反例别走：`~/.agent-flow-ex/tasks.db` 的 `result` 列**同样被截**（9/19 实测 `len(result)` 恰为 4012，
  是**记录时**就截了，不是卡片层截的）；`tasks.db` 的 `log_path` 字段指向的是另一个 **0 字节**的
  `logs/task_<id>.log`，不是全文。
  ⇒ 所以「§5–§7 没出现」在卡片上与「worker 根本没写」**不可区分**，唯一判据是去 jsonl 里找。
  9/19 实测：一张被截到只看得到 §1–§4 的卡，jsonl 里 §5/§6/§7 完整，且 §6 的结论**与我独立复算的一致**
  （都指向 gateway 侧的 `context_window > 0` 过滤）——差一点就因为「报告没写」而误判 worker 漏答验收条款。
- **事实继承**：调度方 prompt 里写的"前序已确证事实"会被 worker **直接采用而非复核**。前序 worker 报告本身可能有未排除路径。

## 防假阳性 5 问

收到 worker 报告后逐条问，能定位到证据的项打 ✓：

1. **数字可定位？**（pass/fail 数、文件路径、行号、PID、耗时、CPU%、内存）—— 每条都能从日志/代码/进程状态直接复现吗？
2. **路径真实存在？** worker 引用的每个文件路径用 `Read` 或 `ls` 确认存在。
3. **因果链自洽？** "因为 X 所以 Y"——X 与 Y 之间有没有显式证据链？有没有内部矛盾？
4. **排除路径写出来了吗？** 调查类任务应自带"❌ 不是 A、不是 B、不是 C"清单——只说"是 D"但不说"为什么不是 A/B/C"的可信度打折。
5. **遗留问题已标注？** worker 自己声明的不确定/未达成项（如"§遗留问题请调度方裁定"）——没标的可信度打折。

## 置信度三档

| 档位 | 5 问命中 | 处置 |
|---|---|---|
| **高** | 4-5 问 ✓，无内部矛盾 | 直接转给用户，附 task_id + 关键产出路径 |
| **中** | 3 问 ✓，有 1-2 项需复核 | `agent_flow_status({ task_id })` 拉完整 result 复核后再转；若复核仍模糊，走 needs_input 反问 |
| **低** | ≤2 问 ✓，或自相矛盾，或关键事实无证据 | **不直接转用户**。要么 needs_input 反问让 worker 补证据，要么 `agent_flow_cancel` 重派（带更明确的 Context） |

## 真实例子（来自 9/3 task_mtla69fx_3872f3 vs task_mtljliko_759d7a）

同一 stall 调查的两轮报告，置信度差异显著：

### task_mtla69fx_3872f3（首次调查）— **中**

- ✓ PID / 进程状态（ps 输出）真实
- ✓ 卡点文件路径 `streaming-drag-freeze.test.tsx` 真实存在
- ✗ "复现 3 次"——但 **3 次都用同一 PID 21722**，证据未排除"同次重试被算成 3 次"的可能
- ✗ 根因假设给出但**未写排除路径**（没说"为什么不是 X/Y/Z"）
- → 调度方（用户）当时直接采信了，导致后面要 task_mtljliko 又花一轮做根因定位。如果当时走 5 问核对，应当标"中"并 needs_input 反问补"3 次复现的 PID 列表 + 排除路径"。

### task_mtljliko_759d7a（根因定位轮）— **高**

- ✓ 5 次 sample 共享同一组 hotspot offset（0x2c5c9ff/0x2c5ca73/0x2ac55ff/0x2ac58ef/0x20edc18），可在 `/tmp/*.sample.txt` 直接验证
- ✓ ICU `RuleBasedBreakIterator::init` 在栈上反复出现（栈帧文本可读）
- ✓ 排除路径写得很完整："❌ 不是 --parallel=4、不是 preload、不是 warnings 本身、不是 mock.module 污染"
- ✓ 主因/辅因分层，证据链清晰
- → 标"高"，可作为修复实施的依据。

## 采信前先做的机械核对（9/11–9/15 实测）

5 问问的是「报告内部自洽吗」，下面十条问的是「报告与磁盘一致吗」——两类都要过。

1. **报告的文件清单当线索，不当事实。** 权威证据是 `git show --stat <commit>` 逐个看（或
   `git diff --stat <base>..HEAD`）。9/11 的 spec-B 交付里，runner 记的 `files_changed` 列了约 30 个
   **没有任何 commit 碰到**的路径（含它自己没改的 `docs/`），真实改动是 20 个文件。清单错≠活错，
   但清单错意味着**你不能靠它判断边界**：有没有夹带无关改动、文档有没有被「顺手」改、任务包不包含
   它没提的文件——只能靠 git 数。
   **且不要用 mtime 补判**：9/13 实测 `files_changed` 里的 `tools/core.ts`，mtime 读作 23:49:42 而墙上
   时钟是 23:38——沙箱写入代理会留下超前的时间戳。判断文件是否被改，只认 `git status` / `git diff`。
2. **commit message 里的行为断言要重量。** worker 常写「修了一个 latent bug」「对外行为不变」，
   这类断言不重量就没法写进文档。9/12 实测：message 声称旧代码把 `sh -c 'exit 3'` 报成 0 ——
   自建 detached 子进程、管道读到 EOF、读 `proc.exitCode` 但不 await `proc.exited`，128 次采样里
   124 次为 `null` ⇒ 断言成立，才敢写进 spec。**结论成立也要写明采样方式**，否则只是换一个人相信。
3. **偏离是双向的：plan 自己也可能偏离现实。** 别只问「实现有没有偏离 plan」，还要问「plan 的示例
   代码有没有偏离消费方」。同一交付里 `session_bash` 的载荷在 spec **和** plan 里都写成
   `entries: [entryA, entryB]`（裸 id），worker 照抄 ⇒ TUI 在字符串上取 `.content.length` 直接崩，
   靠真 PTY e2e 才抓到。⇒ 对 plan 里每处**跨进程契约**（WS 事件 / 载荷形状 / RPC 返回）单独问一句：
   **消费方会怎么用它**。
4. **测试结论先对齐沙箱，再判断真假。** 9/13 实测：worker 报 `bun run test:gateway` = 1679 pass / **0 fail**，
   本会话原样重跑 = 1676 pass / **3 fail**。**这不是 worker 造假**：3 个失败全是 `cli-port-conflict` 系，
   其 `inspectPort` 先 `lsof` 取 PID、再在 `prettyOccupant` 里调 `ps -p`，而 WorkBuddy 会话沙箱**禁 `ps`**
   （`operation not permitted`；`lsof` 反而可用）⇒ banner 降级到 "(could not identify occupant)" 分支，
   `PID ` 断言失败。worker 的 detached shell 有 `ps`（且 PATH 里没有 bun），所以它看到绿。
   ⇒ 收到「全绿」而本会话复现出 fail 时：① 查两侧沙箱策略差异（`ps`/`lsof`/端口绑定/网络）；
   ② 用 `git diff --name-only <base>..HEAD` 确认失败文件是否落在本次改动范围内。两者都不沾，才是环境差异。
   同一套测试在两侧结论相反是正常现象，**别把它读成回归，也别把 worker 的结果当唯一真相**。
   **同一个沙箱内，"调用形式"也能翻转结论**：9/14 实测同一份 15 文件清单，裸跑 = 104 pass / 55 fail，
   带 `--isolate --parallel=4` = 159 pass / 0 fail（总数同为 159）—— 是 `mock.module()` 单进程污染。
   ⇒ 复现时先对齐**命令原文**（有无 `--isolate`、`--parallel=N`、`--path-ignore-patterns`），
   别用自己顺手的那条去否定 worker 的结论。
5. **对「无输出 / 零命中」类验收，自己原样重跑那条命令。** 9/13 的 plan Step 5 要求
   `grep -rn "read_spec_section" gateway/src gateway/test` 无输出，worker 报 "No matches found"，
   实际有 **2 处命中**——命中的正是它自己刚建的 tripwire（`PHANTOM_TOOL_NAMES` 常量 + 注释）。
   这类「搜索范围包含本任务新建文件」的验收**从设计上就不可证伪**。⇒ 见到「无输出」结论就自己跑一遍；
   若 plan 的验收标准本身自相矛盾，**改 plan**（那是 plan 的缺陷，不是 worker 的），并在交付说明里写明。
6. **「测试全绿」不等于契约被覆盖——对接口的每个字段问一句「哪条测试钉住它」。** 9/14 实测：一份交付的
   16 个测试全绿、`result.text` / `result.truncated` / `result.finalChars` 三项全对，但
   `files[].finalCharCount` 与 `files[].truncated` 在被截断的路径上**双双报错**（前者报截断**前**的长度，
   后者恒为 false）。测试只断言了 `finalCharCount > 0`，没断言具体值 ⇒ 绿得毫无意义。
   ⇒ 核验时逐字段发问；答不上来的字段，用**临时脚本 import 真实模块**构造最小输入跑一遍——比读代码快
   得多，跑出来的数字还能直接当反例证据写进汇报（`/tmp/verify-x.ts` + `bun run`，别放进仓库）。
7. **「0 fail」必须附带非零的测试数。** 空跑不是通过。9/14 实测：`bun test --changed=HEAD` 在提交后的
   干净树上打印 `--changed: 2 changed files, but no test files are affected` / `Ran 0 tests across 0 files`
   —— plan 那句「Expected: 0 fail」被"一个测试都没跑"满足。⇒ 看 worker 报的 pass/fail 数时，**先问
   「跑了几个」**；`Ran 0 tests`、`no tests found`、`0 pass 0 fail` 一律按**未验证**处理。同理，报「全绿」
   时若与本会话基线（本机 1671 pass / 3 fail）差异过大，按第 4 条先对齐沙箱再下结论。

8. **plan 里「X 让 Y 结构上不可能」这类实现断言，要用探针走完整路径。** 9/15 实测：spec §5.6 论证
   「写层拒绝 ⇒ 文件工具碰不到 memory ⇒ `backupFile` 不需要谓词」，三层都"对"，但它把**时序**落掉了 ——
   拒绝在 `tool.execute` 内，而备份是 `beforeToolCall` 钩子，运行库**先 await 钩子再执行工具**
   （`@earendil-works/pi-agent-core@0.80.10` `dist/agent-loop.js:403-408` → `:442`）。⇒ 被拒的调用**已经**
   把路径交给 `backupFile`：`trackedFiles` / `fileEntries` 收录它，已存在文件的字节被复制进
   `checkpoints/<sid>/files/`，下一次 `snapshot()` 记成可恢复版本，rewind 会覆盖 `memory_write` 之后
   追加的内容。同一个断言加谓词前**失败**、一行早退后**通过** —— 这是唯一能把它钉住的形式。
   **要探的形态**：断言「某路径不会到达某个写入者」时，先问**谁会先到那里**。钩子 / 中间件 / 拦截器
   一律在工具之前跑，而「拒绝」几乎总在工具内部 ⇒ 拒绝挡不住写入者。
   派生一条：**「我们已经在别处拒绝了」不能替代对写入者本身的守卫**；守卫要放在**唯一写入口**上，
   而不是放在"调用方会先拒绝"这个假设上。
   **附带信号**：plan 里某条验收**没有单测孪生**、只有端到端版本时，通常不是"不值得写"，而是**它按
   字面写不出失败版本**。9/15 实测：plan 的「`trackedFiles` 不含 memory 路径」只有 REPL 端到端版，
   worker 因此整条跳过；补写时发现必须自己先调 `beforeToolCall`，否则测试恒绿。⇒ 见到"端到端才有"
   的断言，先试着写出它的最小失败版本；写不出来就是设计与实现之间有缺口。
   同一个陷阱在 **live 断言**上的形态：**"字节未变"必须先证明那个动作真的执行了**。9/15 实测：plan 的
   「`/rewind` 之后 memory 文件字节不变」在只发过斜杠命令的会话里恒真 —— `/rewind` 直接返回
   `No conversation history yet`，字节不变是因为**什么都没跑**。⇒ 读返回消息里有没有执行痕迹
   （`Restored to … changed N files`），或加一个**必须被改动**的对照物（本例：让模型写一个受跟踪的
   工作区文件，rewind 必须回滚它，而 memory 必须不动）。**只报"未变"而不报"变了什么"的检查，不能采信。**
9. **plan 的断言表与 worker 交回的测试名逐行对表，差额就是缺口。** 9/15 实测：Task 5 的 9 条断言里
   两条未实现 —— 一条被**换掉**了（换成了另一个断言，理由只写在测试代码的注释里 ⇒ plan 与 tree 不一致，
   而那半句偏偏是对的），一条是上文的"写不出失败版本"。两条都不是偷懒，是 plan 自身的问题。
   ⇒ 对完表后按"plan 也是产物、错了就改"处理：能补的补成可失败的测试，不能补的把理由写进 plan。
10. **自己算出来的数也要先定口径——语料是"数据"时，grep 计数会系统性偏高。** 9/15 实测：为给阶段 3
    的提取器做成本论证，统计 `~/.motelet/sessions/*.jsonl` 的压缩频率，`grep` 关键词给 4+4=**8**，
    据此推出"压缩占 1.4%、约每 74 turn 一次"，差点写进 spec；解析 JSON 按 `type` 字段计数后真值是 **0**。
    两个原因叠加：① 那两个是 **WS 事件、根本不落 session jsonl**；② 命中的全部是对话内容里
    **引用的源码文本**（那些 session 的主题就是 motelet 自身）。⇒ 数任何东西之前先问两句：
    "这个字符串会不会作为**内容**出现在语料里？""这个事件会不会**根本不在**这份语料里？"
    然后按**结构字段**（`type` / key）计数，不要 grep 文本。危险在于**它高得像一个合理数字**——
    不像"静默返 0"那样会引起怀疑，因此会一路走到被写进文档。

核对结论必须落回文档，别只留在对话里：契约错了就改 spec，实现偏离了就记 as-built
（编号 + 行号 + commit + 已修/未修 + 为什么）。

## 审阅另一个模型给出的 findings（9/14 实测）

把外部模型的 review 当成**一批待验证的断言**，逐条三分类，而不是整批采信或整批驳回：

| 分类 | 判据 | 动作 |
|---|---|---|
| **照单接受** | 断言指向的现场证据你能复现 | 直接改，并把改动落到所有引用点（见下） |
| **部分接受** | 现象成立但结论过重/过轻 | 接受现象、改写结论，把取舍写进风险表而不是硬吞 |
| **驳回（须带探针）** | 断言与磁盘不符 | **必须实测反驳**，不能只靠论证；把探针命令与输出记进文档 |

三条实测得来的规则：

1. **「参考实现里 X 是这样写的」是断言，不是事实。** 9/14 一条 review 断言真实 submodule 的 gitdir 目标
   带 `commondir`，因此拒绝路径会走结构校验 1。实测（临时 git 仓 + `git submodule add`）：submodule 的
   `.git` **确实是 `gitdir:` 前缀**（review 对了一半——plan 原文把「非 `gitdir:`」当成 submodule 分支才是错的），
   但目标目录**没有 `commondir`**、也没有 `gitdir` 回链，所以真实拒绝路径是 **ENOENT 回退**，不是校验 1。
   ⇒ 这类"某个生态系统的文件长什么样"的问题，30 秒就能造出来问磁盘；别用自己的记忆代替。
2. **接受一条就要扫掉它的所有引用点。** 同一条 finding 通常要改 4 处：决策表一行、算法步骤文本、
   测试夹具描述、风险表。只改一半 ⇒ 文档自相矛盾，下一个读者会照着旧的那半实现。
3. **核对「这个标识符在该作用域里存在吗」。** review 报的是"少了 `workspace` 守卫"，顺着这条读源码才发现
   plan 里那个分支用的是**裸 `workspace`**，而 `getToolsByName` 函数体内根本没有这个变量（只有 `opts`）
   ⇒ 是编译不过，不只是缺守卫。**缺守卫**和**标识符不存在**是两级问题，前者靠 review，后者靠打开函数读。

另外：**回归检查不必跑全量**。本轮改动只碰文档时，用 `python` 一次算完 `wc -l` / 制表符 / 围栏配平 /
表格列数一致（把未转义 `|` 计数按行比），比 `grep` 一串更可靠——尤其别用 shell 的 `grep -P`（本环境是
ripgrep shim，`-P` 直接报错，而我没看 exit code 差点当成"0 个制表符"）。

## 核验侧新增的四条机械检查（9/14 实测，一次 8-task 派发）

1. **`git status` 是文件清单的唯一权威，MCP 返回的 `files_changed` 不是。** 本轮 MCP 列了 36 个
   文件（含 `../cc-black/src/utils/git.ts`、`deny-paths.ts`、`backup.ts`、docs/*、若干 test），
   而磁盘上只有 23 个。**先 `git status --short` 对齐 plan 的 §2 文件表**，再看别的；否则会照着
   一张假清单去追越界改动。判"某文件是否被动过"用 `git status`，别用 `files_changed`。
   **机制已查实（9/20 读 agent-flow-ex 源码 + 复现）**：它**不是** worker 自述，而是 **runner 进程**
   解析 CLI stream-json 攒的 —— `src/executors/claude.ts:26-30` 取每条 assistant 消息里**第一个**
   `tool_use` 块，只要 `input.file_path` 是字符串就塞进 Set，**完全不判工具名** ⇒ `Read` 一样进；
   `src/runner.ts:114/152` 才落库（`src/tools/status.ts:31` 原样返回，无截断/过滤）。
   所以误差是**双向**的：**多报**（Read 过的文件全在 —— 9/20 实测某任务 20 个文件里 14 个只被 Read 过，
   `Read` 命中 15 次 vs `Write` 6 次）；**少报**（Bash 里 `cat > f`、`git mv`、heredoc 都没有 `file_path`，
   且每消息只取第一个 tool_use，并行调用其余全丢）。⇒ 不要指望"过滤掉某类工具名"能修好，
   **`git status` 永远是唯一权威**。本仓还有一处文档漂移：spec-v2 说"从 Edit/Write 事件累计"，与实现不符。
   **9/20 已修「多报」侧**：`src/executors/file-tools.ts` 的 `isFileMutatingTool` 按工具名分类
   （Edit/Write/MultiEdit/NotebookEdit + opencode 的 edit/write/apply_patch），Read/Grep/Glob 不再进
   `files_changed`；复跑 8 个真实任务，清单 123 → 41 条（−67%），一个只读核查任务从"报 18 个"归到 0。
   **「少报」侧未变**（Bash 里 `cat > f` / `sed -i` / heredoc 仍拿不到 `file_path`），所以上面那条
   "git status 是唯一权威"的结论**照旧成立**；spec-v2 那句漂移也随之消除（实现回到文档口径）。
2. **`git reflog` 能抓出 worker 用了你明令禁止的 git 子命令。** 本轮 ticket 写了「不 stash」，
   `git reflog` 却有 3 条 `reset: moving to HEAD`（22:54 / 22:56 / 23:03）—— 那正是 `git stash`
   的内部动作。`git stash list` 看不出（stash+pop 的条目会被 drop 掉），**只有 reflog 留痕**。
   同时用 `git reflog show stash --date=iso` 确认没留下孤儿 stash（本轮 5 条全是 9/9 及更早的旧条目）。
   结论模板：**(a) HEAD 未变、无多余 commit；(b) 变更完整；(c) 指令被违反但未造成损失** —— 三件事分开说。
3. **计数类验收（`wc -l` / `N pass`）必须用同一条命令自己复跑，并核对"新文件是否出现在结果里"。**
   本轮 `npx tsc --noEmit | wc -l` 在本沙箱给 **9**（`npx` 是 WorkBuddy 受管 node 的 npm npx，解析到了
   同名占位包并打印 "This is not the tsc command you are looking for"），而 `./node_modules/.bin/tsc`
   给 **1069**（TS 5.9.3）——与 plan 记录一致。⇒ 报数前先 `--version` 确认**跑的是哪个二进制**。真正
   有说服力的不是行数相同，而是 **"结果里 0 条提到本次新建的文件"**（新文件不可能有历史错误）：那条
   `grep -c` 为 0 才是"没有新错误"的证据，行数相同只是辅助。
4. **"环境性失败"要读错误正文，不要接受转述。** 本轮 worker 报 0 fail、本沙箱 3 fail，抓失败正文看到
   banner 写着 `(could not identify occupant — lsof unavailable or insufficient privileges)` ⇒ 归因确认，
   且**总数 1777 两边完全一致**（1774+3 = 1777）才是"同一套测试"的证据。总数一致 + 失败正文指向环境，
   才算把"结论相反"解释掉。

**顺带一条报告算术**：worker 的 prose 会说 "94 new tests"，而 `baseline_total → now_total` 才是硬账
（1686 → 1777 = **+91** = 新建文件 88 + tripwire 3）。逐文件跑一遍拿到 35/23/10/10/10 就能钉住它。
数字对得上但 prose 的加总错，属"诚实但算错"，单独指出即可。

## 把交付落到 commit 时（9/15 实测）

按 plan 的 Task 边界拆 commit 前，**先算 Task → 文件 的映射**，找出被**多个 Task** 触碰的文件：

- 一个文件被两个 Task 改过，`git add <file>` 就**拆不开**（除非 partial staging / `git add -p`，脆弱、
  不值得）。9/15 实测 `tools/core.ts` 同时承载 Task 4（注册点 + role 传参）与 Task 5（`file_write` 的
  写层拒绝）⇒ 只能把 Task 5 的一半并进 Task 4 的 commit，并在 message 里**明写**这件事。
- 因此"N 个 Task ⇒ N 个 commit"常常做不到。**如实说明哪条边界被物理合并、为什么**，不要硬凑，更不要
  为了提交美观去重排代码。
- 用**显式路径** `git add`，不要 `git add -A`（脏树里混着无关 untracked 文件时会被卷进来）。
- 中间态 commit 是否全绿，若无法 checkout 验证（脏树 + 未跟踪文件，或新 worktree 缺 `node_modules`），
  **汇报里要写明"末态已验证、中间态是按文件集合推断的"** —— 不要把推断说成实测。

## 引用行号/类型前的最后一道自检（9/15 实测，两个坑各踩两次）

写 spec/plan 的 `file:line` 引用时（尤其是"某类型有字段 X"、"某函数在 :N"），两种同名副本会让引用**看起
来对、实际指向另一份**：

1. **同一逻辑对象有第二份类型定义。** 9/15 我在同一份 spec 里两次引错 `CompactionEntry` —— 仓里有两
   份同名接口（`harness/compaction.ts:43` 带 `keyDecisions` 但不落盘；`session/index.ts:206` 才是
   `appendCompaction` 真用的），我按"另一份"写了字段表，于是把"不落盘的字段"当成落盘字段、把"未被调用
   的函数"当成在用。⇒ 引用类型字段前先问一句："这个字段是**哪一份**类型上的？我引的那份**真的被写入
   路径使用**吗？"**判据是写入点的实参**（`appendCompaction(...)` 的第四个参数），不是类型定义。
2. **同一语义的常量/算式在仓里有多份。** 9/15 同一份 spec 里两个 token 数各有三套口径（触发用
   `chars/4`、落盘 entry 用 JSON 长度、provider 报的 `usage`），我拿其中一套去论证另一套的准确性。
   ⇒ 见到数字先定位它的**生产点**，再决定它能被拿来论证什么。

通用做法：**引用前把定义与使用点各读一次**（定义 `grep -n "interface X"`，使用点读实参），
不一致时以**使用点**为准；两者都写进 spec 并标明是哪一份。同一个错犯两次，说明第一次只核了"存在"、
没核"被谁用"。

## 「这条断言在旧代码上会失败」要自己动手跑出来（9/15 实测）

plan/ticket 里最容易被"讲通"的一类交付，是「每条新断言在旧代码上都会失败」——**说得通不等于成立**，
而一旦这些断言在旧代码上也绿，整套测试就只是在测自己（尤其那条"最易静默退化"的不变量）。
核验侧不要读完机制解释就走人，用**一次最小 mutation 把「旧行为」复现出来，跑一遍，看它变红，再从备份还原**：

- 本轮（motelet Task 1）证两条：① `estimateTokens` 拓宽到 thinking/toolCall 后新值必须变大；
  ② `[compaction-input]` 日志行必须落在那次 early return **之前**（§3.5-3 的观测前提）。
  做法：注释掉 `countableChars` 的 thinking/toolCall 两个分支（= 旧 text-only 行为）→
  跑新测试文件 → **case 2 `182→100`、case 7 `98→50`，两条精确变红**；还原后，把
  `if (!overThreshold) return` 复制到日志行**之前** → 那条钉子在 `existsSync(gatewayLog)` 处变红
  （`Expected: true / Received: false`）⇒ 它写的失败版本**真的可触发**。
- **还原必须可证**：改前把产物 `cp` 到 `/tmp`，改后 `cp` 回来，再 `diff -q` 逐文件证明与产物**逐字节相同**
  （本轮 4 个文件 `ALL IDENTICAL`）。只跑一遍测试然后口头说"我改回去了"是另一种假阳性。
- **更省的一种（优先试）：先看「参数」能不能把被测行为强制到另一侧 —— 能，就完全不用改源码。**
  本轮（motelet `agents` 层）要证"预算内必须给出完整形态 `- name: description`"这条断言有判别力：
  没碰源码，直接调 `formatSkillsListing(skills, /* budget */ 1)` 逼它走降级分支，把两边输出打印对拍 ⇒
  降级输出**不含**该整行 ⇒ 断言确实会红。断言正确、零还原风险、一条命令完成。
  **判"这条断言能不能变红"之前先问：被测函数的哪个人参直接控制那个分支？**（预算 / 大小上限 / 阈值 / 开关 / 模式）
  找不到这样的人参，才退回上面的改源码 + `cp` 备份法。
- 顺带一个体检项：**worker 自报的 tsc 数字要自己拉基线**。"1069 → 1068，无新增错误"只有在
  `monitor.ts` 的错误数**同向减少**（5 → 4）时才自洽；总数只减 1 也可能是"旧错误消失、新错误冒出来"，
  必须按文件分别数。
⚠️ 基线测量**不要用 `git stash`**（见 `~/.workbuddy/MEMORY.md` 的 stash 参数顺序陷阱）：正确形式是
`git stash push -m msg -- <paths>`；写成 `git stash push -- <paths> -m msg` 时 `--` 之后**全是 pathspec**，
`-m`/`msg` 被当成路径 ⇒ push 失败，而链在后面的 `git stash pop` 会去 pop **别人的旧 stash**。
用文件级 `cp` 备份 + `git show HEAD:<path> > <path>` 覆盖 + `cp` 还原，全程不碰 git 状态。

**worker 的 mutation 表是断言，不是证据——自己重推一遍（9/16 实测，motelet Task 3）。**
本轮 worker 交的 5 行 mutation 表逐行实测**全部成立**，但重推后发现它没做到两点：

1. **一条 mutation 打红多条 case，只证明这些 case 同源，不证明每条都有判别力。** 它用「撤销翻转」一条
   mutation 覆盖 case 1/2 ⇒ case 2 在自己的 pin 上是**未被验证**的。逐 case 换 mutation 后：
   `tokensAfter → estimateContextTokens` 只打红 case 5、entry 写陈旧本地量只打红 case 4、
   把 `monitor.ts` 的 trailing slice 去掉只打红 case 2 —— 这才把 case → 行 的映射钉住。
   **做法**：为每条 case 各挑一条"只有它该抓"的 mutation，看它是否**独占**变红（多红 = 同源，单红 = 判别力）。
2. **"scope 限制导致这条 mutation 做不了"不是证据。** worker 把 case 2 的精确 mutation（改
   `monitor.ts`）报成不可行 —— 因为 ticket 把该文件列为 out-of-scope，这对 worker 成立、对**调度方不成立**：
   调度方可以临时改 + 跑 + `cp` 还原。实测那条 mutation 精确打红 case 2 且 case 1 保持绿
   （case 1 的值本就过线），即它**正是** plan 为 case 2 命名的失败形状 ⇒ 该 case 是真 pin，worker 报的偏离
   属于"**诚实但过于悲观**"，要在 as-built 里改写而不是照抄。
   还原后必须核对三样：哈希一致 + `git status` 恰为 in-scope 文件 + `git diff -U0 | grep '^-[^-]'` 逐条对。

⚠️ **"有失败版本" ≠ "跑过了它要覆盖的分支"。** 同轮 case 5 的夹具（5 条消息共约 7 token）永远到不了
20K keep-window，`cutToKeepRecentTokens` 直接走 `cutStartIdx === -1` 早返回 ⇒ 它**从不真的切**
（summarizer 收到空 history）。断言的 `!==` 半边靠"kept 就是全量、因而带着大 usage"侥幸非空，
判别力实测也在（改 `:147` 只打红它）—— 但"pin 有效"和"夹具走过了它要覆盖的路"是两件事。
⇒ 逐条问**夹具真的走了那条分支吗**，不只问"这条断言能红"。

**"把计数器改成 0"不是失败版本（9/16 实测，motelet Task 4）。** 本轮 worker 的 6 行 mutation 表里有 4 行是
`trimmed.thinking = 0` / `hardLimit` 赋值删掉 / `serializedChars = 0` —— 这些都只证明**断言读了这个字段**，
不证明**那段行为在做事**。换成按行为变异后：整段删掉第 ① 档 ⇒ 4 条红；第 ② 档的上限从 `HEAD_TAIL_CHARS/4`
改回 `HEAD_TAIL_CHARS`（即该档退化成空操作）⇒ 1 条红；把遮蔽版喂进 `summarizeFn` ⇒ 恰好那条 §7-7 pin 红。
⇒ 变异必须落在**行为**上（删一档 / 改一个常量 / 换一个入参），不是落在**被断言的变量**上。

**更要紧的是反过来问：有没有哪条语义根本写不出失败版本。** 同一轮里 spec 用整段 blockquote 论证过
"`user` 不进软预算这条降级链"（它解决的是"总字符 ≤ 预算"与"user 永不丢弃"的构造性矛盾，是本设计的核心
权衡），而我把 `nonUserChars` 改成计入所有行 —— **四个测试文件 89/89 全绿**。两个 `user` 夹具都在（软/硬
两档），却没有一个断言**排除**。⇒ 收报告时对每条"语义最重"的规则单独问一句：**它的失败版本是什么**；
答不上来的那条就是缺 pin，而不是"已经覆盖"。worker 的 mutation 表天然发现不了这类缺口——它只测自己写过的
断言。

## 夹具走对了分支 ≠ 夹具能区分；缺口的修法是补算术，不是补断言（9/16 实测）

上一条抓到了"某条规则一条 pin 都没有"。这一条是它的难识别版本：**测试在、断言诚实、代码路径也确实走到了，
但没有任何变异能让它变红。** 同一个 `user` 软预算例子里，`soft budget` 用例如实断言了"user 仍全文、
`hardLimit === false`"——它**没有错**，只是夹具形状让它对规则不敏感：一条巨大 user + 一条小 assistant，
①/② 没有可动的 thinking/toolResult 行，`trimmed.*` 两种写法都恒为 0。

⇒ 收报告时，**对每条规则做"变异规则、看现有夹具是否翻"**，而不是"看这条断言能不能红"。两者差一个数量级的
发现率：前者抓到了"该规则无失败版本"，后者只抓到"断言会失败"。

⇒ 补法必须是**算术**，不是再写一条断言：让夹具里存在一个"若规则错了就会被销毁"的行（这里是一条 thinking），
**外加**一条证明输入真的越线的断言（`serializedChars > SUMMARY_INPUT_TOKEN_BUDGET * 4`）。少了后者，前几条
在下次有人调夹具尺寸时一起变空洞，而它自己不会告诉你。

**同一天的另一半教训：这套 5 问要先用在自己身上。** 我交的核验报告里有一条"`test/context-compactor.test.ts`
丢了文件尾换行"是**假阳性**——`tail -c 1` 只看了工作区，没看 HEAD（`git show HEAD:<f> | tail -c 1` 同样是
`3b`，diff 里那句 `\ No newline at end of file` 挂在**未改动的上下文行**上）。一条 `git show` 就能否掉它。
⇒ 报告里每个"疑似回归"都要附**同方法的基线对照**；没有对照的，写成"待核对"而不是写成发现。

## 派发前把"验收"翻译成可自证的数字（9/16 实测）

同一轮里，验收要求"tsc 基线不可推动"。这句话 worker 无法自证，除非同时给出：**哪个文件、多了几条、什么
错误码、目标数是多少**。实测真实构成是 `test/compaction.test.ts` 9 条 `TS2322` + 3 条 `TS2352`（36 → 48），
所以工单要写"该文件回到 36 条"与"全局 `error TS` 回到 639"两个数——只写"不许推动基线"会让 worker 拿一个
自己都测不准的口径交差。

⇒ 规则：**每条验收都要有"我要跑哪条命令、期望看到什么数、以及这个数为什么是这个数"**。数不出来就先数
（本轮数这一步顺带发现：用 `grep -oE "^[^(]+"` 归因 tsc 错误会把**续行**当成文件名，且 worktree 编译对
`packages/base/*` 的路径拼写与主树不同 ⇒ 只信文件级的差值）。

## 数字回到基线 ≠ 集合回到基线（9/16 实测）

同一次派发里，工单把验收写成两个数（全局 `error TS` 回 639、目标文件回 36）。worker 交回来**两个数都
对**——但逐条比对错误集合才发现：它只修掉了 12 条新错误中的 **11** 条，同时"顺手"给一个**既有**错误
（`handles array content` 里的裸字面量）也加了 cast。**+1 条新错误被 −1 条无关修好抵消**，数字漂亮地回到
基线，而集合已经变了。只比计数永远看不出来。

⇒ 规则：**"回到基线"必须按集合证，不能按计数证。** 多重集口径：

```sh
grep '^<file>(' /tmp/tsc.txt | sed 's/^[^)]*): //' | sort | uniq -c   # 忽略行号，只比消息多重集
```

行号会随插入位移，所以**不要**带行号比；更稳的是把每条错误归到**所属测试名**（取最近的 `test("...")`
前缀）再比。另外：集合一致时也仍可能"顺手修好了既有错误"，所以还要查
`git diff -U0 | grep '^-[^-]'`，确认没有改到不该改的既有测试 —— 本次正是靠这条才发现 worker 动了一个与
任务无关的测试。

## worker 超时 ≠ 没有产出：先看树，再决定重不重派（9/16 实测）

`task_mu3bthbb_e9066f` 撞上 5400 s 上限，`result` 停在 "Now let me run the test suite"，**没有报告、没有
验收数字**。但树里**五项修复 + 两处清理全都在**，只差验证：tsc 已在目标、套件全绿、两份探针能跑。直接
重派要再花 90 分钟，而验证（跑套件、跑 4 条变异、贴真实日志行）自己做完只要十几分钟。

⇒ 规则：**超时后的第一动作是 `git status` / `git diff --stat` + 逐项对照工单**，先判断是"改完了没验"还是
"改到一半"。前者按验收清单自己跑完 —— 并且**变异一定要亲手跑**，因为那正是超时时被跳过的那一步（本次
就是靠补跑变异才发现一条验收缺口：D20 只落实了一半，把实现改回去整个套件仍绿）。后者才重派，并在新工单
里写明"树里已有 X 的残留，先读再改"。

## plan 的步骤本身可能不可满足：先怀疑 plan，再怀疑 worker（9/15 实测）

本轮 Task 1 Step 3 同时要求日志行"紧跟在 `const messages = ...`（`:106`）之后"且"带上 `wouldTrigger`"——
而 `wouldTrigger` 就是 `overThreshold`（`:109`），`:106` 处它还不存在。两个要求互斥，
worker 只能选可满足的那个（放在 `:109` 之后、early return 之前）。
⇒ 遇到"worker 偏离了 plan 某步"时，**第一问是"这步按字面写得出来吗"**：写不出来就是 plan 的 bug，
修 plan（并在 `§As built` 里把偏离记成"plan 自相矛盾、按可满足形式落地"），
**不要去改 worker 已经正确的代码**。派发 prompt 是从 plan 抄的，所以同一个矛盾会同时污染两边。

## 计划步骤被我"精简"过的地方，就是缺陷入口：先查参考实现（9/16 实测）

Task 5 交付了 `CompactionDetails.readFiles/modifiedFiles`，全绿；但 `grep -rn "readFiles" gateway/src/ tui/`
显示**没有消费方**——模型永远看不到清单。我当时把它记成"开放决策：Task 6 加渲染点，或改 spec §3.4(a)"。
查上游 pi-mono 后结论翻转：**上游两件事都做**——`summary += formatFileOperations(...)` 紧接
`details: { readFiles, modifiedFiles }`（`compaction/compaction.ts:689-696`）。契约本来就是对的，
**是我的计划 Step 2 在重推锚点时丢掉了字符串那一半**。⇒ 三条：

1. **"实现与契约不一致"时，先查参考实现，再谈改契约。** 选项清单若只有"改契约"和"加实现"两项，
   通常漏了第三种：契约对、步骤被简化过。把退化写成契约是最贵的一种收尾（这份 spec 的前提就是
   motelet 相对上游退化，用"改契约"收尾等于把退化正当化）。
2. **工单里贴参考实现的做法，不要只贴计划措辞。** worker 会照字面执行，包括我的简化——这处照原样派发，
   它会实现一个没人读的字段并且全绿，验收条款也不会红。
3. **验收"字段写入了"不等于"契约兑现"：要问谁读它。** `grep -rn <字段名> src/ tui/` 找消费方；
   没有消费方就是没兑现，测试多少绿都不算。这类缺口只能靠端到端用例堵——字符串组装可以被
   "没人读的字符串"满足，走一遍真 `SessionManager` → `buildSessionContext` 才能证明可达。

## 语料的 unit 先确认，再统计（9/15 实测）

给 Task 2 写工单时才发现：`~/.motelet/sessions/*.jsonl` **一个文件不是"一个上下文"**——记录带 `agentId`，
229 个非空文件里 **51 个含 >1 个 agentId**（captain + 每个 crew 各一条链），而每条链是**独立的触发点**
（`orchestration.ts:903` / `crew/executor.ts:225`）。按"读记录、顺序走"统计会把几条对话加成一个上下文，
于是每个数字系统性偏高（实测 133,226 vs 真值 105,555，1.6×）。正确 unit = **(file × agentId × parentId
根段)**：实测 348 文件 / 229 有记录 / **319 根段** / 156 段 ≥5 条 / 9 个 agent 组多根 / 2 个文件带
active `revert`。

⇒ 规则：**"有 N 个 session/文件"不等于"有 N 个上下文"**。写工单前先用几十行结构探针数出：顶层记录类型
分布、每条记录的**分组键**（这里 `agentId`）、树的形状（根数 vs 分组大小）、以及**分组大小 ≠ 链长**的
条目（这里 9 个）。把这些数字写进工单当自检锚点（"脚本必须打印 348/229/319/156，任一不一致就说清差在
哪"），否则 worker 用错的 unit 跑出来的数字会**看起来非常合理**、且与你的参考数对不上时它可能去调脚本
而不是怀疑 walk。

与第 10 条同源，顺序是：**先问"我在数什么单位"，再问"用什么命令数"**。

## 断言里对「实际值」做了归一化，等于把那个性质变成永真（9/16 实测）

worker 交付的 `computeFileLists` 承诺返回 sorted 列表（doc-comment 也这么写）。删掉两个 `.sort()` 后
**36/36 全绿** —— 因为断言写的是 `expect(details.modifiedFiles!.sort()).toEqual([...])`：`.sort()`
作用在**实际值**上，比较的是排好序之后的数组，排序与否都通过。

⇒ 要 pin 住一条性质，夹具与断言必须同时到位：夹具让**插入序 ≠ 目标序**（这里是按逆序读文件），断言比
**产出原样**。查"未 pin 的性质"时把断言当嫌疑对象读一遍：`.sort(` / `.map(` / `.filter(` 出现在
`expect(...)` 的实际值一侧就把该性质洗掉了；叠上 `.length` / `toBeDefined` 这类弱断言，一个测试可以
"覆盖"某功能却什么都测不到。

## 交付后自己动手的"清理"必须整套复跑（9/16 实测）

worker 写的 `manager.getCurrentSessionFile?.()` 看起来是死代码 —— 该方法在 `manager: SessionManager` 上
是**必填**的，`?.` 读起来像对刚核实过的 API 还不确定。改成直调后**3 个测试红**：
`TypeError: manager.getCurrentSessionFile is not a function` —— 那些测试传的是**部分桩** manager，
`?.()` 静默得到 `undefined` 正是它在防守的东西。

⇒ ① 判"死代码"前先问「谁会以不满足该类型的方式调用它」，**测试桩是最常见答案**；② post-delivery 的任何
编辑之后跑**整套**，别只跑相关子集 —— 这个回归只在 `project-context-injection.test.ts` 上现形，而它与本
任务毫无关系；③ 改坏了就回退，并在 plan §6 记一句"试过并否决"，否则下一个人会再踩一次；④ 同一轮里还可能
夹着**负载抖动**（本次 `uptime` load 26.9 时另有多条 `sleep`/计时类 fail），所以"9 fail"要按"3 个确定性 +
若干抖动"拆开说，别把抖动也算成自己的战果。

## 计划里标了"owner only / 不要模拟"的步骤，是缺陷高发区——别只派出去就等（9/16 实测）

一条实测教训，来自压缩重构 Task 6：计划把步骤 3 标成 **"Session owner only — do not simulate"**，理由是
`chat` 不派发斜杠命令、需要自建 WS 客户端、且要写 `docs/debug/**`（不能自动提交）。判断是对的一半——
**但"owner only"往往同时意味着"这一步从没被任何测试跑过"**。

那次我把它和可派发的步骤 1+2 **同时开工**，结果第一次跑（0 秒、回报 "Context compacted"）就看到摘要落盘为
`""`，顺藤摸到三层既有缺陷：事件名用了一个库从不发出的变体（`ev.type === "text"`，真实是 `text_delta`）、
`error` 事件被静默吞掉（调用方的 fallback 成了死代码）、闭包没传 api key（主循环能跑是因为下游框架自己注入）。
1827 条绿测全都没看见，因为测试夹具喂的正是那个虚构的事件形状。

可操作的结论：

1. **把"owner only"当成"没有被验证过"来对待，而不是"谁做都一样"。** 排期时让它**与可派发部分并行**，
   不要串行排在后面——它的产出往往决定后面的步骤还有没有意义。
2. **派发前，先落实 owner 那部分的"可运行性"**：这一步需要什么入口（这里是一个自建 WS 客户端）、
   入口是否有现成的、以及**跑一次的最小代价**。跑得起来比读得懂更重要。
3. **探针要能区分"库的真实契约"与"实现的假设"。** 对着依赖的类型定义写一个两行探针（真实形状 vs
   代码假设的形状），比读 100 行代码更快定案，也顺手解释了"为什么测试是绿的"。
4. **发现 P0 时先不要顺手修**：修法通常有设计选择（累积哪个事件、错误怎么上浮、凭据从哪来）。
   把证据链交付给用户、列出选项，比自己定一个更符合"先讨论再执行"的协作方式。

## 处理路径速查

```
终态卡（report 可能被截到 4012 字符 → 先取 logs/task_<id>.jsonl 的全文）
      → 走 5 问 → 高 → 转用户
                → 中 → status 复核 → 闭环 → 转用户 / 仍模糊 → needs_input 反问
                → 低 → needs_input 反问 OR cancel 重派（带更明确的 Context）
```

needs_input 反问的 prompt 要把"哪一条 5 问没过、要补什么证据"写清楚，不要只说"再确认一下"。