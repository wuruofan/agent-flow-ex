import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

describe("toolchain smoke", () => {
  it("runs vitest with ts + esm", () => {
    const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    expect(id).toMatch(/^task_[a-z0-9]+_[a-f0-9]{6}$/);
  });
});