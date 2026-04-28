import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';

import '../src/analysis/languages/typescript.js';
import '../src/analysis/languages/python.js';
import '../src/analysis/languages/go.js';
import '../src/analysis/languages/rust.js';
import '../src/analysis/languages/java.js';
import '../src/analysis/languages/csharp.js';
import '../src/analysis/languages/css.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-relations-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function write(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

interface Row {
  source_name: string;
  source_file: string;
  kind: string;
  target_name: string;
  target_id: number | null;
  target_resolved_name: string | null;
}

function readEdges(): Row[] {
  const dbPath = path.join(tmpRoot, '.nexus', 'index.db');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT
      ss.name AS source_name,
      sf.path AS source_file,
      r.kind AS kind,
      r.target_name AS target_name,
      r.target_id AS target_id,
      ts.name AS target_resolved_name
    FROM relation_edges r
    JOIN symbols ss ON r.source_id = ss.id
    JOIN files sf ON ss.file_id = sf.id
    LEFT JOIN symbols ts ON r.target_id = ts.id
    ORDER BY sf.path, r.line, r.target_name
  `).all() as Row[];
  db.close();
  return rows;
}

describe('relation_edges — same-file resolution (T6)', () => {
  it('persists extends_class with same-file target_id', () => {
    write('a.ts', 'export class A {}\nexport class B extends A {}\n');
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'B',
      kind: 'extends_class',
      target_name: 'A',
      target_resolved_name: 'A',
    });
    expect(rows[0].target_id).not.toBeNull();
  });

  it('leaves target_id NULL when target is not in same file', () => {
    write('a.ts', 'export class B extends Unknown {}\n');
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'B',
      kind: 'extends_class',
      target_name: 'Unknown',
    });
    expect(rows[0].target_id).toBeNull();
  });

  it('resolves implements within same file', () => {
    write('a.ts', 'interface IUser {}\nclass U implements IUser {}\n');
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'U',
      kind: 'implements',
      target_name: 'IUser',
      target_resolved_name: 'IUser',
    });
  });

  it('resolves extends_interface within same file', () => {
    write('a.ts', 'interface A {}\ninterface B extends A {}\n');
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'B',
      kind: 'extends_interface',
      target_name: 'A',
      target_resolved_name: 'A',
    });
  });

  it('handles a class extending one interface and implementing another', () => {
    write('a.ts',
      'class Base {}\n' +
      'interface IUser {}\n' +
      'class U extends Base implements IUser {}\n'
    );
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(2);
    const ext = rows.find(r => r.kind === 'extends_class')!;
    const impl = rows.find(r => r.kind === 'implements')!;
    expect(ext.target_resolved_name).toBe('Base');
    expect(impl.target_resolved_name).toBe('IUser');
  });

  it('does not persist relations from non-TS files', () => {
    write('a.py', 'class B(A): pass\n');
    runIndex(tmpRoot, true);
    expect(readEdges()).toHaveLength(0);
  });

  it('persists nothing for a class with no extends/implements', () => {
    write('a.ts', 'export class A {}\n');
    runIndex(tmpRoot, true);
    expect(readEdges()).toHaveLength(0);
  });

  it('CASCADE deletes relation rows when source file is removed', () => {
    write('a.ts', 'class A {}\nclass B extends A {}\n');
    runIndex(tmpRoot, true);
    expect(readEdges()).toHaveLength(1);

    fs.unlinkSync(path.join(tmpRoot, 'a.ts'));
    runIndex(tmpRoot);
    expect(readEdges()).toHaveLength(0);
  });
});
