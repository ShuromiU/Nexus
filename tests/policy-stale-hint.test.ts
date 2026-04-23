import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase, applySchema } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { computeStaleHint } from '../src/policy/stale-hint.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stale-'));
  fs.mkdirSync(path.join(tmpDir, '.nexus'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLastIndexed(dbPath: string, iso: string) {
  const db = openDatabase(dbPath);
  applySchema(db);
  const store = new NexusStore(db);
  store.setMeta('last_indexed_at', iso);
  db.close();
}

describe('computeStaleHint', () => {
  it('returns false when no touched file given and index exists', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    writeLastIndexed(dbPath, new Date().toISOString());
    const hint = computeStaleHint({ rootDir: tmpDir });
    expect(hint).toBe(false);
  });

  it('returns true when touched file mtime is newer than last_indexed_at', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    const touched = path.join(tmpDir, 'src.ts');
    writeLastIndexed(dbPath, '2000-01-01T00:00:00Z');
    fs.writeFileSync(touched, 'x');
    const hint = computeStaleHint({ rootDir: tmpDir, touchedAbsPath: touched });
    expect(hint).toBe(true);
  });

  it('returns false when touched file mtime is older than last_indexed_at', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    const touched = path.join(tmpDir, 'src.ts');
    fs.writeFileSync(touched, 'x');
    writeLastIndexed(dbPath, new Date(Date.now() + 60_000).toISOString());
    const hint = computeStaleHint({ rootDir: tmpDir, touchedAbsPath: touched });
    expect(hint).toBe(false);
  });

  it('returns true when DB is missing', () => {
    const hint = computeStaleHint({ rootDir: tmpDir });
    expect(hint).toBe(true);
  });

  it('returns false when touched file is missing (cannot disprove freshness)', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    writeLastIndexed(dbPath, new Date().toISOString());
    const hint = computeStaleHint({
      rootDir: tmpDir,
      touchedAbsPath: path.join(tmpDir, 'does-not-exist.ts'),
    });
    expect(hint).toBe(false);
  });
});
