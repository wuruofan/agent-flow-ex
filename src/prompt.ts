export const NEEDS_INPUT_MARKER = "❓NEEDS_INPUT:";

/** spec §8：runner 统一包装行为契约（claude executor 默认值，未来可按 executor 配置化）。 */
export function wrapInitialPrompt(userPrompt: string): string {
  return `你是执行工程师，任务是：${userPrompt}

行为约束：
1. 遇到无法自行决策的阻塞（需求歧义、破坏性操作、方向性选择），
   停止编码，以「${NEEDS_INPUT_MARKER}」开头输出你的问题，不要猜测执行。
2. 能自查的（读代码、跑测试）先自查，只上报真正的决策阻塞。
3. 完成后输出最终结果摘要：改动文件、关键决策、遗留问题。`;
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