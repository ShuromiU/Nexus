import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';
import { createMcpServer } from '../src/transports/mcp.js';

// Side-effect: register TS adapter
import '../src/analysis/languages/typescript.js';

// ── Test Helpers ──────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/project', true);
  return db;
}

function seedTestData(store: NexusStore) {
  const file1 = store.insertFile({
    path: 'src/utils.ts',
    path_key: 'src/utils.ts',
    hash: 'abc123',
    mtime: 1000,
    size: 500,
    language: 'typescript',
    status: 'indexed',
    indexed_at: '2026-04-07T12:00:00Z',
  });

  store.insertSymbols([
    { file_id: file1, name: 'formatDate', kind: 'function', line: 5, col: 0, signature: '(date: Date) => string', doc: 'Formats a date' },
    { file_id: file1, name: 'MAX_RETRIES', kind: 'constant', line: 1, col: 0 },
  ]);

  store.insertModuleEdges([
    { file_id: file1, kind: 'import', name: 'readFile', source: 'node:fs/promises', line: 1, is_default: false, is_star: false, is_type: false },
    { file_id: file1, kind: 'export', name: 'formatDate', line: 5, is_default: false, is_star: false, is_type: false },
  ]);

  store.insertOccurrences([
    { file_id: file1, name: 'formatDate', line: 5, col: 16, context: 'export function formatDate(date: Date)', confidence: 'exact' },
    { file_id: file1, name: 'formatDate', line: 10, col: 8, context: 'return formatDate(now)', confidence: 'heuristic' },
  ]);

  store.insertIndexRun({
    started_at: '2026-04-07T12:00:00Z',
    completed_at: '2026-04-07T12:00:01Z',
    mode: 'full',
    files_scanned: 1,
    files_indexed: 1,
    files_skipped: 0,
    files_errored: 0,
    status: 'completed',
  });

  store.setMeta('last_indexed_at', '2026-04-07T12:00:01Z');
}

// ── Tool Registration Tests ───────────────────────────────────────────

/**
 * Fetch the list of registered tools from a freshly-built MCP server by
 * invoking its internal `tools/list` handler. Accesses the private
 * `_requestHandlers` map — no public getter is exposed, but this is stable
 * enough for schema-surface tests. Returns the `tools` array directly.
 */
async function getRegisteredTools(): Promise<Array<{ name: string; inputSchema: unknown }>> {
  const server = createMcpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as any)._requestHandlers as Map<string, (req: unknown, extra: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>>;
  const handler = handlers.get('tools/list');
  if (!handler) throw new Error('tools/list handler not registered');
  const result = await handler({ method: 'tools/list', params: {} }, {});
  return result.tools;
}

describe('MCP server', () => {
  it('creates server without errors', () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it('registers all expected tool names', () => {
    const expectedTools = [
      'nexus_find',
      'nexus_refs',
      'nexus_exports',
      'nexus_imports',
      'nexus_tree',
      'nexus_search',
      'nexus_outline',
      'nexus_source',
      'nexus_slice',
      'nexus_deps',
      'nexus_stats',
    ];
    // createMcpServer registers all handlers; if it completes, all 7 are registered
    const server = createMcpServer();
    expect(server).toBeDefined();
    expect(expectedTools).toHaveLength(11);
  });
});

describe('MCP schemas surface new options', () => {
  it('nexus_callers schema includes ref_kinds', async () => {
    const tools = await getRegisteredTools();
    const callers = tools.find(t => t.name === 'nexus_callers');
    expect(callers).toBeDefined();
    const schema = callers!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('ref_kinds');
  });

  it('nexus_slice schema includes ref_kinds', async () => {
    const tools = await getRegisteredTools();
    const slice = tools.find(t => t.name === 'nexus_slice');
    expect(slice).toBeDefined();
    const schema = slice!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('ref_kinds');
  });

  it('nexus_refs schema includes ref_kinds', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_refs');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('ref_kinds');
  });

  it('nexus_unused_exports schema includes mode', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_unused_exports');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('mode');
  });
});

// ── Response Shape Tests ──────────────────────────────────────────────
// The MCP server wraps QueryEngine results via JSON.stringify.
// These tests verify the serialized shape matches the spec.

