// stdio 冒烟：模拟 Trae 客户端发 initialize + tools/list 给 server.js
import { spawn } from "node:child_process";

const server = spawn("/usr/local/bin/node", ["/Users/meow/workspace/agent-flow-ex/dist/server.js"], {
  env: { ...process.env, AGENT_FLOW_HOME: "/tmp/agent-flow-ex-smoke" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });

const buf = [];
server.stdout.on("data", (d) => { buf.push(d); });

const send = (obj) => server.stdin.write(JSON.stringify(obj) + "\n");

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

setTimeout(() => {
  server.kill();
  const stdout = Buffer.concat(buf).toString();
  console.log("=== stderr ===");
  console.log(stderr);
  console.log("=== stdout (first 2000 chars) ===");
  console.log(stdout.slice(0, 2000));
  for (const line of stdout.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.id === 2 && j.result?.tools) {
        const names = j.result.tools.map((t) => t.name);
        console.log("=== tools ===");
        console.log(names);
        const want = ["agent_flow_submit", "agent_flow_status", "agent_flow_cancel"];
        const missing = want.filter((n) => !names.includes(n));
        if (missing.length === 0) console.log("OK: all three tools registered");
        else { console.log("FAIL: missing", missing); process.exit(1); }
      }
    } catch {}
  }
}, 1500);