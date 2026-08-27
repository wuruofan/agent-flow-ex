import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvText } from "../src/env-file.js";

const touchedKeys: string[] = [];

afterEach(() => {
  for (const k of touchedKeys) delete process.env[k];
  touchedKeys.length = 0;
});

function track(...keys: string[]): void {
  touchedKeys.push(...keys);
}

describe("parseEnvText", () => {
  it("parses KEY=VALUE pairs in order", () => {
    expect(parseEnvText("A=1\nB=two\n")).toEqual([["A", "1"], ["B", "two"]]);
  });
  it("skips blank lines and # comments", () => {
    expect(parseEnvText("\n# comment\nA=1\n\n# another\nB=2\n")).toEqual([["A", "1"], ["B", "2"]]);
  });
  it("keeps the rest after the first = as the value (URLs / tokens with = intact)", () => {
    expect(parseEnvText("URL=https://x.com?a=1&b=2\n")).toEqual([["URL", "https://x.com?a=1&b=2"]]);
  });
  it("ignores lines without = and empty keys", () => {
    expect(parseEnvText("NOEQUALS\n=orphan\nA=1\n")).toEqual([["A", "1"]]);
  });
});

describe("loadEnvFile", () => {
  it("is a no-op when .env does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-env-none-"));
    expect(() => loadEnvFile(home)).not.toThrow();
    rmSync(home, { recursive: true, force: true });
  });
  it("injects KEY=VALUE into process.env", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-env-load-"));
    writeFileSync(join(home, ".env"), "MINIMAX_API_KEY=sk-test\nURL=https://x.com\n");
    // 先清环境，保证用例确定性（宿主环境里若已 export 同名变量，??= 会跳过注入）
    delete process.env.MINIMAX_API_KEY;
    delete process.env.URL;
    track("MINIMAX_API_KEY", "URL");
    loadEnvFile(home);
    expect(process.env.MINIMAX_API_KEY).toBe("sk-test");
    expect(process.env.URL).toBe("https://x.com");
    rmSync(home, { recursive: true, force: true });
  });
  it("does not override an existing process.env value (??=)", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-env-keep-"));
    writeFileSync(join(home, ".env"), "MINIMAX_API_KEY=sk-from-file\n");
    process.env.MINIMAX_API_KEY = "sk-from-shell";
    track("MINIMAX_API_KEY");
    loadEnvFile(home);
    expect(process.env.MINIMAX_API_KEY).toBe("sk-from-shell");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("writeEnvFile (init-side)", () => {
  // 该函数从 init.ts 导入；这里只验证其落盘副作用与幂等性
  it("writes chmod 600 and is idempotent", async () => {
    const { writeEnvFile } = await import("../src/init.js");
    const home = mkdtempSync(join(tmpdir(), "afex-env-write-"));
    const first = writeEnvFile(home, { A: "1", B: "2" });
    expect(first.sort()).toEqual(["A", "B"]);
    const mode = statSync(join(home, ".env")).mode;
    expect(mode & 0o777).toBe(0o600);
    const second = writeEnvFile(home, { A: "1" });
    expect(second).toEqual([]);
    const third = writeEnvFile(home, { A: "3" });
    expect(third).toEqual(["A"]);
    expect((await import("node:fs")).readFileSync(join(home, ".env"), "utf8")).toContain("A=3");
    rmSync(home, { recursive: true, force: true });
  });
});