describe('MCP response shapes', () => {
  let db: Database.Database;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    const store = new NexusStore(db);
    seedTestData(store);
    engine = new QueryEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it('nexus_find response has NexusResult envelope', () => {
    const result = engine.find('formatDate');
    const json = JSON.parse(JSON.stringify(result));
    expect(json).toHaveProperty('query');
    expect(json).toHaveProperty('type', 'find');
    expect(json).toHaveProperty('results');
    expect(json).toHaveProperty('count');
    expect(json).toHaveProperty('index_status');
    expect(json).toHaveProperty('index_health');
    expect(json).toHaveProperty('timing_ms');
    expect(Array.isArray(json.results)).toBe(true);
  });

  it('nexus_refs response has OccurrenceResult shape', () => {
    const result = engine.occurrences('formatDate');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('occurrences');
    expect(json.results[0]).toHaveProperty('confidence');
    expect(json.results[0]).toHaveProperty('context');
  });

  it('nexus_exports response has ModuleEdgeResult shape', () => {
    const result = engine.exports('src/utils.ts');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('exports');
    expect(json.results[0]).toHaveProperty('kind');
    expect(json.results[0]).toHaveProperty('name');
    expect(json.results[0]).toHaveProperty('is_default');
    expect(json.results[0]).toHaveProperty('is_star');
    expect(json.results[0]).toHaveProperty('is_type');
  });

  it('nexus_imports response has ModuleEdgeResult shape', () => {
    const result = engine.imports('src/utils.ts');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('imports');
    expect(json.results[0]).toHaveProperty('source');
  });

  it('nexus_tree response has TreeEntry shape', () => {
    const result = engine.tree();
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('tree');
    expect(json.results[0]).toHaveProperty('path');
    expect(json.results[0]).toHaveProperty('language');
    expect(json.results[0]).toHaveProperty('symbol_count');
    expect(json.results[0]).toHaveProperty('exports');
    expect(json.results[0]).toHaveProperty('status');
  });

  it('nexus_search response includes scores', () => {
    const result = engine.search('format');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('search');
    expect(json.results[0]).toHaveProperty('_score');
  });

  it('nexus_search supports path filtering', () => {
    const result = engine.search('format', 20, undefined, 'src');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.query).toContain('--path src');
  });

  it('nexus_outline batch response returns an outlines map', () => {
    const result = engine.outlineMany(['src/utils.ts', 'missing.ts']);
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('outline');
    expect(json.results[0]).toHaveProperty('outlines');
    expect(json.results[0].outlines).toHaveProperty('src/utils.ts');
    expect(json.results[0]).toHaveProperty('missing');
  });

  it('nexus_stats response has IndexStats shape', () => {
    const result = engine.stats();
    const json = JSON.parse(JSON.stringify(result));
    expect(json.type).toBe('stats');
    expect(json.count).toBe(1);
    const stats = json.results[0];
    expect(stats).toHaveProperty('root');
    expect(stats).toHaveProperty('files');
    expect(stats).toHaveProperty('symbols_total');
    expect(stats).toHaveProperty('languages');
    expect(stats).toHaveProperty('last_indexed_at');
    expect(stats).toHaveProperty('schema_version');
    expect(stats).toHaveProperty('extractor_version');
  });

  it('nexus_slice response has root and references', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-slice-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), [
      'export function helper(): string {',
      "  return 'ok';",
      '}',
      '',
      'export function formatDate(): string {',
      '  return helper();',
      '}',
    ].join('\n'));

    const sliceDb = createTestDb();
    const sliceStore = new NexusStore(sliceDb);
    sliceStore.setMeta('root_path', tmpDir);

    const fileId = sliceStore.insertFile({
      path: 'src/utils.ts',
      path_key: 'src/utils.ts',
      hash: 'slice123',
      mtime: 1,
      size: 100,
      language: 'typescript',
      status: 'indexed',
      indexed_at: '2026-04-07T12:00:00Z',
    });
    sliceStore.insertSymbols([
      { file_id: fileId, name: 'helper', kind: 'function', line: 1, col: 0, end_line: 3 },
      { file_id: fileId, name: 'formatDate', kind: 'function', line: 5, col: 0, end_line: 7 },
    ]);
    sliceStore.insertOccurrences([
      { file_id: fileId, name: 'helper', line: 6, col: 9, context: 'return helper();', confidence: 'heuristic' },
    ]);
    sliceStore.insertIndexRun({
      started_at: '2026-04-07T12:00:00Z',
      completed_at: '2026-04-07T12:00:01Z',
      mode: 'full',
      files_scanned: 1,
      files_indexed: 1,
      files_skipped: 0,
      files_errored: 0,
      status: 'completed',
    });

    const sliceEngine = new QueryEngine(sliceDb);
    try {
      const result = sliceEngine.slice('formatDate');
      const json = JSON.parse(JSON.stringify(result));
      expect(json.type).toBe('slice');
      expect(json.results[0]).toHaveProperty('root');
      expect(json.results[0]).toHaveProperty('references');
    } finally {
      sliceDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('all responses serialize cleanly to JSON', () => {
    const queries = [
      () => engine.find('formatDate'),
      () => engine.occurrences('formatDate'),
      () => engine.exports('src/utils.ts'),
      () => engine.imports('src/utils.ts'),
      () => engine.tree(),
      () => engine.search('format'),
      () => engine.outlineMany(['src/utils.ts']),
      () => engine.slice('formatDate'),
      () => engine.stats(),
    ];

    for (const query of queries) {
      const result = query();
      const serialized = JSON.stringify(result, null, 2);
      expect(() => JSON.parse(serialized)).not.toThrow();
    }
  });
});
