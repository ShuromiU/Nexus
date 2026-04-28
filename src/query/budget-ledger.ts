/**
 * Per-session budget accountant (D4). In-memory ring buffer of `pack()`
 * invocations, surfaced via `stats({ session: true })`. A "session" is one
 * process lifetime — the MCP server holds a long-lived QueryEngine and
 * therefore a long-lived ledger, while the CLI creates a fresh engine
 * per command (so each CLI invocation reports a single-call session).
 *
 * Pure data: no fs / network / db. Default capacity 50; the buffer
 * overwrites oldest entries when full.
 */

export interface BudgetEntry {
  /** Original pack() query string. */
  query: string;
  /** Configured budget in tokens. */
  budget_tokens: number;
  /** Tokens actually packed. */
  total_tokens: number;
  /** Items included in the pack output. */
  included_count: number;
  /** Items the budget forced to skip. */
  skipped_count: number;
  /** Wall-clock ms for the pack call (best-effort). */
  timing_ms: number;
  /** ISO-8601 timestamp at record time. */
  timestamp: string;
}

export interface BudgetSummary {
  /** Number of entries currently held (≤ capacity). */
  pack_runs: number;
  /** Sum of total_tokens across all entries. */
  total_tokens_used: number;
  /** Sum of budget_tokens across all entries. */
  total_budget_allocated: number;
  /** Entries where total_tokens >= budget_tokens (saturated the budget). */
  hit_budget_count: number;
  /** Mean total_tokens / budget_tokens ratio across entries (0..1). NaN-safe. */
  avg_utilization: number;
  /** Cumulative ms spent across all entries. */
  total_timing_ms: number;
}

export class BudgetLedger {
  private buffer: BudgetEntry[] = [];
  private nextIndex = 0;
  readonly capacity: number;

  constructor(capacity = 50) {
    if (capacity < 1) throw new Error('BudgetLedger capacity must be >= 1');
    this.capacity = capacity;
  }

  /**
   * Append an entry. When the buffer is full, overwrites the oldest slot.
   */
  record(entry: BudgetEntry): void {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(entry);
    } else {
      this.buffer[this.nextIndex] = entry;
    }
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
  }

  /**
   * Entries in chronological order (oldest first), up to `limit`. When
   * limit is omitted, returns all held entries. Always returns a fresh
   * array — caller may mutate without affecting the ledger.
   */
  entries(limit?: number): BudgetEntry[] {
    if (this.buffer.length < this.capacity) {
      const all = this.buffer.slice();
      return limit != null ? all.slice(-limit) : all;
    }
    // Buffer is at capacity; nextIndex points at the oldest slot.
    const ordered = [
      ...this.buffer.slice(this.nextIndex),
      ...this.buffer.slice(0, this.nextIndex),
    ];
    return limit != null ? ordered.slice(-limit) : ordered;
  }

  summary(): BudgetSummary {
    const all = this.entries();
    if (all.length === 0) {
      return {
        pack_runs: 0,
        total_tokens_used: 0,
        total_budget_allocated: 0,
        hit_budget_count: 0,
        avg_utilization: 0,
        total_timing_ms: 0,
      };
    }
    let used = 0;
    let allocated = 0;
    let hits = 0;
    let utilSum = 0;
    let timing = 0;
    for (const e of all) {
      used += e.total_tokens;
      allocated += e.budget_tokens;
      timing += e.timing_ms;
      if (e.total_tokens >= e.budget_tokens) hits++;
      utilSum += e.budget_tokens > 0 ? e.total_tokens / e.budget_tokens : 0;
    }
    return {
      pack_runs: all.length,
      total_tokens_used: used,
      total_budget_allocated: allocated,
      hit_budget_count: hits,
      avg_utilization: utilSum / all.length,
      total_timing_ms: timing,
    };
  }

  /** Empty the ledger. Mostly for tests. */
  clear(): void {
    this.buffer = [];
    this.nextIndex = 0;
  }
}
