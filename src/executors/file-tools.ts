/**
 * 「这次工具调用会不会改文件」——`files_changed` 只收这些工具碰过的路径。
 *
 * 口径是**改了什么**，不是**碰过什么**：Read / Grep / Glob 等只读工具一律不进，否则清单会被
 * "读过的文件"灌满（9/20 实测 65 个真实任务日志：652 条记录里 387 条 = 59% 是纯 Read，单任务
 * 18 条里 10 条只被读过）。spec-v2 §4.1 原本写的就是"从 Edit/Write 事件累计"，此处把它落回实现。
 *
 * 词汇表按 executor 登记（大小写不敏感，claude 用 PascalCase、opencode 用全小写）：
 * - claude：Edit / Write / MultiEdit / NotebookEdit
 * - opencode：edit / write / apply_patch
 * 其中 NotebookEdit 走 `notebook_path`、apply_patch 把路径写在 `patchText` 里，两者当前都拿不到
 * `file` 字段 ⇒ 归到"少报"一侧（executor 的路径提取是另一件事，不在本模块职责内）。
 *
 * 未登记的工具按「不改文件」处理：这份清单只是给 dispatcher 的线索，权威文件清单永远是 git status。
 */
const FILE_MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
]);

export function isFileMutatingTool(name: string): boolean {
  return FILE_MUTATING_TOOLS.has(name.toLowerCase());
}
