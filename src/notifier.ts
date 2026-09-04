const MAX_ATTEMPTS = 3;

export interface NotifyOptions {
  fetchImpl?: typeof fetch;
  /** 重试间隔 ms（测试注入）；默认 [1000, 4000] */
  delays?: number[];
  /** dry_run=true 时只打印到 stderr，不发 HTTP，直接返回 true（"逻辑成功"）。默认 false。 */
  dryRun?: boolean;
  /** 单次请求超时 ms；默认 10_000。超时按一次失败计数，走既有重试。 */
  timeoutMs?: number;
}

export type FeishuStatus = "needs_input" | "completed" | "failed" | "quota_warning";

/** 飞书自定义机器人消息负载（text / interactive 共用通用发送）。 */
type FeishuPayload = Record<string, unknown>;

/**
 * 通用发送任意飞书消息负载。
 * 成功判定要求 HTTP 200 且 body.code===0——飞书即便出错也返回 HTTP 200，
 * 失败信息只在响应体 code 字段（如 19021 bot 不在群、19024 关键词缺失、19031 webhook 失效），
 * 只看 res.ok 会把"被拒收"误判为成功、消息静默丢失。
 *
 * 每次尝试带 AbortController 超时（默认 10s）：飞书 webhook 偶发慢响应/半开时，
 * 若无超时单次请求会无限挂起直到 OS TCP 层超时（分钟级），表现就是任务已终态、
 * 通知还在路上（9/3 实测迟到约 2 分钟）。超时按一次失败计数，走 delays 重试。
 */
async function post(webhookUrl: string, payload: FeishuPayload, opts: NotifyOptions = {}): Promise<boolean> {
  if (opts.dryRun) {
    console.error(`[notifier:dry-run] → ${webhookUrl}\n${JSON.stringify(payload, null, 2)}\n---`);
    return true;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.delays ?? [1000, 4000];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      const code = typeof body.code === "number" ? body.code : res.ok ? 0 : -1;
      if (code === 0) return true;
      console.error(`[notifier] feishu rejected: HTTP ${res.status} code=${code} msg=${body.msg ?? ""} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (e) {
      const reason = e instanceof Error && e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e);
      console.error(`[notifier] ${reason} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } finally {
      clearTimeout(timer);
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
 * 构建飞书交互卡片（JSON 2.0 schema）。
 *
 * 2026-09-03 自 1.0 迁移：1.0 的 lark_md（div/text 元素）只支持 Markdown 子集
 * （粗体/斜体/删除线/链接等），# 标题 与 | 表格 | 均不渲染——官方明确标题/引用/表格
 * 语法仅 JSON 2.0 富文本组件支持。2.0 顶层为 schema/body.elements，正文用 tag=markdown
 * 组件（非 1.0 的 div/text/lark_md），content 支持完整 GFM（标题 1-6 级、表格、引用、列表）。
 *
 * 视觉保持与 1.0 一致：无 header 大色块横幅（太抢眼），首行「emoji + 加粗状态」引导
 * （emoji 自带颜色：✅绿/❌红/❓蓝），下方接任务ID与 markdown 详情（worker 返回原文）。
 * keyword 进「关键词」安全闸门：2.0 组件清单已移除 1.0 的 note 组件，改用 markdown 组件
 * text_size=notation（12px 辅助信息灰字）置于正文后，效果等价；缺省时不加。
 *
 * 注：2.0 卡片要求飞书客户端 ≥7.20（低版本展示升级提示兜底文案）；config 不再支持
 * 1.0 的 wide_screen_mode，宽度由 width_mode 控制（默认即 600px 宽版），故省略 config。
 */
export function buildFeishuCard(
  status: FeishuStatus,
  taskId: string,
  detail: string,
  keyword?: string,
): Record<string, unknown> {
  const statusEmoji = { needs_input: "❓", completed: "✅", failed: "❌", quota_warning: "⚠️" }[status];
  const statusText = { needs_input: "需要输入", completed: "任务完成", failed: "任务失败", quota_warning: "配额告警" }[status];
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: `${statusEmoji} **${statusText}**\n\n**任务ID**：\`${taskId}\`\n\n${detail}` },
  ];
  if (keyword) elements.push({ tag: "markdown", text_size: "notation", content: keyword });
  return {
    schema: "2.0",
    body: { elements },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
