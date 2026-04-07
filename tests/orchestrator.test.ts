import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runIndex } from '../src/index/orchestrator.js';
import { openDatabase, applySchema, initializeMeta, SCHEMA_VERSION, EXTRACTOR_VERSION } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';

// ── Test Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
  // Create .git dir so detectRoot finds it
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function readDb(): { store: NexusStore; db: ReturnType<typeof openDatabase> } {
  const dbPath = path.join(tmpDir, '.nexus', 'index.db');
  const db = openDatabase(dbPath);
  const store = new NexusStore(db);
  return { store, db };
}

function rmFile(relativePath: string): void {
  fs.unlinkSync(path.join(tmpDir, relativePath));
}

beforeEach(() => {
  tmpDir = createTmpProject();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Full Rebuild Tests ──────────────────────────────────────────────────

describe('full rebuild', () => {
  it('indexes a project with TypeScript files', () => {
    writeFile('src/utils.ts', `
export function add(a: number, b: number): number {
  return a + b;
}

export const VERSION = '1.0';
`);
    writeFile('src/types.ts', `
export interface User {
  id: string;
  name: string;
}

export type Result<T> = { ok: T } | { err: string };
`);

    const result = runIndex(tmpDir);

    expect(result.mode).toBe('full');
    expect(result.filesScanned).toBe(2);
    expect(result.filesIndexed).toBe(2);
    expect(result.filesErrored).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify DB state
    const { store, db } = readDb();
    try {
      const files = store.getAllFiles();
      expect(files).toHaveLength(2);

      const symbols = store.getSymbolsByName('add');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].kind).toBe('function');

      const userSymbols = store.getSymbolsByName('User');
      expect(userSymbols).toHaveLength(1);
      expect(userSymbols[0].kind).toBe('interface');

      // Check meta
      expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(store.getMeta('extractor_version')).toBe(String(EXTRACTOR_VERSION));
      expect(store.getMeta('last_indexed_at')).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('creates .nexus directory and index.db', () => {
    writeFile('index.ts', 'export const x = 1;');

    runIndex(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.nexus', 'index.db'))).toBe(true);
  });

  it('records index run history', () => {
    writeFile('app.ts', 'export const hello = "world";');

    runIndex(tmpDir);

    const { store, db } = readDb();
    try {
      const run = store.getLastIndexRun();
      expect(run).toBeDefined();
      expect(run!.mode).toBe('full');
      expect(run!.status).toBe('completed');
      expect(run!.files_scanned).toBe(1);
      expect(run!.files_indexed).toBe(1);
    } finally {
      db.close();
    }
  });

  it('extracts imports and exports as module edges', () => {
    writeFile('lib.ts', `
import { readFile } from 'node:fs/promises';

export function load(path: string) {
  return readFile(path, 'utf-8');
}

export default class Loader {}
`);

    runIndex(tmpDir);

    const { store, db } = readDb();
    try {
      const files = store.getAllFiles();
      const fileId = files[0].id;

      const imports = store.getImportsByFileId(fileId);
      expect(imports.length).toBeGreaterThanOrEqual(1);
      expect(imports.some(e => e.name === 'readFile')).toBe(true);

      const exports = store.getExportsByFileId(fileId);
      expect(exports.some(e => e.name === 'load')).toBe(true);
      expect(exports.some(e => e.is_default)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('stores occurrences', () => {
    writeFile('search.ts', `
function findUser(userId: string) {
  return database.query(userId);
}
`);

    runIndex(tmpDir);

    const { store, db } = readDb();
    try {
      const occs = store.getOccurrencesByName('userId');
      expect(occs.length).toBeGreaterThanOrEqual(1);
      expect(occs[0].confidence).toBe('heuristic');
      expect(occs[0].context).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('skips non-source files', () => {
    writeFile('readme.md', '# Hello');
    writeFile('data.json', '{}');
    writeFile('src/app.ts', 'export const x = 1;');

    const result = runIndex(tmpDir);

    expect(result.filesScanned).toBe(1); // only .ts
    expect(result.filesIndexed).toBe(1);
  });

  it('skips node_modules', () => {
    writeFile('node_modules/pkg/index.ts', 'export const x = 1;');
    writeFile('src/app.ts', 'export const y = 2;');

    const result = runIndex(tmpDir);

    expect(result.filesScanned).toBe(1);
    expect(result.filesIndexed).toBe(1);

    const { store, db } = readDb();
    try {
      const symbols = store.getSymbolsByName('x');
      expect(symbols).toHaveLength(0);
      const ySymbols = store.getSymbolsByName('y');
      expect(ySymbols).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

// ── Incremental Tests ───────────────────────────────────────────────────

describe('incremental rebuild', () => {
  it('detects added files', () => {
    writeFile('a.ts', 'export const a = 1;');
    runIndex(tmpDir);

    // Add a new file
    writeFile('b.ts', 'export const b = 2;');
    const result = runIndex(tmpDir);

    expect(result.mode).toBe('incremental');
    expect(result.filesIndexed).toBe(1); // only the new file

    const { store, db } = readDb();
    try {
      const files = store.getAllFiles();
      expect(files).toHaveLength(2);
      expect(store.getSymbolsByName('b')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('detects modified files', () => {
    writeFile('mod.ts', 'export const original = 1;');
    runIndex(tmpDir);

    // Modify the file
    // Need a small delay to ensure mtime changes
    const filePath = path.join(tmpDir, 'mod.ts');
    const stat = fs.statSync(filePath);
    fs.writeFileSync(filePath, 'export const modified = 2;');
    // Touch to ensure mtime differs
    fs.utimesSync(filePath, new Date(), new Date(stat.mtimeMs + 1000));

    const result = runIndex(tmpDir);

    expect(result.mode).toBe('incremental');

    const { store, db } = readDb();
    try {
      // Old symbol gone, new one present
      expect(store.getSymbolsByName('original')).toHaveLength(0);
      expect(store.getSymbolsByName('modified')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('detects deleted files', () => {
    writeFile('keep.ts', 'export const keep = 1;');
    writeFile('remove.ts', 'export const gone = 2;');
    runIndex(tmpDir);

    // Delete one file
    rmFile('remove.ts');
    const result = runIndex(tmpDir);

    expect(result.mode).toBe('incremental');

    const { store, db } = readDb();
    try {
      const files = store.getAllFiles();
      expect(files).toHaveLength(1);
      expect(files[0].path).toContain('keep');
      // Symbols from deleted file should be gone (CASCADE)
      expect(store.getSymbolsByName('gone')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('leaves unchanged files alone', () => {
    writeFile('stable.ts', 'export const stable = true;');
    writeFile('changing.ts', 'export const v1 = 1;');
    runIndex(tmpDir);

    // Only modify one file
    const changePath = path.join(tmpDir, 'changing.ts');
    const stat = fs.statSync(changePath);
    fs.writeFileSync(changePath, 'export const v2 = 2;');
    fs.utimesSync(changePath, new Date(), new Date(stat.mtimeMs + 1000));

    const result = runIndex(tmpDir);

    expect(result.mode).toBe('incremental');
    expect(result.filesIndexed).toBe(1); // only the changed file

    const { store, db } = readDb();
    try {
      // Stable file still has its symbols
      expect(store.getSymbolsByName('stable')).toHaveLength(1);
      // Changed file has new symbol
      expect(store.getSymbolsByName('v2')).toHaveLength(1);
      expect(store.getSymbolsByName('v1')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

// ── Invalidation Tests ──────────────────────────────────────────────────

describe('invalidation', () => {
  it('triggers full rebuild when config changes', () => {
    writeFile('app.ts', 'export const x = 1;');
    runIndex(tmpDir);

    // Write a .nexus.json config → changes config_hash
    writeFile('.nexus.json', JSON.stringify({ maxFileSize: 500_000 }));
    const result = runIndex(tmpDir);

    expect(result.mode).toBe('full');
  });

  it('triggers full rebuild on force', () => {
    writeFile('app.ts', 'export const x = 1;');
    runIndex(tmpDir);

    const result = runIndex(tmpDir, true);
    expect(result.mode).toBe('full');
  });

  it('triggers full rebuild when root_path changes', () => {
    writeFile('app.ts', 'export const x = 1;');
    runIndex(tmpDir);

    // Manually change root_path in meta to simulate a moved project
    const { store, db } = readDb();
    try {
      store.setMeta('root_path', '/some/other/path');
    } finally {
      db.close();
    }

    const result = runIndex(tmpDir);
    expect(result.mode).toBe('full');
  });

  it('does incremental when nothing invalidated', () => {
    writeFile('app.ts', 'export const x = 1;');
    runIndex(tmpDir);

    // Run again with no changes
    const result = runIndex(tmpDir);

    expect(result.mode).toBe('incremental');
    expect(result.filesIndexed).toBe(0);
    expect(result.filesScanned).toBe(1);
  });
});

// ── Atomicity Tests ─────────────────────────────────────────────────────

describe('two-phase atomicity', () => {
  it('readers see complete state after index', () => {
    writeFile('a.ts', 'export function alpha() {}');
    writeFile('b.ts', 'export function beta() {}');

    runIndex(tmpDir);

    const { store, db } = readDb();
    try {
      // All files should be present
      const files = store.getAllFiles();
      expect(files).toHaveLength(2);

      // All symbols should be present
      const alpha = store.getSymbolsByName('alpha');
      const beta = store.getSymbolsByName('beta');
      expect(alpha).toHaveLength(1);
      expect(beta).toHaveLength(1);

      // Each symbol should have a valid file_id that exists in files
      for (const sym of [...alpha, ...beta]) {
        const file = store.getFileById(sym.file_id);
        expect(file).toBeDefined();
      }
    } finally {
      db.close();
    }
  });

  it('full rebuild clears all old data', () => {
    writeFile('old.ts', 'export const oldSymbol = 1;');
    runIndex(tmpDir);

    // Remove old file, add new
    rmFile('old.ts');
    writeFile('new.ts', 'export const newSymbol = 2;');

    // Force full rebuild
    runIndex(tmpDir, true);

    const { store, db } = readDb();
    try {
      const files = store.getAllFiles();
      expect(files).toHaveLength(1);
      expect(files[0].path).toContain('new');

      expect(store.getSymbolsByName('oldSymbol')).toHaveLength(0);
      expect(store.getSymbolsByName('newSymbol')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('cascade deletes symbols when file is removed', () => {
    writeFile('target.ts', `
export function func1() {}
export function func2() {}
export const CONST1 = 1;
`);
    runIndex(tmpDir);

    const { store: store1, db: db1 } = readDb();
    let fileId: number;
    try {
      const files = store1.getAllFiles();
      fileId = files[0].id;
      const symbols = store1.getSymbolsByFileId(fileId);
      expect(symbols.length).toBeGreaterThanOrEqual(3);
    } finally {
      db1.close();
    }

    // Delete the file and reindex
    rmFile('target.ts');
    runIndex(tmpDir);

    const { store: store2, db: db2 } = readDb();
    try {
      // File row gone
      expect(store2.getFileById(fileId)).toBeUndefined();
      // Symbols gone (CASCADE)
      expect(store2.getSymbolsByFileId(fileId)).toHaveLength(0);
    } finally {
      db2.close();
    }
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty project (no source files)', () => {
    // Only .git dir exists, no source files
    const result = runIndex(tmpDir);

    expect(result.mode).toBe('full');
    expect(result.filesScanned).toBe(0);
    expect(result.filesIndexed).toBe(0);

    const { store, db } = readDb();
    try {
      expect(store.getAllFiles()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('handles files in nested directories', () => {
    writeFile('src/deep/nested/module.ts', 'export const deep = true;');
    writeFile('lib/utils/helpers.ts', 'export function helper() {}');

    const result = runIndex(tmpDir);

    expect(result.filesIndexed).toBe(2);

    const { store, db } = readDb();
    try {
      const files = store.getAllFiles();
      const paths = files.map(f => f.path);
      expect(paths.some(p => p.includes('deep/nested/module.ts'))).toBe(true);
      expect(paths.some(p => p.includes('utils/helpers.ts'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('handles multiple index runs correctly', () => {
    writeFile('app.ts', 'export const v1 = 1;');
    runIndex(tmpDir);
    runIndex(tmpDir); // second run, incremental, no changes
    runIndex(tmpDir); // third run

    const { store, db } = readDb();
    try {
      // File should still be there, only once
      const files = store.getAllFiles();
      expect(files).toHaveLength(1);

      // Symbols should not duplicate
      const symbols = store.getSymbolsByName('v1');
      expect(symbols).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
