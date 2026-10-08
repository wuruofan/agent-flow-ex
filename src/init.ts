/**
 * `agent-flow-ex init` —— 交互式 onboarding。
 * 自动探测 agent CLI 绝对路径、引导填写 profile 与密钥，生成：
 *   $AGENT_FLOW_HOME/config.json   —— 只含 {env:VAR} 占位符，零明文密钥
 *   $AGENT_FLOW_HOME/.env          —— 真实密钥，chmod 600，本地文件不提交不同步
 * 完成后用 loadConfig() 自校验，并提示可编辑 config.json 调整模型别名/默认 env。
 *
 * 密钥处理策略：
 *   - preset（minimax/deepseek）：检测对应环境变量 → 掩码展示 → [Y/n]（Enter=Y）；
 *     拒绝后粘贴新值或 Enter=skip。config 占位符沿用预设的 token_var。
 *   - custom：只粘贴（无标准变量名可检测）；占位符变量名从 profile 名派生（apiKeyVarFor）。
 *   - 检测到/粘贴到的值写入 .env（幂等）；config.json 始终是 {env:VAR}。
 */
import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentFlowHome, ensureRuntimeDirs } from "./paths.js";
import { loadConfig } from "./config.js";

type RL = ReturnType<typeof createInterface>;

function which(name: string): string | null {
  try {
    return execSync(`command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function ask(rl: RL, prompt: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : "";
  return (await rl.question(`${prompt}${suffix}: `)).trim();
}

/** 通用 claude 环境变量默认值：自动并入每个 claude profile，用户可事后编辑 config.json 调整。 */
export const DEFAULT_CLAUDE_ENV: Record<string, string> = {
  API_TIMEOUT_MS: "3000000",
};

interface Preset {
  base_url: string;
  model: string;
  small?: string;
  opus?: string;
  haiku?: string;
  /** 该 provider 密钥的标准环境变量名（init 据此检测环境里的值）。 */
  token_var: string;
  extra?: Record<string, string>;
}

/** provider 预设 = base_url + 默认模型 + 密钥变量名；未来加 provider 只需加一条（数据驱动，不碰逻辑）。 */
const PRESETS: Record<string, Preset> = {
  minimax: {
    base_url: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M3[1m]",
    small: "MiniMax-M3[1m]", opus: "MiniMax-M3[1m]", haiku: "MiniMax-M3[1m]",
    token_var: "MINIMAX_API_KEY",
    extra: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "384000" },
  },
  deepseek: {
    base_url: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro[1m]",
    small: "deepseek-v4-pro[1m]", opus: "deepseek-v4-pro[1m]", haiku: "deepseek-v4-flash[1m]",
    token_var: "DEEPSEEK_API_KEY",
  },
};

/** custom 时密钥的 .env 变量名：从 profile 名派生（myprov → MYPROV_API_KEY），多 custom profile 互不冲突。 */
export function apiKeyVarFor(profile: string): string {
  const base = profile.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "DEFAULT";
  return `${base}_API_KEY`;
}

/** provider preset → claude executor 所需的 profile.env（密钥为 {env:VAR} 占位符 + 通用默认 env）。 */
export function presetEnv(presetName: string, tokenVar: string): Record<string, string> {
  if (presetName === "custom") return {};
  const p = PRESETS[presetName] ?? PRESETS.minimax;
  return {
    ...DEFAULT_CLAUDE_ENV,
    ANTHROPIC_BASE_URL: p.base_url,
    ANTHROPIC_AUTH_TOKEN: `{env:${tokenVar}}`,
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_SMALL_FAST_MODEL: p.small ?? p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.small ?? p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.opus ?? p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.haiku ?? p.model,
    ...(p.extra ?? {}),
  };
}

/** 掩码展示密钥：sk-abc…wxyz（前 3 后 4），确认用对账号又不泄露。 */
function maskSecret(v: string): string {
  return v.length > 8 ? `${v.slice(0, 3)}…${v.slice(-4)}` : "***";
}

/**
 * 密钥/URL 采集（两步语义各自自洽）：
 *   detect=true 且环境里有值 → 掩码展示，问 "Use this value? [Y/n]"（Enter=Y，符合默认值惯例）；
 *     拒绝（n）才进入下一步 → 粘贴新值，或 Enter=skip。
 *   detect=false（custom）→ 直接粘贴或跳过。
 * 返回解析到的真实值；undefined 表示跳过（保留占位符，不写 .env）。
 */
async function collectSecret(
  rl: RL,
  opts: { label: string; varName: string; detect: boolean },
): Promise<string | undefined> {
  const detected = opts.detect ? process.env[opts.varName] : undefined;
  if (detected) {
    const a = (await ask(rl, `Detected ${opts.varName} = ${maskSecret(detected)}\nUse this value? [Y/n]`, "Y")).trim();
    if (a === "" || /^y(es)?$/i.test(a)) return detected;
  }
  const b = (await ask(rl, `Paste ${opts.label} (or Enter to skip)`)).trim();
  return b || undefined;
}

/** 读 .env（保留出现顺序，跳过空行/注释；同 key 只取首个）。 */
function readEnv(envPath: string): { keys: string[]; map: Map<string, string> } {
  const keys: string[] = [];
  const map = new Map<string, string>();
  if (!existsSync(envPath)) return { keys, map };
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const k = raw.slice(0, eq).trim();
    const v = raw.slice(eq + 1).trim();
    if (k && !map.has(k)) { map.set(k, v); keys.push(k); }
  }
  return { keys, map };
}

/**
 * 把 entries 合并进 $home/.env（chmod 600）。幂等：与已有值相同则不重写。
 * 返回本次实际写入的 key 列表。
 */
export function writeEnvFile(home: string, entries: Record<string, string>): string[] {
  const envPath = join(home, ".env");
  const { keys, map } = readEnv(envPath);
  const written: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (map.get(k) === v) continue;
    if (!map.has(k)) keys.push(k);
    map.set(k, v);
    written.push(k);
  }
  if (written.length === 0) return written;
  const body = keys.map((k) => `${k}=${map.get(k)}`).join("\n") + "\n";
  writeFileSync(envPath, body, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return written;
}

export interface InitAnswers {
  executor: string;
  bin: string;
  profile: string;
  env: Record<string, string>;
  notify: { feishu_webhook_url: string; dry_run?: boolean };
  timeout_sec: number;
}

/**
 * 各 executor 的默认「无人值守」权限开关（语义相同、参数名不同）：
 * - claude：`--dangerously-skip-permissions`
 * - opencode：`--auto`（v1.18.33 的文档化开关；`--dangerously-skip-permissions` 虽仍被解析，
 *   但未见于 `opencode run --help`，属未文档化兼容，不作为默认值）
 */
export const DEFAULT_EXTRA_FLAGS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  opencode: ["--auto"],
};

/** 纯函数：答案 → config 对象。脱离 readline，便于单测与自校验复用。 */
export function buildConfig(a: InitAnswers) {
  return {
    executors: { [a.executor]: { bin: a.bin, extra_flags: DEFAULT_EXTRA_FLAGS[a.executor] ?? [] } },
    profiles: { [a.profile]: { executor: a.executor, env: a.env } },
    notify: a.notify,
    defaults: { profile: a.profile, timeout_sec: a.timeout_sec },
  };
}

export async function runInit(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  const home = agentFlowHome();
  ensureRuntimeDirs();
  const cfgPath = join(home, "config.json");
  const rl = createInterface({ input, output: process.stdout });

  try {
    if (existsSync(cfgPath)) {
      const ow = (await ask(rl, `${cfgPath} already exists. Overwrite?`, "N")).toLowerCase();
      if (ow !== "y" && ow !== "yes") { console.log("aborted."); return; }
    }

    const claudeBin = which("claude");
    const opencodeBin = which("opencode");
    console.log(`detected: claude=${claudeBin ?? "(not found)"}  opencode=${opencodeBin ?? "(not found)"}`);

    let executor = (await ask(rl, "Executor to configure (claude/opencode)", "claude")).toLowerCase() || "claude";
    if (executor !== "claude" && executor !== "opencode") {
      console.log(`unknown executor "${executor}", falling back to claude`);
      executor = "claude";
    }
    const detected = executor === "claude" ? claudeBin : opencodeBin;
    let bin = (await ask(rl, `Absolute path to ${executor} binary`, detected ?? "")).trim();
    if (!bin && detected) bin = detected;
    if (!bin) { console.error("no binary path provided; aborting."); process.exit(1); }

    const profile = (await ask(rl, "Profile name", "default")).trim() || "default";

    const envUpdates: Record<string, string> = {};
    let env: Record<string, string> = {};

    if (executor === "claude") {
      const presetName = (await ask(rl, "Provider preset (minimax/deepseek/custom)", "minimax")).toLowerCase() || "minimax";
      let tokenVar: string;
      if (presetName === "custom") {
        const base = (await ask(rl, "ANTHROPIC_BASE_URL")).trim();
        const model = (await ask(rl, "ANTHROPIC_MODEL")).trim();
        tokenVar = apiKeyVarFor(profile);
        env = { ...DEFAULT_CLAUDE_ENV, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: `{env:${tokenVar}}`, ANTHROPIC_MODEL: model };
      } else {
        const p = PRESETS[presetName] ?? PRESETS.minimax;
        tokenVar = p.token_var;
        env = presetEnv(presetName, tokenVar);
      }
      // custom 无标准变量名可检测 → 只粘贴
      const secret = await collectSecret(rl, { label: "API key", varName: tokenVar, detect: presetName !== "custom" });
      if (secret) envUpdates[tokenVar] = secret;
    } else {
      console.log("opencode: provider 由 opencode 自己的配置管理（opencode auth login / opencode.json），agent-flow 只负责拉起；如需额外环境变量，稍后加到 config.json 的 profile.env。");
    }

    const feishuSecret = await collectSecret(rl, { label: "Feishu webhook URL", varName: "FEISHU_WEBHOOK_URL", detect: true });
    if (feishuSecret) envUpdates.FEISHU_WEBHOOK_URL = feishuSecret;
    const notify = { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true };

    const timeoutRaw = (await ask(rl, "Default timeout (seconds)", "3600")).trim();
    const timeout = Number.parseInt(timeoutRaw, 10) || 3600;

    const config = buildConfig({ executor, bin, profile, env, notify, timeout_sec: timeout });

    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\nwrote ${cfgPath}`);

    const written = writeEnvFile(home, envUpdates);
    if (written.length > 0) {
      console.log(`wrote ${join(home, ".env")} (chmod 600): ${written.join(", ")}`);
    } else {
      console.log(".env unchanged (no new secrets written)");
    }

    try {
      loadConfig(home);
      console.log("config valid \u2713");
    } catch (e) {
      console.error("config written but self-check failed:", (e as Error).message);
      process.exit(1);
    }

    // 提示：占位符对应变量不在 .env（也没被采集到）→ 提醒运行时必须有值，否则任务失败
    const tokenPlaceholder = env.ANTHROPIC_AUTH_TOKEN ?? "{env:MINIMAX_API_KEY}";
    const tokenKeyMatch = /^\{env:(.+)\}$/.exec(tokenPlaceholder);
    const tokenKey = tokenKeyMatch ? tokenKeyMatch[1] : undefined;
    if (tokenKey && !readEnv(join(home, ".env")).map.has(tokenKey)) {
      console.log(`\n\u26a0 ${tokenKey} not set — add it to ${join(home, ".env")} (or export it) before running the server, otherwise tasks will fail.`);
    }

    console.log("\nNext steps:");
    console.log(`  export AGENT_FLOW_HOME=${home}   (or set it in your MCP server env)`);
    console.log("\nRegister as an MCP server (copy into your client's MCP config):");
    console.log(JSON.stringify({
      mcpServers: {
        "agent-flow-ex": { command: "agent-flow-ex" },
      },
    }, null, 2));
    console.log('  (installed via npx instead of -g? use { "command": "npx", "args": ["-y", "agent-flow-ex@latest"] })');
    console.log(`  optional: edit ${cfgPath} to tune model aliases / default env (e.g. API_TIMEOUT_MS)`);
  } finally {
    rl.close();
  }
}

// 直接运行时自动启动：tsx src/init.ts / node dist/init.js。
// 被 server.ts import（argv[1] 是 server）时不自动跑，避免与 server 的 init 分支重复执行。
const invokedDirectly = !!process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1]);
if (invokedDirectly) {
  runInit().catch((e) => { console.error("[agent-flow-ex] init failed:", e); process.exit(1); });
}
