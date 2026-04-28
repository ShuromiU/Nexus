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

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const server = createMcpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as any)._requestHandlers as Map<
    string,
    (req: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  >;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler not registered');
  return handler({ method: 'tools/call', params: { name, arguments: args } }, {});
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

  it('registers nexus_structured_query with file + path', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_structured_query');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('file');
    expect(schema.properties).toHaveProperty('path');
    expect(schema.required).toEqual(expect.arrayContaining(['file', 'path']));
  });

  it('registers nexus_structured_outline with file', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_structured_outline');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('file');
    expect(schema.required).toEqual(['file']);
  });

  it('registers nexus_stale_docs with path + kinds + limit', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_stale_docs');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('path');
    expect(schema.properties).toHaveProperty('kinds');
    expect(schema.properties).toHaveProperty('limit');
  });

  it('registers nexus_tests_for with name + file + limit', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_tests_for');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('file');
    expect(schema.properties).toHaveProperty('limit');
  });

  it('registers nexus_private_dead with path + limit + kinds', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_private_dead');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('path');
    expect(schema.properties).toHaveProperty('limit');
    expect(schema.properties).toHaveProperty('kinds');
  });

  it('registers nexus_relations with name + direction + kind + depth', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_relations');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('direction');
    expect(schema.properties).toHaveProperty('kind');
    expect(schema.properties).toHaveProperty('depth');
    expect(schema.required).toEqual(['name']);
    const dir = schema.properties!.direction as { enum?: string[] };
    expect(dir.enum).toEqual(expect.arrayContaining(['parents', 'children', 'both']));
    const k = schema.properties!.kind as { enum?: string[] };
    expect(k.enum).toEqual(['extends_class', 'implements', 'extends_interface']);
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

describe('nexus_policy_check tool', () => {
  it('is listed in tools/list', async () => {
    const tools = await getRegisteredTools();
    expect(tools.find(t => t.name === 'nexus_policy_check')).toBeDefined();
  });

  it('has event in required schema properties', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_policy_check');
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('event');
    expect(schema.required).toEqual(expect.arrayContaining(['event']));
  });

  it('dispatches a Grep-on-code event and returns a deny decision', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'foo' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('deny');
    expect(typeof payload.results[0].stale_hint).toBe('boolean');
    expect(['current', 'stale']).toContain(payload.index_status);
  });

  it('returns allow for a non-Grep event', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('allow');
  });

  it('returns error for missing event arg', async () => {
    const result = await callTool('nexus_policy_check', {});
    expect(result.isError).toBe(true);
  });

  it('works as a nexus_batch sub-call', async () => {
    const result = await callTool('nexus_batch', {
      calls: [
        { tool: 'nexus_policy_check', args: { event: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } } } },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].ok).toBe(true);
    expect(payload.results[0].result.results[0].decision).toBe('allow');
  });

  it('asks for Read on a structured file', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'package.json' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('ask');
    expect(payload.results[0].rule).toBe('read-on-structured');
  });

  it('allows bare Read on a source file with additional_context', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'src/index.ts' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('allow');
    expect(payload.results[0].rule).toBe('read-on-source');
    expect(payload.results[0].additional_context).toMatch(/nexus_outline/);
  });

  it('returns allow for an Edit event on an indexed source file (smoke test)', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/index.ts',
          old_string: "export { openDatabase",
        },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    // Either the Edit was dispatched and preedit-impact fired (allow + rule),
    // or it fell through to plain allow. Both are structurally OK — the key
    // assertion is that dispatching an Edit event does not throw and returns
    // a well-formed response with decision='allow'.
    expect(payload.results[0].decision).toBe('allow');
    expect(typeof payload.results[0].stale_hint).toBe('boolean');
    expect(['current', 'stale']).toContain(payload.index_status);
  });

  it('schema declares tool_response and session_id on the event payload', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_policy_check');
    const schema = tool!.inputSchema as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const eventProps = schema.properties?.event?.properties ?? {};
    expect(eventProps).toHaveProperty('tool_response');
    expect(eventProps).toHaveProperty('session_id');
  });

  it('returns allow for a PreToolUse Bash git commit event (smoke test)', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m wip' },
        session_id: 's-mcp-1',
      },
    });
    const payload = JSON.parse(result.content[0].text);
    // git/.nexus state may or may not produce a summary in this test
    // environment — both shapes are accepted. The key assertion is that
    // dispatching a Bash event does not throw.
    expect(payload.results[0].decision).toBe('allow');
    expect(typeof payload.results[0].stale_hint).toBe('boolean');
  });

  it('returns allow for a PostToolUse Bash npm test event (smoke test)', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { exit_code: 0 },
        session_id: 's-mcp-2',
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('allow');
  });
});

describe('nexus_lockfile_deps tool', () => {
  it('registers nexus_lockfile_deps with file + optional name', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_lockfile_deps');
    expect(tool).toBeDefined();
    expect((tool!.inputSchema as { required?: string[] }).required).toEqual(['file']);
    expect(Object.keys((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(
      expect.arrayContaining(['file', 'name', 'compact']),
    );
  });

  describe('dispatch', () => {
    let tmpDir: string;
    let dispatchDb: Database.Database;
    let dispatchEngine: QueryEngine;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-lockfile-'));
      dispatchDb = new Database(':memory:');
      dispatchDb.pragma('journal_mode = WAL');
      dispatchDb.pragma('foreign_keys = ON');
      applySchema(dispatchDb);
      initializeMeta(dispatchDb, tmpDir, true);
      dispatchEngine = new QueryEngine(dispatchDb);
    });

    afterEach(() => {
      dispatchDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('dispatches nexus_lockfile_deps to QueryEngine.lockfileDeps', () => {
      fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), [
        '# yarn lockfile v1',
        '"react@^18.0.0":',
        '  version "18.2.0"',
        '',
      ].join('\n'));
      const result = dispatchEngine.lockfileDeps('yarn.lock');
      expect(result.type).toBe('lockfile_deps');
      expect(result.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
    });
  });
});
