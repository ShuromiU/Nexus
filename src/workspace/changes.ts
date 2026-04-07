import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { ScannedFile } from './scanner.js';
import type { FileRow } from '../db/store.js';

export interface FileChange {
  /** The scanned file from disk (null for deletes) */
  file: ScannedFile | null;
  /** The existing DB row (null for adds) */
  dbRow: (FileRow & { id: number }) | null;
  /** What kind of change */
  action: 'add' | 'update' | 'delete' | 'hash_only' | 'unchanged';
  /** Computed SHA-256 hash (only for add/update) */
  hash?: string;
}

/**
 * Compute the SHA-256 hash of a file's contents.
 */
export function hashFile(absolutePath: string): string {
  const content = fs.readFileSync(absolutePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Diff scanned files against the DB state.
 * Returns a list of changes categorized by action.
 *
 * Fast path: if (mtime, size) are both unchanged, skip hash computation.
 * If mtime or size changed but hash is the same → hash_only (update mtime/size, no re-parse).
 */
export function detectChanges(
  scannedFiles: ScannedFile[],
  dbFiles: (FileRow & { id: number })[],
  caseSensitive: boolean,
): FileChange[] {
  const changes: FileChange[] = [];

  // Build lookup of DB files by path_key
  const dbByKey = new Map<string, FileRow & { id: number }>();
  for (const row of dbFiles) {
    dbByKey.set(row.path_key, row);
  }

  // Track which DB files we've seen (for detecting deletes)
  const seen = new Set<string>();

  for (const file of scannedFiles) {
    const pathKey = caseSensitive ? file.path : file.path.toLowerCase();
    seen.add(pathKey);

    const existing = dbByKey.get(pathKey);

    if (!existing) {
      // New file
      const hash = hashFile(file.absolutePath);
      changes.push({ file, dbRow: null, action: 'add', hash });
      continue;
    }

    // Fast path: (mtime, size) both unchanged → skip
    if (existing.mtime === file.mtime && existing.size === file.size) {
      changes.push({ file, dbRow: existing, action: 'unchanged' });
      continue;
    }

    // mtime or size changed — compute hash
    const hash = hashFile(file.absolutePath);

    if (hash === existing.hash) {
      // Content didn't actually change — just update mtime/size
      changes.push({ file, dbRow: existing, action: 'hash_only', hash });
    } else {
      // Content changed — needs re-parse
      changes.push({ file, dbRow: existing, action: 'update', hash });
    }
  }

  // Files in DB but not on disk → deleted
  for (const [key, row] of dbByKey) {
    if (!seen.has(key)) {
      changes.push({ file: null, dbRow: row, action: 'delete' });
    }
  }

  return changes;
}

/**
 * Summary of changes for logging/stats.
 */
export function summarizeChanges(changes: FileChange[]): {
  added: number;
  updated: number;
  deleted: number;
  hashOnly: number;
  unchanged: number;
} {
  let added = 0, updated = 0, deleted = 0, hashOnly = 0, unchanged = 0;
  for (const c of changes) {
    switch (c.action) {
      case 'add': added++; break;
      case 'update': updated++; break;
      case 'delete': deleted++; break;
      case 'hash_only': hashOnly++; break;
      case 'unchanged': unchanged++; break;
    }
  }
  return { added, updated, deleted, hashOnly, unchanged };
}
