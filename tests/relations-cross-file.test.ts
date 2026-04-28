import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';

import '../src/analysis/languages/typescript.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rel-xfile-'));
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
  target_file: string | null;
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
      ts.name AS target_resolved_name,
      tf.path AS target_file
    FROM relation_edges r
    JOIN symbols ss ON r.source_id = ss.id
    JOIN files sf ON ss.file_id = sf.id
    LEFT JOIN symbols ts ON r.target_id = ts.id
    LEFT JOIN files tf ON ts.file_id = tf.id
    ORDER BY sf.path, r.line, r.target_name
  `).all() as Row[];
  db.close();
  return rows;
}

describe('relation_edges — cross-file resolution (T7)', () => {
  it('resolves extends across files via named import', () => {
    write('base.ts', 'export class Base {}\n');
    write('derived.ts', "import { Base } from './base';\nexport class B extends Base {}\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'B',
      kind: 'extends_class',
      target_name: 'Base',
      target_resolved_name: 'Base',
      target_file: 'base.ts',
    });
  });

  it('resolves implements across files', () => {
    write('iuser.ts', 'export interface IUser { id: string }\n');
    write('user.ts', "import { IUser } from './iuser';\nexport class U implements IUser { id = '' }\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'implements',
      target_resolved_name: 'IUser',
      target_file: 'iuser.ts',
    });
  });

  it('resolves extends_interface across files', () => {
    write('a.ts', 'export interface A {}\n');
    write('b.ts', "import { A } from './a';\nexport interface B extends A {}\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'extends_interface',
      target_resolved_name: 'A',
      target_file: 'a.ts',
    });
  });

  it('resolves through aliased import (Foo as Bar)', () => {
    write('foo.ts', 'export class Foo {}\n');
    write('bar.ts', "import { Foo as Bar } from './foo';\nexport class B extends Bar {}\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_name: 'Bar',
      target_resolved_name: 'Foo',
      target_file: 'foo.ts',
    });
  });

  it('resolves through namespace import (ns.Base)', () => {
    write('mod.ts', 'export class Base {}\n');
    write('main.ts', "import * as M from './mod';\nexport class B extends M.Base {}\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_name: 'M.Base',
      target_resolved_name: 'Base',
      target_file: 'mod.ts',
    });
  });

  it('leaves NULL when imported module is external (e.g. node_modules)', () => {
    // No corresponding file under tmpRoot — import won't resolve.
    write('a.ts', "import { Component } from 'react';\nexport class B extends Component {}\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBeNull();
  });

  it('leaves call expression target unresolved', () => {
    write('mixin.ts', 'export function Mixin<T>(x: T) { return class extends (x as any) {}; }\nexport class Base {}\n');
    write('a.ts', "import { Mixin, Base } from './mixin';\nexport class B extends Mixin(Base) {}\n");
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    expect(rows[0].target_name).toBe('Mixin(Base)');
    expect(rows[0].target_id).toBeNull();
  });

  it('prefers same-file resolution when name shadows an import', () => {
    write('shadow.ts',
      "import { Base } from './other';\n" +
      "class Base {}\n" +
      "class B extends Base {}\n"
    );
    write('other.ts', 'export class Base {}\n');
    runIndex(tmpRoot, true);
    const rows = readEdges();
    expect(rows).toHaveLength(1);
    // Same-file Base wins per resolution order (Phase 2 same-file > Phase 4 cross-file).
    expect(rows[0].target_file).toBe('shadow.ts');
  });
});
