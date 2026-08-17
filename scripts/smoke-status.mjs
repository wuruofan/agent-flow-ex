// stdio 冒烟 #2：调 tools/call agent_flow_status 无参，期望 []
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "afex-smoke-"));
mkdirSync(join(home, "logs"), { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({
  executors: { fake: { bin: process.execPath, extra_flags: [] } },
  profiles: { fake: { executor: "fake", env: {} } },
  notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
  defaults: { profile: "fake", timeout_sec: 60 },
}));

const server = spawn("/usr/local/bin/node", ["/Users/meow/workspace/agent-flow-ex/dist/server.js"], {
  env: { ...process.env, AGENT_FLOW_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });
const buf = [];
server.stdout.on("data", (d) => { buf.push(d); });

const send = (obj) => server.stdin.write(JSON.stringify(obj) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_flow_status", arguments: {} } });

setTimeout(() => {
  server.kill();
  const stdout = Buffer.concat(buf).toString();
  let ok = false;
  for (const line of stdout.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.id === 2 && j.result?.content?.[0]?.text) {
        const parsed = JSON.parse(j.result.content[0].text);
        console.log("status result:", JSON.stringify(parsed));
        if (Array.isArray(parsed) && parsed.length === 0) { ok = true; }
      }
    } catch {}
  }
  console.log(ok ? "OK: status returned []" : "FAIL");
  process.exit(ok ? 0 : 1);
}, 1500);