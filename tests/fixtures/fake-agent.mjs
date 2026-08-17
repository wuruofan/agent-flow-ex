#!/usr/bin/env node
// 模拟 claude -p --output-format stream-json 的输出。FAKE_MODE: ok | needs_input | fail | hang
const mode = process.env.FAKE_MODE ?? "ok";
const sid = process.env.FAKE_SID ?? "fake-sid-0001";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (mode === "hang") {
  emit({ type: "system", subtype: "init", session_id: sid });
  setTimeout(() => {}, 60000);
} else if (mode === "fail") {
  process.stderr.write("fake agent boom\n");
  process.exit(3);
} else if (mode === "needs_input") {
  emit({ type: "system", subtype: "init", session_id: sid });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "❓NEEDS_INPUT: which database engine?" }] } });
  emit({ type: "result", subtype: "success", result: "❓NEEDS_INPUT: which database engine?", is_error: false });
} else {
  emit({ type: "system", subtype: "init", session_id: sid });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/fake.txt" } }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
  emit({ type: "result", subtype: "success", result: "all done", is_error: false });
}
process.stdin.on("data", () => {});