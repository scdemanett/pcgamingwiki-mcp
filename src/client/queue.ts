import { PcgwError } from "../errors.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface QueueOptions {
  /** Max requests in any rolling window. PCGW allows 60/min; we use 50. */
  maxPerWindow: number;
  windowMs: number;
  /** How long everything stops after a 429. PCGW blocks for 60 s; we wait 61. */
  pauseMs: number;
}

export const DEFAULT_QUEUE: QueueOptions = { maxPerWindow: 50, windowMs: 60_000, pauseMs: 61_000 };

/**
 * The only path to the network. Runs one request at a time and keeps at most
 * `maxPerWindow` request starts in any rolling `windowMs` (a sliding-window log,
 * which unlike a token bucket can't burst past the limit across a window edge).
 * After `pause()`, every request is refused with `rate_limited` until the pause ends.
 */
export class RequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private starts: number[] = [];
  private pausedUntil = 0;

  constructor(
    private readonly opts: QueueOptions = DEFAULT_QUEUE,
    private readonly clock: Clock = realClock,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(() => this.exec(fn));
    this.tail = job.catch(() => undefined);
    return job;
  }

  /** Call on HTTP 429: stops all requests for `pauseMs`, with no retry before then. */
  pause(): void {
    this.pausedUntil = this.clock.now() + this.opts.pauseMs;
  }

  pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.clock.now());
  }

  private async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.assertNotPaused();
    for (;;) {
      const now = this.clock.now();
      this.starts = this.starts.filter((t) => now - t < this.opts.windowMs);
      if (this.starts.length < this.opts.maxPerWindow) break;
      await this.clock.sleep(this.starts[0]! + this.opts.windowMs - now);
      this.assertNotPaused();
    }
    this.starts.push(this.clock.now());
    return fn();
  }

  private assertNotPaused(): void {
    const ms = this.pausedForMs();
    if (ms > 0) {
      const retry_after_s = Math.ceil(ms / 1000);
      throw new PcgwError(
        "rate_limited",
        `PCGamingWiki rate limit hit; all requests are paused for ${retry_after_s} s. Try again after that.`,
        { retry_after_s },
      );
    }
  }
}
