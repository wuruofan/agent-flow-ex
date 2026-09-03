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
  it("is an interactive card with no big colored header; status shown as emoji + bold line, markdown body", () => {
    const card = buildFeishuCard("completed", "task_abc", "done") as Record<string, any>;
    expect(card.header).toBeUndefined();
    const div = card.elements[0] as Record<string, any>;
    expect(div.tag).toBe("div");
    expect(div.text.tag).toBe("lark_md");
    expect(div.text.content).toContain("✅ **任务完成**");
    expect(div.text.content).toContain("task_abc");
    expect(div.text.content).toContain("done");
  });
  it("uses ❓/❌ emoji for needs_input/failed", () => {
    expect((buildFeishuCard("needs_input", "t", "d") as Record<string, any>).elements[0].text.content).toContain("❓ **需要输入**");
    expect((buildFeishuCard("failed", "t", "d") as Record<string, any>).elements[0].text.content).toContain("❌ **任务失败**");
  });
  it("puts the keyword in a footer note when configured (feishu keyword gate)", () => {
    const card = buildFeishuCard("completed", "task_abc", "done", "agent-flow-ex") as Record<string, any>;
    const note = card.elements.find((e: Record<string, any>) => e.tag === "note");
    expect(note).toBeDefined();
    expect(note.elements[0].content).toBe("agent-flow-ex");
  });
  it("omits the footer note when keyword is absent", () => {
    const card = buildFeishuCard("failed", "task_abc", "boom") as Record<string, any>;
    expect(card.elements.some((e: Record<string, any>) => e.tag === "note")).toBe(false);
  });
});