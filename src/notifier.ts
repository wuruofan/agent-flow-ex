const MAX_ATTEMPTS = 3;

export interface NotifyOptions {
  fetchImpl?: typeof fetch;
  /** 重试间隔 ms（测试注入空数组）；默认 [1000, 4000] */
  delays?: number[];
  /** dry_run=true 时只打印到 stderr，不发 HTTP，直接返回 true（"逻辑成功"）。默认 false。 */
  dryRun?: boolean;
}

/** 发送飞书自定义机器人文本消息。成功返回 true；重试耗尽返回 false（调用方置 notify_failed）。 */
export async function sendFeishuText(webhookUrl: string, text: string, opts: NotifyOptions = {}): Promise<boolean> {
  if (opts.dryRun) {
    console.error(`[notifier:dry-run] → ${webhookUrl}\n${text}\n---`);
    return true;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.delays ?? [1000, 4000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text } }),
      });
      if (res.ok) return true;
      console.error(`[notifier] HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (e) {
      console.error(`[notifier] ${e} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(delays[attempt - 1] ?? 4000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 三类事件的推送文案（spec §4.4）。 */
export function notifyText(status: "needs_input" | "completed" | "failed", taskId: string, detail: string): string {
  const head = { needs_input: "❓任务需要输入", completed: "✅任务完成", failed: "❌任务失败" }[status];
  return `${head} ${taskId}\n${detail}`;
}