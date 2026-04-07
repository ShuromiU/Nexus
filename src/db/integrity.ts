import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase, applySchema, initializeMeta } from './schema.js';

export interface IntegrityResult {
  ok: boolean;
  message: string;
}

/**
 * Run SQLite quick_check — fast corruption detection.
 * Returns ok:true if database passes, ok:false with message if corrupt.
 */
export function quickCheck(db: Database.Database): IntegrityResult {
  try {
    const result = db.pragma('quick_check') as { quick_check: string }[];
    const status = result[0]?.quick_check;
    if (status === 'ok') {
      return { ok: true, message: 'ok' };
    }
    return { ok: false, message: status ?? 'unknown error' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'quick_check failed',
    };
  }
}

/**
 * Run full SQLite integrity_check — thorough corruption detection.
 * Slower than quick_check but more comprehensive.
 */
export function fullIntegrityCheck(db: Database.Database): IntegrityResult {
  try {
    const result = db.pragma('integrity_check') as {
      integrity_check: string;
    }[];
    const status = result[0]?.integrity_check;
    if (status === 'ok') {
      return { ok: true, message: 'ok' };
    }
    return { ok: false, message: status ?? 'unknown error' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'integrity_check failed',
    };
  }
}

/**
 * Open database with corruption detection.
 * If quick_check fails, deletes the DB and creates a fresh one.
 */
export function openWithIntegrityCheck(
  dbPath: string,
  rootPath: string,
  fsCaseSensitive: boolean,
): { db: Database.Database; wasCorrupt: boolean } {
  let db: Database.Database;
  let wasCorrupt = false;

  try {
    // Probe with raw constructor — don't run pragmas yet (they throw on corrupt files)
    const probe = new Database(dbPath);
    const check = quickCheck(probe);

    if (!check.ok) {
      probe.close();
      wasCorrupt = true;
      deleteDbFiles(dbPath);
      db = openDatabase(dbPath);
    } else {
      probe.close();
      db = openDatabase(dbPath);
    }
  } catch {
    // Can't even open — recreate
    wasCorrupt = true;
    deleteDbFiles(dbPath);
    db = openDatabase(dbPath);
  }

  applySchema(db);

  if (wasCorrupt) {
    initializeMeta(db, rootPath, fsCaseSensitive);
  }

  return { db, wasCorrupt };
}

/**
 * Repair command: run full integrity_check, rebuild if issues found.
 * Returns whether a rebuild was needed.
 */
export function repair(
  dbPath: string,
  rootPath: string,
  fsCaseSensitive: boolean,
): { needsRebuild: boolean; message: string } {
  try {
    // Probe with raw constructor to avoid pragma throws on corrupt files
    const probe = new Database(dbPath);
    const check = fullIntegrityCheck(probe);
    probe.close();

    if (check.ok) {
      return { needsRebuild: false, message: 'Database integrity check passed' };
    }

    // Corrupt — delete and recreate
    deleteDbFiles(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);
    initializeMeta(db, rootPath, fsCaseSensitive);
    db.close();

    return { needsRebuild: true, message: `Corruption detected: ${check.message}. Database rebuilt.` };
  } catch (err) {
    // Can't even open — delete and recreate
    deleteDbFiles(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);
    initializeMeta(db, rootPath, fsCaseSensitive);
    db.close();

    return {
      needsRebuild: true,
      message: `Database unreadable: ${err instanceof Error ? err.message : 'unknown'}. Rebuilt from scratch.`,
    };
  }
}

function deleteDbFiles(dbPath: string): void {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
}

