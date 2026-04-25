import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildDoctorReport, formatDoctorReport } from '../src/transports/doctor.js';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `nexus-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmrf(d: string): void {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

function initRepo(dir: string): void {
  const opts = { cwd: dir, encoding: 'utf-8' as const, windowsHide: true };
  spawnSync('git', ['init', '-q', '-b', 'main'], opts);
  spawnSync('git', ['config', 'user.email', 'test@nexus.local'], opts);
  spawnSync('git', ['config', 'user.name', 'Nexus Test'], opts);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], opts);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], opts);
  spawnSync('git', ['commit', '-q', '-m', 'init'], opts);
}

function gitOk(dir: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
}

function writeIndexMeta(dbPath: string, entries: Record<string, string>): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const stmt = db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(entries)) stmt.run(k, v);
  db.close();
}

describe('nexus doctor', () => {
  let dir: string;
  let savedRoot: string | undefined;
  let savedClaude: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = tmpDir();
    savedRoot = process.env.NEXUS_ROOT;
    savedClaude = process.env.CLAUDE_PROJECT_DIR;
    savedHome = process.env.HOME;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.NEXUS_ROOT;
    else process.env.NEXUS_ROOT = savedRoot;
    if (savedClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaude;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmrf(dir);
  });

  it('reports standalone fs_mode for an empty dir', () => {
    process.env.NEXUS_ROOT = dir;
    const r = buildDoctorReport();
    expect(r.workspace.fs_mode).toBe('standalone');
    expect(r.workspace.root).toBe(dir);
    expect(r.resolvedRoot.source).toBe('env-nexus');
  });

  it('reports main fs_mode for a real git repo', () => {
    initRepo(dir);
    process.env.NEXUS_ROOT = dir;
    const r = buildDoctorReport();
    expect(r.workspace.fs_mode).toBe('main');
    expect(r.workspace.gitDir).toBe(path.join(dir, '.git'));
    expect(r.index?.exists).toBe(false); // no index built yet
    expect(r.overlay).toBeNull();
  });

  it('reports worktree fs_mode and includes overlay placeholder', () => {
    initRepo(dir);
    const wt = path.join(dir, 'wt');
    gitOk(dir, ['worktree', 'add', wt, '-b', 'feat']);
    process.env.NEXUS_ROOT = wt;
    const r = buildDoctorReport();
    expect(r.workspace.fs_mode).toBe('worktree');
    if (r.workspace.fs_mode === 'worktree') {
      expect(fs.realpathSync(r.workspace.parentRoot!)).toBe(fs.realpathSync(dir));
      expect(r.workspace.overlayPath).toBe(path.join(wt, '.nexus', 'overlay.db'));
      expect(r.workspace.baseIndexPath).toBe(path.join(dir, '.nexus', 'index.db'));
    }
    expect(r.overlay).not.toBeNull();
    expect(r.overlay!.exists).toBe(false);
  });

  it('reads index meta when present (schema, git_head, clean_at_index_time, index_mode)', () => {
    initRepo(dir);
    process.env.NEXUS_ROOT = dir;
    const dbPath = path.join(dir, '.nexus', 'index.db');
    writeIndexMeta(dbPath, {
      schema_version: '2',
      extractor_version: '3',
      root_path: dir,
      git_head: 'abc123def456abc123def456abc123def456abc1',
      clean_at_index_time: 'true',
      index_mode: 'full',
      last_indexed_at: '2026-04-25T18:00:00.000Z',
    });
    const r = buildDoctorReport();
    expect(r.index?.exists).toBe(true);
    expect(r.index?.schemaVersion).toBe(2);
    expect(r.index?.extractorVersion).toBe(3);
    expect(r.index?.gitHead).toBe('abc123def456abc123def456abc123def456abc1');
    expect(r.index?.cleanAtIndexTime).toBe(true);
    expect(r.index?.indexMode).toBe('full');
  });

  it('classifies hook commands by command path', () => {
    process.env.NEXUS_ROOT = dir;
    process.env.HOME = dir; // makes os.homedir() resolve into our tmp on linux/mac
    // Note: on Windows, os.homedir() reads from USERPROFILE. We can't safely
    // override that mid-test, so we write to the real user-scope path is too
    // invasive. Instead, we exercise the project layer (nearer to fs).
    const projectClaudeDir = path.join(dir, '.claude');
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(path.join(projectClaudeDir, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Grep', hooks: [{ type: 'command', command: 'nexus-hook pre' }] },
        ],
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/nexus-post.sh' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: '"C:/node.exe" "C:/dist/transports/hook-entry.js" session-start' }] },
        ],
      },
    }, null, 2));

    const r = buildDoctorReport();
    expect(r.hooks.project.exists).toBe(true);
    expect(r.hooks.project.preToolUse[0].classification).toBe('nexus-hook');
    expect(r.hooks.project.postToolUse[0].classification).toBe('legacy-bash');
    expect(r.hooks.project.sessionStart[0].classification).toBe('nexus-hook');
  });

  it('reads project .mcp.json and flags absolute vs relative command', () => {
    process.env.NEXUS_ROOT = dir;
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        nexus: { command: 'C:/node.exe', args: ['C:/dist/transports/cli.js', 'serve', '--root', '/baked/root'] },
      },
    }));
    const r = buildDoctorReport();
    expect(r.mcp.projectMcpJson?.exists).toBe(true);
    expect(r.mcp.projectMcpJson?.nexusEntry?.commandIsAbsolute).toBe(true);
    expect(r.mcp.projectMcpJson?.nexusEntry?.bakedRoot).toBe('/baked/root');
  });

  it('reads telemetry totals when telemetry.db exists', () => {
    process.env.NEXUS_ROOT = dir;
    const tdb = path.join(dir, '.nexus', 'telemetry.db');
    fs.mkdirSync(path.dirname(tdb), { recursive: true });
    const db = new Database(tdb);
    db.exec(`CREATE TABLE events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      session_id TEXT, hook_event TEXT NOT NULL, tool_name TEXT,
      rule TEXT, decision TEXT, latency_us INTEGER, input_hash TEXT,
      file_path TEXT, payload_json TEXT
    )`);
    const ins = db.prepare(`INSERT INTO events(ts_ms, hook_event, decision) VALUES (?, ?, ?)`);
    const now = Date.now();
    ins.run(now, 'PreToolUse', 'allow');
    ins.run(now, 'PreToolUse', 'allow');
    ins.run(now, 'PreToolUse', 'deny');
    ins.run(now, 'PreToolUse', 'ask');
    db.close();

    const r = buildDoctorReport();
    expect(r.telemetry?.enabled).toBe(true);
    expect(r.telemetry?.totals).toEqual({ allow: 2, ask: 1, deny: 1, noop: 0 });
    expect(r.telemetry?.recentHourCounts?.allow).toBe(2);
  });

  it('formatDoctorReport renders headers and key facts', () => {
    initRepo(dir);
    process.env.NEXUS_ROOT = dir;
    const r = buildDoctorReport();
    const text = formatDoctorReport(r);
    expect(text).toContain('Nexus doctor');
    expect(text).toContain('▸ Workspace');
    expect(text).toContain('fs_mode: main');
    expect(text).toContain('▸ Resolved root');
    expect(text).toContain('source:    env-nexus');
    expect(text).toContain('▸ Parent index');
    expect(text).toContain('▸ MCP');
    expect(text).toContain('▸ Hooks');
    expect(text).toContain('▸ Binaries');
  });
});
