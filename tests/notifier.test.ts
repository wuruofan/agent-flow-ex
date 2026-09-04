import { describe, expect, it, vi } from "vitest";
import { buildFeishuCard, sendFeishuText } from "../src/notifier.js";

function mockFetch(sequence: Array<{ ok: boolean; status?: number; code?: number }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = sequence[Math.min(i++, sequence.length - 1)];
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, status: 200, json: async () => ({ code: r.code ?? 0 }) } as Response;
  });
}

describe("sendFeishuText", () => {
  it("sends text message payload once on success", async () => {
    const fetchMock = mockFetch([{ ok: true }]);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [] });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown[])[1]!.body as string);
    expect(body).toEqual({ msg_type: "text", content: { text: "hello" } });
  });
  it("retries 3 times with backoff then gives up", async () => {
    const fetchMock = mockFetch([{ ok: false, status: 500 }, { ok: false, status: 500 }, { ok: false, status: 500 }]);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [0, 0] });
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("succeeds on second attempt", async () => {
    const fetchMock = mockFetch([{ ok: false, status: 429 }, { ok: true }]);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [0] });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("dry_run skips HTTP entirely and returns true", async () => {
    const fetchMock = vi.fn();
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, dryRun: true });
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("treats HTTP 200 with non-zero feishu code as failure (regression: 19021 bot not in group was silent)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 19021, msg: "bot is not in the group" }) }) as Response);
    const ok = await sendFeishuText("https://hook/x", "hello", { fetchImpl: fetchMock as unknown as typeof fetch, delays: [0, 0] });
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("times out a hanging request and counts it as a failed attempt (regression: no timeout hung for minutes until TCP layer)", async () => {
    // fetch stub 永不 resolve，只响应 abort signal——模拟飞书慢响应/半开
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    const ok = await sendFeishuText("https://hook/x", "hello", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      delays: [0, 0],
      timeoutMs: 20,
    });
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 3 次全超时 → 放弃
  });
  it("succeeds on retry after a timeout", async () => {
    let call = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      if (call++ === 0) {
        return new Promise<Response>((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ code: 0 }) } as Response);
    });
    const ok = await sendFeishuText("https://hook/x", "hello", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      delays: [0],
      timeoutMs: 20,
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("buildFeishuCard", () => {
  it("is a JSON 2.0 card with no colored header; status as emoji + bold line, full-markdown body", () => {
    const card = buildFeishuCard("completed", "task_abc", "done") as Record<string, any>;
    expect(card.schema).toBe("2.0");
    expect(card.header).toBeUndefined();
    const md = card.body.elements[0] as Record<string, any>;
    expect(md.tag).toBe("markdown");
    expect(md.content).toContain("✅ **任务完成**");
    expect(md.content).toContain("task_abc");
    expect(md.content).toContain("done");
  });
  it("keeps headings and table syntax intact in the body (regression: 1.0 lark_md dropped both)", () => {
    const detail = "# 报告标题\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const md = (buildFeishuCard("completed", "t", detail) as Record<string, any>).body.elements[0];
    expect(md.content).toContain("# 报告标题");
    expect(md.content).toContain("| A | B |");
  });
  it("uses ❓/❌ emoji for needs_input/failed", () => {
    expect((buildFeishuCard("needs_input", "t", "d") as Record<string, any>).body.elements[0].content).toContain("❓ **需要输入**");
    expect((buildFeishuCard("failed", "t", "d") as Record<string, any>).body.elements[0].content).toContain("❌ **任务失败**");
  });
  // 2026-09-03：新增 quota_warning 状态——中途配额/限流告警，与其他终态卡风格一致
  it("renders ⚠️ quota_warning card on schema 2.0", () => {
    const card = buildFeishuCard("quota_warning", "task_q", "API Error: 429 Token Plan 用量上限") as Record<string, any>;
    expect(card.schema).toBe("2.0");
    const md = card.body.elements[0] as Record<string, any>;
    expect(md.tag).toBe("markdown");
    expect(md.content).toContain("⚠️ **配额告警**");
    expect(md.content).toContain("task_q");
    expect(md.content).toContain("429");
  });
  it("appends keyword as notation-sized markdown when configured (keyword gate; v2 has no note component)", () => {
    const card = buildFeishuCard("completed", "task_abc", "done", "agent-flow-ex") as Record<string, any>;
    const kws = card.body.elements.filter((e: Record<string, any>) => e.tag === "markdown" && e.text_size === "notation");
    expect(kws).toHaveLength(1);
    expect(kws[0].content).toBe("agent-flow-ex");
  });
  it("omits the keyword element when keyword is absent", () => {
    const card = buildFeishuCard("failed", "task_abc", "boom") as Record<string, any>;
    expect(card.body.elements.some((e: Record<string, any>) => e.tag === "markdown" && e.text_size === "notation")).toBe(false);
  });
});