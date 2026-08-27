/**
 * $AGENT_FLOW_HOME/.env 加载器。
 *
 * 密钥管理约定：config.json 只含 {env:VAR} 占位符（零明文），真实值落在 .env
 * （init 生成，chmod 600，位于 home 下、不进 git/不被同步）。
 * server 启动时加载一次灌入 process.env；runner 是 server 的 detached 子进程
 * （spawn 时 env: {...process.env}），自动继承，无需在 runner 侧重复加载。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentFlowHome } from "./paths.js";

/** 解析 .env 文本为 KV 列表（保留出现顺序；跳过空行与 # 注释；等号后值整体保留，含引号原样）。 */
export function parseEnvText(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) out.push([k, v]);
  }
  return out;
}

/**
 * 把 $AGENT_FLOW_HOME/.env 灌入 process.env。
 * 只补缺失（??=），不覆盖已有环境变量——真实 shell env 优先于 .env。
 * 文件不存在则静默返回。
 */
export function loadEnvFile(home: string = agentFlowHome()): void {
  const p = join(home, ".env");
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  for (const [k, v] of parseEnvText(text)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
