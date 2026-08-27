const MAX_ATTEMPTS = 3;

export interface NotifyOptions {
  fetchImpl?: typeof fetch;
  /** 重试间隔 ms（测试注入）；默认 [1000, 4000] */
  delays?: number[];
  /** dry_run=true 时只打印到 stderr，不发 HTTP，直接返回 true（"逻辑成功"）。默认 false。 */
  dryRun?: boolean;
}

export type FeishuStatus = "needs_input" | "completed" | "failed";

/** 飞书自定义机器人消息负载（text / interactive 共用通用发送）。 */
type FeishuPayload = Record<string, unknown>;

/**
 * 通用发送任意飞书消息负载。
 * 成功判定要求 HTTP 200 且 body.code===0——飞书即便出错也返回 HTTP 200，
 * 失败信息只在响应体 code 字段（如 19021 bot 不在群、19024 关键词缺失、19031 webhook 失效），
 * 只看 res.ok 会把"被拒收"误判为成功、消息静默丢失。
 */
async function post(webhookUrl: string, payload: FeishuPayload, opts: NotifyOptions = {}): Promise<boolean> {
  if (opts.dryRun) {
    console.error(`[notifier:dry-run] → ${webhookUrl}\n${JSON.stringify(payload, null, 2)}\n---`);
    return true;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.delays ?? [1000, 4000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      const code = typeof body.code === "number" ? body.code : res.ok ? 0 : -1;
      if (code === 0) return true;
      console.error(`[notifier] feishu rejected: HTTP ${res.status} code=${code} msg=${body.msg ?? ""} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (e) {
      console.error(`[notifier] ${e} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(delays[attempt - 1] ?? 4000);
  }
  return false;
}

/** 发送纯文本消息（保留，单测覆盖 post 的 HTTP/code 逻辑；正式通知已改用卡片）。 */
export async function sendFeishuText(webhookUrl: string, text: string, opts: NotifyOptions = {}): Promise<boolean> {
  return post(webhookUrl, { msg_type: "text", content: { text } }, opts);
}

/** 发送交互卡片消息。 */
export async function sendFeishuCard(webhookUrl: string, card: Record<string, unknown>, opts: NotifyOptions = {}): Promise<boolean> {
  return post(webhookUrl, { msg_type: "interactive", card }, opts);
}

/**
 * 构建飞书交互卡片：去掉 header 大色块横幅（太抢眼），改用正文首行「emoji + 加粗状态」
 * 引导（emoji 自带颜色：✅绿/❌红/❓蓝），下方接任务ID与 markdown 详情（lark_md 渲染）。
 * keyword 放进 footer 的 note（灰色小字），既满足机器人「关键词」安全闸门又不干扰正文；
 * 缺省时不加 note。
 *
 * 注：自定义机器人卡片 schema 不支持 `tag` 元素（实测 11310 unsupported type of block），
 * 故状态色用 emoji 而非彩色 pill 表达。
 */
export function buildFeishuCard(
  status: FeishuStatus,
  taskId: string,
  detail: string,
  keyword?: string,
): Record<string, unknown> {
  const statusEmoji = { needs_input: "❓", completed: "✅", failed: "❌" }[status];
  const statusText = { needs_input: "需要输入", completed: "任务完成", failed: "任务失败" }[status];
  const elements: Record<string, unknown>[] = [
    { tag: "div", text: { tag: "lark_md", content: `${statusEmoji} **${statusText}**\n\n**任务ID**：\`${taskId}\`\n\n${detail}` } },
  ];
  if (keyword) elements.push({ tag: "note", elements: [{ tag: "plain_text", content: keyword }] });
  return {
    config: { wide_screen_mode: true },
    elements,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
