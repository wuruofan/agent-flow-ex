export const NEEDS_INPUT_MARKER = "❓NEEDS_INPUT:";

/**
 * spec §8：runner 统一包装行为契约（claude executor 默认值，未来可按 executor 配置化）。
 * 时间预算契约（P1）：runner 注入本任务的单轮 timeout，令 worker 在临近超时前把进度落成
 * HANDOFF.md（不 commit / 不 push），避免大任务撞墙白干。放在契约层而非 dispatcher 措辞，
 * 保证所有派发、所有未来 dispatcher 自动遵守（见 docs/superpowers/specs/2026-08-29-self-loop-design.md:173）。
 */
export function wrapInitialPrompt(userPrompt: string, timeoutSec?: number): string {
  return `你是执行工程师，任务是：${userPrompt}

行为约束：
1. **禁止调用 AskUserQuestion / ask 等交互式提问工具**——本环境无人值守、无 tty、无控制协议回路，调用只会返回错误或让你乱猜。如有阻塞，按第 2 条走文本通道。
2. 遇到无法自行决策的阻塞（需求歧义、破坏性操作、方向性选择），先停止编码，不要猜测执行，按问题复杂度二选一上报：
   a. 问题几句话能说清 → 直接以「${NEEDS_INPUT_MARKER}」开头输出问题。
   b. 问题需要较长背景/多方论证 → 先写一份问题说明书到
      docs/problems/problem-<时间戳>.md（含背景、已尝试、卡点、可选方案），
      再输出「${NEEDS_INPUT_MARKER}<一句话> 详见 docs/problems/problem-<时间戳>.md」。
3. 能自查的（读代码、跑测试）先自查，只上报真正的决策阻塞。
4. 完成后输出最终结果摘要：改动文件、关键决策、遗留问题。
5. 关照上下文体积：不整读超大文件（长日志、node_modules、巨大 JSON 等）。读前先 wc -l / grep 探规模，需要时只读相关片段、用 grep 收敛。若遇到 AUTOCOMPACT 反复警告或一次读入后几乎占满上下文：停止反复重读，按第 2 条上报（注明嫌疑文件路径、规模、已尝试），不要硬撑。${timeoutSec === undefined ? "" : budgetContract(timeoutSec)}`;
}

/** 时间预算契约段：仅在 runner 传入 timeout 时附加（见 wrapInitialPrompt）。 */
function budgetContract(timeoutSec: number): string {
  return `

6. 关照时间预算：本任务单轮上限约 ${Math.round(timeoutSec / 60)} 分钟（${timeoutSec}s）。开工时先记一次当前时间（如 \`date +%s\`），用它估算已用时；当预计剩余不足 15–20% 时，停止开辟新工作面，先把进度落成交接笔记再收尾。
   - 交接笔记写到项目根目录的 \`HANDOFF.md\`：已完成的改动/文件、尚未做完的部分、下一步怎么接着做、如何验证。
   - **不要**为此执行 git commit / push——HANDOFF.md 与工作区已有的改动本身就是交接物，调度方会据此接手。
   - 若判断整单已无法在本轮预算内完成，也可按第 2 条上报（问题里注明 \`HANDOFF.md\` 路径与残留范围），由调度方决定续做或收尾。`;
}

/** 续跑轮：答案作为会话中的新 user 消息（--resume 恢复上下文）。 */
export function wrapContinuePrompt(answer: string, timeoutSec?: number): string {
  const budget = timeoutSec === undefined ? "" : `

（时间预算：本轮上限约 ${Math.round(timeoutSec / 60)} 分钟。预计剩余不足 15–20% 时，先按 worker 行为约束把进度写进项目根目录 HANDOFF.md 再收尾；不要为此 commit/push。）`;
  return `架构师对你上一轮问题的答复如下，请基于已有上下文继续执行任务：

${answer}${budget}`;
}

/** 从最终 assistant 文本提取问题；不守约（无标记）返回 null。 */
export function extractNeedsInput(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("❓NEEDS_INPUT")) return null;
  const rest = t.replace(/^❓NEEDS_INPUT[:：]?\s*/, "");
  return rest || null;
}
