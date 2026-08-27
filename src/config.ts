import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentFlowHome, ensureRuntimeDirs } from "./paths.js";

export interface ExecutorConfig {
  bin: string;
  extra_flags?: string[];
}
export interface ProfileConfig {
  executor: string;
  env: Record<string, string>;
}
export interface Config {
  executors: Record<string, ExecutorConfig>;
  profiles: Record<string, ProfileConfig>;
  notify: { feishu_webhook_url: string; dry_run?: boolean; keyword?: string };
  defaults: { profile: string; timeout_sec: number };
}

/**
 * 将 "{env:VAR_NAME}" 占位符替换为运行时环境变量；缺失则抛错（避免明文密钥落盘）。
 * 真实写法与 spec 草稿略有不同——见 plan §Task 2 Step 3 末尾的修正指引。
 */
export function resolveEnvPlaceholders(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^\{env:([A-Z0-9_]+)\}$/.exec(v);
    if (m) {
      const val = process.env[m[1]];
      if (!val) throw new Error(`env placeholder {env:${m[1]}} not found in process environment`);
      out[k] = val;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(home?: string): Config {
  ensureRuntimeDirs();
  const cfgPath = join(home ?? agentFlowHome(), "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
  validate(cfg);
  return cfg;
}

function validate(cfg: Config): void {
  if (!cfg.executors || Object.keys(cfg.executors).length === 0) throw new Error("config.executors is empty");
  if (!cfg.profiles || Object.keys(cfg.profiles).length === 0) throw new Error("config.profiles is empty");
  for (const [name, e] of Object.entries(cfg.executors)) {
    if (!e.bin || typeof e.bin !== "string") throw new Error(`executor "${name}" missing "bin"`);
    if (!binIsExecutable(e.bin)) throw new Error(`executor "${name}" bin "${e.bin}" not found or not executable`);
  }
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (!cfg.executors[p.executor]) throw new Error(`profile "${name}" references unknown executor "${p.executor}"`);
  }
  if (!cfg.defaults?.profile || !cfg.profiles[cfg.defaults.profile]) {
    throw new Error(`defaults.profile "${cfg.defaults?.profile}" not found in profiles`);
  }
  if (!cfg.notify?.feishu_webhook_url) throw new Error("notify.feishu_webhook_url is required");
  // dry_run 缺省 = true（只打印到 stderr 不真发），调试期默认安全；想真发改 false
  if (!Number.isInteger(cfg.defaults.timeout_sec) || cfg.defaults.timeout_sec <= 0) {
    throw new Error("defaults.timeout_sec must be a positive integer");
  }
}

/**
 * 把 bin 解析成绝对路径：
 * - 含分隔符（绝对/相对路径）→ 直接校验 existence + X_OK；
 * - 裸命令名 → 按 PATH 查找（Node 无内置 PATH 解析，按 ":" 分隔实现）。
 * 返回 null 表示找不到。validate() 与 buildAgentEnv() 共用，保证
 * 「启动期校验」与「运行时 PATH」一致（否则裸名能在校验期通过、运行时 ENOENT）。
 */
export function resolveBinPath(bin: string): string | null {
  if (bin.includes("/")) {
    try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 校验 bin 是否可解析且可执行：直接复用 resolveBinPath。 */
function binIsExecutable(bin: string): boolean {
  return resolveBinPath(bin) !== null;
}
