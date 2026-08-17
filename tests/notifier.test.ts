import { describe, expect, it, vi } from "vitest";
import { sendFeishuText } from "../src/notifier.js";

function mockFetch(sequence: Array<{ ok: boolean; status?: number }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = sequence[Math.min(i++, sequence.length - 1)];
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, status: 200 } as Response;
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
});