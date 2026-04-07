import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

const LOCK_TTL_MS = 60_000; // 60s lock TTL
const HEARTBEAT_INTERVAL_MS = 15_000; // 15s heartbeat

export interface LockInfo {
  holder_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export class IndexLock {
  private holderId: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private db: Database.Database) {
    this.holderId = randomUUID();
  }

  /**
   * Try to acquire the singleton index lock.
   * Returns true if acquired, false if another process holds it.
   */
  acquire(): boolean {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();

    // Use BEGIN IMMEDIATE to get a write lock immediately
    const tryAcquire = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM index_lock WHERE id = 1')
        .get() as LockInfo | undefined;

      if (existing) {
        // Check if lock is expired
        const expiresTime = new Date(existing.expires_at).getTime();
        if (expiresTime > Date.now()) {
          // Lock is still valid — someone else has it
          return false;
        }
        // Lock expired — take over
      }

      this.db
        .prepare(
          `INSERT OR REPLACE INTO index_lock (id, holder_id, acquired_at, heartbeat_at, expires_at)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(this.holderId, now, now, expiresAt);

      return true;
    });

    const acquired = tryAcquire.immediate();

    if (acquired) {
      this.startHeartbeat();
    }

    return acquired;
  }

  /**
   * Release the lock. Only releases if we're the holder.
   */
  release(): void {
    this.stopHeartbeat();

    try {
      this.db
        .prepare('DELETE FROM index_lock WHERE id = 1 AND holder_id = ?')
        .run(this.holderId);
    } catch {
      // DB might be closed already — ignore
    }
  }

  /**
   * Check if the lock is currently held (by anyone).
   */
  isLocked(): boolean {
    const existing = this.db
      .prepare('SELECT * FROM index_lock WHERE id = 1')
      .get() as LockInfo | undefined;

    if (!existing) return false;

    return new Date(existing.expires_at).getTime() > Date.now();
  }

  /**
   * Get info about the current lock holder (if any).
   */
  getLockInfo(): LockInfo | null {
    const existing = this.db
      .prepare('SELECT * FROM index_lock WHERE id = 1')
      .get() as LockInfo | undefined;

    if (!existing) return null;

    if (new Date(existing.expires_at).getTime() <= Date.now()) {
      return null; // expired
    }

    return existing;
  }

  /**
   * Send a heartbeat — extends the lock TTL.
   * Only works if we're the current holder.
   */
  heartbeat(): boolean {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();

    const result = this.db
      .prepare(
        `UPDATE index_lock SET heartbeat_at = ?, expires_at = ?
         WHERE id = 1 AND holder_id = ?`,
      )
      .run(now, expiresAt, this.holderId);

    return result.changes > 0;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    // Don't prevent Node from exiting
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  get id(): string {
    return this.holderId;
  }
}
