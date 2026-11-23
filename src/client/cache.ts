import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LRUCache } from "lru-cache";

export interface CacheEntry {
  body: unknown;
  /** ISO time the response was fetched from PCGW. */
  fetchedAt: string;
}

interface Stored extends CacheEntry {
  expires: number;
}

interface DiskRecord extends Stored {
  key: string;
}

export interface CacheOptions {
  ttlMs: number;
  max: number;
  /** Optional directory for a persistent per-user cache. */
  dir?: string;
  now?: () => number;
}

/**
 * Response cache keyed by request URL (which never carries credentials).
 * In-memory LRU plus optional disk persistence, both with the same TTL.
 * Expiry is checked by hand against `now`: lru-cache's own TTL caches the clock
 * between timer ticks, so it can serve an entry slightly past its TTL.
 */
export class ResponseCache {
  private readonly mem: LRUCache<string, Stored>;
  private readonly now: () => number;

  constructor(private readonly opts: CacheOptions) {
    this.now = opts.now ?? Date.now;
    this.mem = new LRUCache<string, Stored>({ max: opts.max });
  }

  get enabled(): boolean {
    return this.opts.ttlMs > 0;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    if (!this.enabled) return undefined;
    const hit = this.mem.get(key);
    if (hit && hit.expires > this.now()) return { body: hit.body, fetchedAt: hit.fetchedAt };
    if (hit) this.mem.delete(key);
    if (!this.opts.dir) return undefined;
    try {
      const rec = JSON.parse(await readFile(this.file(key), "utf8")) as DiskRecord;
      if (rec.key !== key || rec.expires <= this.now()) return undefined;
      this.mem.set(key, { body: rec.body, fetchedAt: rec.fetchedAt, expires: rec.expires });
      return { body: rec.body, fetchedAt: rec.fetchedAt };
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    if (!this.enabled) return;
    const stored: Stored = { body: entry.body, fetchedAt: entry.fetchedAt, expires: this.now() + this.opts.ttlMs };
    this.mem.set(key, stored);
    if (!this.opts.dir) return;
    const rec: DiskRecord = { key, ...stored };
    try {
      await mkdir(this.opts.dir, { recursive: true });
      await writeFile(this.file(key), JSON.stringify(rec));
    } catch {
      // Disk cache is best-effort; memory still has it.
    }
  }

  private file(key: string): string {
    return join(this.opts.dir!, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
}
