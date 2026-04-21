export interface CacheOptions {
  maxEntries: number;
  maxBytes: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: unknown;
  bytes: number;
}

export class DocumentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: CacheOptions) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
  }

  get(absPath: string, mtimeMs: number, size: number): unknown | undefined {
    const entry = this.entries.get(absPath);
    if (!entry) return undefined;
    if (entry.mtimeMs !== mtimeMs || entry.size !== size) return undefined;
    this.entries.delete(absPath);
    this.entries.set(absPath, entry);
    return entry.value;
  }

  set(
    absPath: string,
    mtimeMs: number,
    size: number,
    value: unknown,
    bytes: number,
  ): void {
    if (bytes > this.maxBytes) return;

    const existing = this.entries.get(absPath);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(absPath);
    }

    this.entries.set(absPath, { mtimeMs, size, value, bytes });
    this.totalBytes += bytes;

    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.totalBytes -= evicted.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes };
  }
}

const DEFAULT_OPTIONS: CacheOptions = {
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
};

let singleton: DocumentCache | null = null;

export function getDocumentCache(): DocumentCache {
  if (singleton === null) singleton = new DocumentCache(DEFAULT_OPTIONS);
  return singleton;
}

export function resetDocumentCache(): void {
  singleton = null;
}
