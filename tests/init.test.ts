import { describe, expect, it } from "vitest";
import { apiKeyVarFor, buildConfig, DEFAULT_CLAUDE_ENV, presetEnv } from "../src/init.js";

describe("presetEnv", () => {
  it("merges generic claude default env (API_TIMEOUT_MS) into every preset", () => {
    const env = presetEnv("minimax", "MINIMAX_API_KEY");
    expect(env.API_TIMEOUT_MS).toBe(DEFAULT_CLAUDE_ENV.API_TIMEOUT_MS);
  });
  it("minimax: token placeholder + known model + extra env", () => {
    const env = presetEnv("minimax", "MINIMAX_API_KEY");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("{env:MINIMAX_API_KEY}");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3[1m]");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("384000");
  });
  it("deepseek: distinct haiku model alias", () => {
    const env = presetEnv("deepseek", "DEEPSEEK_API_KEY");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("{env:DEEPSEEK_API_KEY}");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro[1m]");
  });
  it("custom is not handled by presetEnv", () => {
    expect(presetEnv("custom", "X_API_KEY")).toEqual({});
  });
});

describe("apiKeyVarFor (custom key var name derived from profile)", () => {
  it("uppercases and sanitizes the profile name", () => {
    expect(apiKeyVarFor("myprov")).toBe("MYPROV_API_KEY");
    expect(apiKeyVarFor("My Prov!")).toBe("MY_PROV_API_KEY");
  });
  it("falls back to DEFAULT when profile yields no usable chars", () => {
    expect(apiKeyVarFor("")).toBe("DEFAULT_API_KEY");
    expect(apiKeyVarFor("   ")).toBe("DEFAULT_API_KEY");
  });
});

describe("buildConfig", () => {
  it("produces a config with executor/profile/notify/defaults", () => {
    const cfg = buildConfig({
      executor: "claude",
      bin: "/bin/node",
      profile: "default",
      env: { A: "1" },
      notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true },
      timeout_sec: 3600,
    });
    expect(cfg.executors.claude.bin).toBe("/bin/node");
    expect(cfg.profiles.default.env).toEqual({ A: "1" });
    expect(cfg.notify.dry_run).toBe(true);
    expect(cfg.defaults.profile).toBe("default");
  });
});
