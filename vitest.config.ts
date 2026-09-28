import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // wait-task.test.mjs 是 skill 的独立 node 测试（自带 runner，直接 `node` 执行），
    // 依赖 node:sqlite 且不走 vitest；默认 glob 会把它误收进来并因模块解析失败而报 FAIL。
    exclude: ["**/node_modules/**", "skills/**/*.test.mjs"],
  },
});
