import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

let tmpRoot: string;
const repoRoot = path.resolve(__dirname, '..');
const entryBin = path.join(repoRoot, 'dist', 'transports', 'policy-entry.js');
const cliBin = path.join(repoRoot, 'dist', 'transports', 'cli.js');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-int-tel-'));
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{"name":"x"}');
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runEntry(payload: object): void {
  execFileSync(process.execPath, [entryBin], {
    input: JSON.stringify(payload), encoding: 'utf-8',
  });
}

function runStatsJson(): { rules: Record<string, { asks?: number; overrides?: number }> } {
  const out = execFileSync(process.execPath, [cliBin, 'telemetry', 'stats', '--json'], {
    cwd: tmpRoot, encoding: 'utf-8',
  });
  return JSON.parse(out);
}

describe('telemetry override correlation end-to-end', () => {
  it('Pre ask + matching Post → counted as override', () => {
    const payload = (hook: string) => ({
      hook_event_name: hook,
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-OV',
      cwd: tmpRoot,
    });
    runEntry(payload('PreToolUse'));
    runEntry(payload('PostToolUse'));
    const stats = runStatsJson();
    expect(stats.rules['read-on-structured']?.asks).toBe(1);
    expect(stats.rules['read-on-structured']?.overrides).toBe(1);
  });

  it('Pre ask without Post → not overridden', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-NO',
      cwd: tmpRoot,
    });
    const stats = runStatsJson();
    expect(stats.rules['read-on-structured']?.asks).toBe(1);
    expect(stats.rules['read-on-structured']?.overrides).toBe(0);
  });

  it('Pre/Post in different sessions → not overridden', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-A',
      cwd: tmpRoot,
    });
    runEntry({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-B',
      cwd: tmpRoot,
    });
    const stats = runStatsJson();
    expect(stats.rules['read-on-structured']?.asks).toBe(1);
    expect(stats.rules['read-on-structured']?.overrides).toBe(0);
  });
});
