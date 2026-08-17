import { describe, expect, it } from "vitest";
import { wrapInitialPrompt, wrapContinuePrompt, extractNeedsInput, NEEDS_INPUT_MARKER } from "../src/prompt.js";

describe("prompt contract", () => {
  it("wraps initial prompt with worker contract", () => {
    const p = wrapInitialPrompt("实现登录页");
    expect(p).toContain("实现登录页");
    expect(p).toContain(NEEDS_INPUT_MARKER);
    expect(p).toContain("执行工程师");
  });
  it("initial prompt explicitly forbids AskUserQuestion (headless no control protocol)", () => {
    const p = wrapInitialPrompt("任意任务");
    expect(p).toMatch(/禁止.*AskUserQuestion|AskUserQuestion.*禁止/);
  });
  it("wraps continue prompt with architect answer framing", () => {
    const p = wrapContinuePrompt("用 SQLite");
    expect(p).toContain("用 SQLite");
    expect(p.startsWith("架构师")).toBe(true);
  });
  it("extracts question from NEEDS_INPUT text", () => {
    const q = extractNeedsInput("❓NEEDS_INPUT: which database engine?");
    expect(q).toBe("which database engine?");
  });
  it("extracts question with 中文冒号 and surrounding whitespace", () => {
    expect(extractNeedsInput("  ❓NEEDS_INPUT：用哪个库？  ")).toBe("用哪个库？");
  });
  it("returns null for normal text", () => {
    expect(extractNeedsInput("all done")).toBeNull();
    expect(extractNeedsInput("NEEDS_INPUT without marker emoji")).toBeNull();
  });
});