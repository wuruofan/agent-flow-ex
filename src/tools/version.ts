import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Compiled: dist/tools/version.js -> root = ../../ ; dev: src/tools -> root = ../..
const projectRoot = join(__dirname, "..", "..");

export interface BuildMeta {
  version: string;
  gitSha: string;
  buildTime: string;
}

export type VersionResult = BuildMeta | { unknown: true; note: string };

/**
 * Reports the build identity baked in at `npm run build` time (dist/build-meta.json).
 * After restarting the server, call this to confirm the new build is live.
 */
export function version(metaPath: string = join(projectRoot, "dist", "build-meta.json")): VersionResult {
  if (!existsSync(metaPath)) {
    return { unknown: true, note: "build-meta.json not found; run `npm run build`" };
  }
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as BuildMeta;
  } catch {
    return { unknown: true, note: "build-meta.json unreadable" };
  }
}
