import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'jsonc-parser';
import {
  planInstall,
  applyInstall,
  planUninstall,
  userSettingsPath,
} from '../src/transports/install.js';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `nexus-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmrf(d: string): void {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('nexus install (project mode)', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('creates settings.json with all three hooks when none exist', () => {
    const plan = planInstall({ project: true, rootOverride: dir });
    expect(plan.settings.changes).toHaveLength(3);
    expect(plan.settings.changes.every((c) => c.action === 'added')).toBe(true);

    applyInstall(plan);

    const settingsPath = path.join(dir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const parsed = parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: { PreToolUse?: unknown[]; PostToolUse?: unknown[]; SessionStart?: unknown[] } };
    expect(parsed.hooks?.PreToolUse).toHaveLength(1);
    expect(parsed.hooks?.PostToolUse).toHaveLength(1);
    expect(parsed.hooks?.SessionStart).toHaveLength(1);
  });

  it('hook commands include absolute paths to node and hook-entry.js', () => {
    const plan = planInstall({ project: true, rootOverride: dir });
    applyInstall(plan);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const parsed = parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] } };
    const cmd = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    expect(cmd).toBeDefined();
    // Must contain absolute path to node and hook-entry.js, end with `pre`.
    expect(cmd).toMatch(/hook-entry\.js"?\s+pre$/);
    expect(cmd).toContain(process.execPath.replace(/\\/g, '/'));
    expect(path.isAbsolute(process.execPath)).toBe(true);
  });

  it('is idempotent — second run reports unchanged for all entries', () => {
    applyInstall(planInstall({ project: true, rootOverride: dir }));
    const second = planInstall({ project: true, rootOverride: dir });
    expect(second.settings.changes.every((c) => c.action === 'unchanged')).toBe(true);
    expect(second.settings.afterContent).toBe(second.settings.beforeContent);
  });

  it('preserves top-level comments and unrelated user fields in JSONC settings.json', () => {
    // Note: jsonc-parser's modify() preserves comments OUTSIDE the modified
    // path. Comments INSIDE an array we rewrite (e.g., between elements of
    // hooks.PreToolUse) are lost — that is a documented limitation. The
    // user's actual hook entries ARE preserved because we append, not replace.
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, [
      '{',
      '  // user comment that should survive',
      '  "model": "claude-opus-4-7",',
      '  "hooks": {',
      '    "PreToolUse": [',
      '      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo bash-hook" }] }',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n'));

    applyInstall(planInstall({ project: true, rootOverride: dir }));
    const after = fs.readFileSync(settingsPath, 'utf-8');
    expect(after).toContain('user comment that should survive');
    expect(after).toContain('"model": "claude-opus-4-7"');
    expect(after).toContain('echo bash-hook'); // user's own hook not removed
    expect(after).toContain('hook-entry.js'); // ours is added
  });

  it('writes a timestamped backup with no colons (Windows-safe)', () => {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{\n  "hooks": {}\n}\n');
    applyInstall(planInstall({ project: true, rootOverride: dir }));

    const claudeDir = path.dirname(settingsPath);
    const entries = fs.readdirSync(claudeDir);
    const backups = entries.filter((e) => e.startsWith('settings.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).not.toContain(':');
    expect(backups[0]).toMatch(/^settings\.json\.bak-\d{8}-\d{6}$/);
  });

  it('appends our hook to an existing matcher group rather than overwriting', () => {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Grep|Glob|Agent|Read|Edit|Write|Bash', hooks: [{ type: 'command', command: 'echo other' }] },
        ],
      },
    }, null, 2));
    applyInstall(planInstall({ project: true, rootOverride: dir }));
    const parsed = parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] } };
    const cmds = (parsed.hooks?.PreToolUse?.[0]?.hooks ?? []).map((h) => h.command);
    expect(cmds).toContain('echo other');
    expect(cmds.some((c) => c?.includes('hook-entry.js'))).toBe(true);
  });

  it('--mcp writes .mcp.json with absolute node + cli.js paths', () => {
    const plan = planInstall({ project: true, mcp: true, rootOverride: dir });
    applyInstall(plan);
    const mcpPath = path.join(dir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const parsed = parse(fs.readFileSync(mcpPath, 'utf-8')) as { mcpServers?: { nexus?: { command?: string; args?: string[] } } };
    const entry = parsed.mcpServers?.nexus;
    expect(entry).toBeDefined();
    expect(path.isAbsolute(entry!.command!)).toBe(true);
    expect(entry!.args).toEqual([
      expect.stringContaining('cli.js'),
      'serve',
    ]);
  });

  it('--bake-root adds --root <path> to MCP args', () => {
    const plan = planInstall({ project: true, mcp: true, bakeRoot: true, rootOverride: dir });
    applyInstall(plan);
    const mcpPath = path.join(dir, '.mcp.json');
    const parsed = parse(fs.readFileSync(mcpPath, 'utf-8')) as { mcpServers?: { nexus?: { args?: string[] } } };
    const args = parsed.mcpServers?.nexus?.args;
    expect(args).toBeDefined();
    expect(args).toEqual(expect.arrayContaining(['serve', '--root', dir]));
  });

  it('uninstall removes only Nexus-owned hook entries', () => {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other-tool' }] },
        ],
      },
    }, null, 2));
    applyInstall(planInstall({ project: true, rootOverride: dir }));
    applyInstall(planUninstall({ project: true, rootOverride: dir }));
    const parsed = parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] } };
    const cmds = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(cmds).toContain('echo other-tool');
    expect(cmds.every((c) => !c?.includes('hook-entry.js'))).toBe(true);
  });
});

describe('userSettingsPath()', () => {
  it('returns ~/.claude/settings.json on the current platform', () => {
    expect(userSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });
});
