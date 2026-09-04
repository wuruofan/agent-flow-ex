// Generates dist/build-meta.json with build identity so a running server can
// report which code it is running (agent_flow_version). Runs as the post-build
// step of `npm run build`. dist/ is gitignored, so this is generated, not committed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/.. -> project root
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let gitSha = "unknown";
try {
  gitSha = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
} catch {
  // Not a git checkout or git unavailable — leave "unknown".
}

const meta = {
  version: pkg.version,
  gitSha,
  buildTime: new Date().toISOString(),
};
writeFileSync(join(distDir, "build-meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.error(`[agent-flow-ex] build-meta.json -> v${meta.version} ${meta.gitSha} @ ${meta.buildTime}`);
