import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { QueryEngine } from '../src/query/engine.js';
import { resetDocumentCache } from '../src/analysis/documents/cache.js';

let tmp: string;
let db: Database.Database;
let engine: QueryEngine;

beforeEach(() => {
  resetDocumentCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lockfile-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, tmp, true);
  engine = new QueryEngine(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  resetDocumentCache();
});

function writeTmp(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return name; // return relative name
}

describe('QueryEngine.lockfileDeps', () => {
  it('lists entries from yarn.lock', () => {
    writeTmp('yarn.lock', `# yarn lockfile v1
"react@^18.0.0":
  version "18.2.0"

"lodash@^4.17.0", "lodash@^4.17.21":
  version "4.17.21"
`);
    const r = engine.lockfileDeps('yarn.lock');
    expect(r.type).toBe('lockfile_deps');
    const [first] = r.results;
    expect(first.kind).toBe('yarn_lock');
    expect(first.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: 'lodash', version: '4.17.21' },
    ]));
  });

  it('lists entries from package-lock.json', () => {
    writeTmp('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/react': { version: '18.2.0' },
      },
    }));
    const r = engine.lockfileDeps('package-lock.json');
    expect(r.results[0].kind).toBe('package_lock');
    expect(r.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('lists entries from pnpm-lock.yaml', () => {
    writeTmp('pnpm-lock.yaml', `lockfileVersion: '9.0'
packages:
  /react@18.2.0:
    resolution: { integrity: sha512-foo }
`);
    const r = engine.lockfileDeps('pnpm-lock.yaml');
    expect(r.results[0].kind).toBe('pnpm_lock');
    expect(r.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('lists entries from Cargo.lock', () => {
    writeTmp('Cargo.lock', `[[package]]
name = "serde"
version = "1.0.195"
`);
    const r = engine.lockfileDeps('Cargo.lock');
    expect(r.results[0].kind).toBe('cargo_lock');
    expect(r.results[0].entries).toEqual([{ name: 'serde', version: '1.0.195' }]);
  });

  it('filters by name when provided', () => {
    writeTmp('yarn.lock', `# yarn lockfile v1
"react@^18.0.0":
  version "18.2.0"

"lodash@^4.17.0":
  version "4.17.21"
`);
    const r = engine.lockfileDeps('yarn.lock', 'react');
    expect(r.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('returns error when file is not a lockfile kind', () => {
    writeTmp('README.md', '# hi\n');
    const r = engine.lockfileDeps('README.md');
    expect(r.results[0].error).toBe('not a lockfile');
    expect(r.results[0].entries).toEqual([]);
  });

  it('surfaces file_too_large with limit + actual', () => {
    writeTmp('yarn.lock', 'x'.repeat(21 * 1024 * 1024));
    const r = engine.lockfileDeps('yarn.lock');
    expect(r.results[0].error).toBe('file_too_large');
    expect(r.results[0].limit).toBe(20 * 1024 * 1024);
    expect(typeof r.results[0].actual).toBe('number');
  });

  it('returns error when file does not exist', () => {
    const r = engine.lockfileDeps('yarn.lock');
    expect(typeof r.results[0].error).toBe('string');
    expect(r.results[0].entries).toEqual([]);
  });
});
