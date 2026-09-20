// files_changed 的口径：只记「改过」的文件，不记「碰过」的文件。
// 本测试锁死分类边界——新增 executor 工具词汇时，漏登记会在这里红。
import { describe, expect, it } from "vitest";
import { isFileMutatingTool } from "../src/executors/file-tools.js";

describe("isFileMutatingTool", () => {
  it("claude 的写工具 → true（含 MultiEdit / NotebookEdit）", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect({ t, mutating: isFileMutatingTool(t) }).toEqual({ t, mutating: true });
    }
  });

  it("opencode 的写工具 → true（大小写不敏感）", () => {
    for (const t of ["edit", "write", "apply_patch", "EDIT", "Write"]) {
      expect({ t, mutating: isFileMutatingTool(t) }).toEqual({ t, mutating: true });
    }
  });

  it("只读/检索类工具 → false（这是本条修复的核心：Read 不再进 files_changed）", () => {
    for (const t of ["Read", "read", "Grep", "grep", "Glob", "glob", "List", "lsp", "skill", "webfetch", "websearch", "todowrite"]) {
      expect({ t, mutating: isFileMutatingTool(t) }).toEqual({ t, mutating: false });
    }
  });

  it("未知工具 → false（宁缺勿滥：清单只是线索，权威是 git status）", () => {
    for (const t of ["Bash", "bash", "Task", "TaskUpdate", "SomeFutureTool"]) {
      expect({ t, mutating: isFileMutatingTool(t) }).toEqual({ t, mutating: false });
    }
  });
});
