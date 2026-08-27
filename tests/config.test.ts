import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFlowHome, dbPath, logsDir } from "../src/paths.js";
import { loadConfig, resolveEnvPlaceholders } from "../src/config.js";

// 用 process.execPath 作为 fixture bin：保证测试环境一定存在（validate 会做 existsSync 校验）。
const validConfig = {
  executors: {
    claude: { bin: process.execPath, extra_flags: ["--dangerously-skip-permissions"] },
  },
  profiles: {
    "minimax-3": {
      executor: "claude",
      env: { ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic", ANTHROPIC_AUTH_TOKEN: "{env:MINIMAX_API_KEY}" },
    },
  },
  notify: { feishu_webhook_url: "https://open.feishu.cn/hook/x", dry_run: true },
  defaults: { profile: "minimax-3", timeout_sec: 3600 },
};

describe("paths", () => {
  beforeEach(() => { process.env.AGENT_FLOW_HOME = mkdtempSync(join(tmpdir(), "afex-")); });
  afterEach(() => { rmSync(process.env.AGENT_FLOW_HOME!, { recursive: true, force: true }); delete process.env.AGENT_FLOW_HOME; });

  it("resolves home from env with fallback to ~/.agent-flow-ex", () => {
    expect(agentFlowHome()).toBe(process.env.AGENT_FLOW_HOME);
    const savedHome = process.env.HOME;
    const savedAfHome = process.env.AGENT_FLOW_HOME;
    delete process.env.AGENT_FLOW_HOME;
    expect(agentFlowHome()).toBe(join(savedHome!, ".agent-flow-ex"));
    process.env.AGENT_FLOW_HOME = savedAfHome;
  });
  it("derives db and logs paths", () => {
    expect(dbPath()).toBe(join(agentFlowHome(), "tasks.db"));
    expect(logsDir()).toBe(join(agentFlowHome(), "logs"));
  });
});

describe("loadConfig", () => {
  it("loads and validates a valid config", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    writeFileSync(join(home, "config.json"), JSON.stringify(validConfig));
    const cfg = loadConfig(home);
    expect(cfg.profiles["minimax-3"].executor).toBe("claude");
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects profile referencing unknown executor", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.profiles["minimax-3"].executor = "nope";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/executor/);
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects missing defaults.profile target", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.defaults.profile = "ghost";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/ghost/);
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects nonexistent executor bin (fail-fast over queued-and-stuck)", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.executors.claude.bin = "/nonexistent/path/to/claude";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/not found or not executable/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("resolveEnvPlaceholders", () => {
  it("resolves {env:VAR} placeholders from process.env", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    expect(resolveEnvPlaceholders({ A: "{env:MINIMAX_API_KEY}", B: "literal" })).toEqual({ A: "sk-test", B: "literal" });
    delete process.env.MINIMAX_API_KEY;
  });
  it("throws on missing placeholder env", () => {
    delete process.env.NO_SUCH_KEY_XYZ;
    expect(() => resolveEnvPlaceholders({ A: "{env:NO_SUCH_KEY_XYZ}" })).toThrow(/NO_SUCH_KEY_XYZ/);
  });
});