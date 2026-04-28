import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, SCHEMA_VERSION, EXTRACTOR_VERSION } from '../src/db/schema.js';

describe('relation_edges schema (T1)', () => {
  it('SCHEMA_VERSION is at least 3 (B2 v1 bump)', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('EXTRACTOR_VERSION is at least 4 (B2 v1 bump)', () => {
    expect(EXTRACTOR_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('creates relation_edges table with expected columns', () => {
    const db = new Database(':memory:');
    applySchema(db);

    const cols = db.prepare("PRAGMA table_info('relation_edges')").all() as { name: string; type: string }[];
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual([
      'confidence', 'file_id', 'id', 'kind', 'line',
      'source_id', 'target_id', 'target_name',
    ]);
    db.close();
  });

  it('creates relation_edges indexes', () => {
    const db = new Database(':memory:');
    applySchema(db);

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_relation_edges_%'").all() as { name: string }[];
    const names = idx.map(r => r.name).sort();
    expect(names).toEqual([
      'idx_relation_edges_file',
      'idx_relation_edges_kind',
      'idx_relation_edges_source',
      'idx_relation_edges_target',
      'idx_relation_edges_target_name',
    ]);
    db.close();
  });

  it('CASCADE on file_id and source_id deletes relation rows when parent is deleted', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.pragma('foreign_keys = ON');

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO files (id, path, path_key, hash, mtime, size, language, status, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, 'a.ts', 'a.ts', 'h', 1, 1, 'typescript', 'indexed', now);
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, line, col)
                VALUES (?, ?, ?, ?, ?, ?)`).run(1, 1, 'Foo', 'class', 1, 0);
    db.prepare(`INSERT INTO relation_edges (file_id, source_id, kind, target_name, line)
                VALUES (?, ?, ?, ?, ?)`).run(1, 1, 'extends_class', 'Base', 1);

    expect((db.prepare('SELECT COUNT(*) AS n FROM relation_edges').get() as { n: number }).n).toBe(1);

    db.prepare('DELETE FROM files WHERE id = 1').run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM relation_edges').get() as { n: number }).n).toBe(0);

    db.close();
  });

  it('SET NULL on target_id when target symbol is deleted', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.pragma('foreign_keys = ON');

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO files (id, path, path_key, hash, mtime, size, language, status, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, 'a.ts', 'a.ts', 'h', 1, 1, 'typescript', 'indexed', now);
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, line, col) VALUES (1, 1, 'Base', 'class', 1, 0)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, line, col) VALUES (2, 1, 'Foo', 'class', 5, 0)`).run();
    db.prepare(`INSERT INTO relation_edges (file_id, source_id, kind, target_name, target_id, line)
                VALUES (?, ?, ?, ?, ?, ?)`).run(1, 2, 'extends_class', 'Base', 1, 5);

    db.prepare('DELETE FROM symbols WHERE id = 1').run();
    const row = db.prepare('SELECT target_id FROM relation_edges WHERE source_id = 2').get() as { target_id: number | null };
    expect(row.target_id).toBeNull();
    db.close();
  });

  it('schema version mismatch drops relation_edges along with other tables', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', '1')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO files (id, path, path_key, hash, mtime, size, language, status, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, 'a.ts', 'a.ts', 'h', 1, 1, 'typescript', 'indexed', now);
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, line, col) VALUES (1, 1, 'Foo', 'class', 1, 0)`).run();
    db.prepare(`INSERT INTO relation_edges (file_id, source_id, kind, target_name, line)
                VALUES (?, ?, ?, ?, ?)`).run(1, 1, 'extends_class', 'Base', 1);

    applySchema(db);

    expect((db.prepare('SELECT COUNT(*) AS n FROM relation_edges').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
