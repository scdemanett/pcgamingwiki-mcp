import { describe, expect, it } from "vitest";
import { DEFAULT_QUEUE, RequestQueue } from "../src/client/queue.js";
import { PcgwError } from "../src/errors.js";
import { manualClock } from "./fake-fetch.js";

describe("RequestQueue", () => {
  it("never starts more than 50 requests in any 60 s window", async () => {
    const clock = manualClock(0);
    const q = new RequestQueue(DEFAULT_QUEUE, clock);
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 120 }, () => q.run(async () => void starts.push(clock.now()))));
    for (let i = 0; i < starts.length; i++) {
      const inWindow = starts.filter((t) => t > starts[i]! - 60_000 && t <= starts[i]!).length;
      expect(inWindow).toBeLessThanOrEqual(50);
    }
    expect(starts[50]).toBe(60_000);
    expect(starts[100]).toBe(120_000);
  });

  it("runs one request at a time", async () => {
    const q = new RequestQueue(DEFAULT_QUEUE, manualClock());
    let active = 0;
    let maxActive = 0;
    const job = () =>
      q.run(async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
      });
    await Promise.all([job(), job(), job()]);
    expect(maxActive).toBe(1);
  });

  it("refuses every request for 61 s after pause(), then resumes", async () => {
    const clock = manualClock(0);
    const q = new RequestQueue(DEFAULT_QUEUE, clock);
    q.pause();
    const err = await q.run(async () => "ran").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PcgwError);
    expect((err as PcgwError).code).toBe("rate_limited");
    expect((err as PcgwError).details.retry_after_s).toBe(61);
    clock.t = 60_999;
    await expect(q.run(async () => "ran")).rejects.toMatchObject({ code: "rate_limited", details: { retry_after_s: 1 } });
    clock.t = 61_000;
    await expect(q.run(async () => "ran")).resolves.toBe("ran");
  });

  it("keeps going after a failed job", async () => {
    const q = new RequestQueue(DEFAULT_QUEUE, manualClock());
    await expect(q.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(q.run(async () => 1)).resolves.toBe(1);
  });
});
