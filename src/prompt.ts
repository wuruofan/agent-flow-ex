export const NEEDS_INPUT_MARKER = "❓NEEDS_INPUT:";

/** spec §8：runner 统一包装行为契约（claude executor 默认值，未来可按 executor 配置化）。 */
export function wrapInitialPrompt(userPrompt: string): string {
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
5. 关照上下文体积：不整读超大文件（长日志、node_modules、巨大 JSON 等）。读前先 wc -l / grep 探规模，需要时只读相关片段、用 grep 收敛。若遇到 AUTOCOMPACT 反复警告或一次读入后几乎占满上下文：停止反复重读，按第 2 条上报（注明嫌疑文件路径、规模、已尝试），不要硬撑。`;
}

/** 续跑轮：答案作为会话中的新 user 消息（--resume 恢复上下文）。 */
export function wrapContinuePrompt(answer: string): string {
  return `架构师对你上一轮问题的答复如下，请基于已有上下文继续执行任务：

${answer}`;
}

/** 从最终 assistant 文本提取问题；不守约（无标记）返回 null。 */
export function extractNeedsInput(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("❓NEEDS_INPUT")) return null;
  const rest = t.replace(/^❓NEEDS_INPUT[:：]?\s*/, "");
  return rest || null;
}