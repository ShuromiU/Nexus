import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase } from '../db/schema.js';

export interface StaleHintInput {
  rootDir: string;
  touchedAbsPath?: string;
}

/**
 * Best-effort staleness hint. True = the policy decision MAY be based on
 * out-of-date index state. The policy entry intentionally does not re-index.
 *
 * - No DB yet → stale (nothing has been indexed).
 * - No touched file → compare only against presence of last_indexed_at meta.
 * - Touched file exists → stale if its mtime is newer than last_indexed_at.
 * - Touched file missing → cannot prove staleness; return false.
 */
export function computeStaleHint(input: StaleHintInput): boolean {
  const dbPath = path.join(input.rootDir, '.nexus', 'index.db');
  if (!fs.existsSync(dbPath)) return true;

  let lastIndexedAtMs = 0;
  try {
    const db = openDatabase(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('last_indexed_at') as { value: string } | undefined;
    db.close();
    if (!row) return true;
    const t = Date.parse(row.value);
    if (Number.isNaN(t)) return true;
    lastIndexedAtMs = t;
  } catch {
    return true;
  }

  if (!input.touchedAbsPath) return false;

  try {
    const stat = fs.statSync(input.touchedAbsPath);
    return stat.mtimeMs > lastIndexedAtMs;
  } catch {
    return false;
  }
}
