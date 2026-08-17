import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { resolveEnvPlaceholders } from "./config.js";

/**
 * 显式构造 agent 子进程环境（spec §7.1）：不继承任意 shell 环境。
 * 关键：不引入任何白名单/黑名单——profile env 全量透传（Spike S4 已实测不影响 session 落盘）。
 */
export function buildAgentEnv(bin: string, profileEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    PATH: [dirname(bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    ...resolveEnvPlaceholders(profileEnv),
  };
}