/**
 * `nexus install` — write absolute-path hook entries (and optionally MCP server
 * registration) into Claude Code's settings.json. JSONC-aware via `jsonc-parser`
 * so user comments/formatting are preserved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, modify, applyEdits, type FormattingOptions } from 'jsonc-parser';
import { resolveRoot } from '../workspace/detector.js';

// ─── Path resolution ─────────────────────────────────────────────────

/** Absolute path to the running Node binary. */
function nodeBin(): string {
  return process.execPath;
}

/**
 * Absolute path to `dist/transports/<name>.js` for the installed package. We
 * resolve relative to this module's URL — works for both global npm installs
 * and `node dist/...` invocations.
 */
function distBin(name: 'cli' | 'hook-entry' | 'policy-entry'): string {
  // import.meta.url at runtime points at .../dist/transports/install.js
  // (we live next door to cli.js / hook-entry.js / policy-entry.js).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, `${name}.js`);
}

/**
 * Quote a path for use as a single argv element in a settings.json `command`
 * string. Wraps in double quotes and escapes embedded quotes; uses forward
 * slashes on all platforms (Node accepts them on Windows too).
 */
function quoteArg(p: string): string {
  const fwd = p.replace(/\\/g, '/');
  return `"${fwd.replace(/"/g, '\\"')}"`;
}

/** Compose a hook command string: `"<node>" "<dist>" <subcommand>`. */
function hookCommand(subcommand: 'pre' | 'post' | 'session-start'): string {
  return `${quoteArg(nodeBin())} ${quoteArg(distBin('hook-entry'))} ${subcommand}`;
}

// ─── Settings paths ──────────────────────────────────────────────────

export function userSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function projectSettingsPath(rootDir: string): string {
  return path.join(rootDir, '.claude', 'settings.json');
}

export function projectMcpJsonPath(rootDir: string): string {
  return path.join(rootDir, '.mcp.json');
}

// ─── Plan + apply ────────────────────────────────────────────────────

export interface InstallOptions {
  /** When true, install into the project's `.claude/settings.json` instead of the user-scope file. */
  project?: boolean;
  /** When true, also write/update the project root `.mcp.json` `nexus` entry. */
  mcp?: boolean;
  /** When true, bake `--root <resolved>` into the MCP `args`. Worktree-local installs only. */
  bakeRoot?: boolean;
  /** Override the install target root (defaults to `resolveRoot().startDir`). */
  rootOverride?: string;
}

export interface InstallPlan {
  settings: SettingsPlan;
  mcp?: McpPlan;
}

export interface SettingsPlan {
  filePath: string;
  beforeContent: string;     // '' if file did not exist
  afterContent: string;
  changes: ChangeSummary[];
}

export interface McpPlan {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  changes: ChangeSummary[];
}

export interface ChangeSummary {
  hook: 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'mcpServers.nexus';
  action: 'added' | 'updated' | 'unchanged';
  detail: string;
}

const FMT: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

const PRE_MATCHER = 'Grep|Glob|Agent|Read|Edit|Write|Bash';
const POST_MATCHER = 'Bash';

interface HookEntryGroup {
  matcher?: string;
  hooks: { type: 'command'; command: string }[];
}

interface SettingsShape {
  hooks?: {
    PreToolUse?: HookEntryGroup[];
    PostToolUse?: HookEntryGroup[];
    SessionStart?: HookEntryGroup[];
  };
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

function readSettings(filePath: string): { content: string; parsed: SettingsShape } {
  if (!fs.existsSync(filePath)) {
    return { content: '', parsed: {} };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  let parsed: SettingsShape = {};
  try {
    const obj = parse(content);
    if (obj && typeof obj === 'object') parsed = obj as SettingsShape;
  } catch {
    /* leave parsed empty; modify() still works on raw content */
  }
  return { content, parsed };
}

/**
 * For a given hook event, build the desired entry group list (existing groups
 * with our entry merged in, idempotent). Returns the merged list and a label
 * describing what changed.
 */
function planHookGroup(
  existing: HookEntryGroup[] | undefined,
  matcher: string | undefined,
  command: string,
): { merged: HookEntryGroup[]; change: ChangeSummary['action']; detail: string } {
  const groups = existing ? [...existing] : [];

  // Detect: any existing group whose hooks already contain our exact command
  // (regardless of matcher) → unchanged.
  const exactMatch = groups.some((g) =>
    (g.hooks ?? []).some((h) => h.command === command),
  );
  if (exactMatch) {
    return { merged: groups, change: 'unchanged', detail: 'already installed' };
  }

  // Detect: an existing group with the SAME matcher that has a Nexus-style
  // command (recognized as legacy) → update by APPENDING our hook to its hooks
  // array (don't overwrite — user may have other tools chained).
  const matcherIdx = groups.findIndex((g) => (g.matcher ?? undefined) === matcher);
  if (matcherIdx >= 0) {
    const current = groups[matcherIdx];
    groups[matcherIdx] = {
      ...current,
      hooks: [...(current.hooks ?? []), { type: 'command', command }],
    };
    return { merged: groups, change: 'updated', detail: `appended to existing matcher group` };
  }

  // No matching group → append a new one.
  groups.push({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command }],
  });
  return { merged: groups, change: 'added', detail: 'new group' };
}

function planSettings(opts: InstallOptions): SettingsPlan {
  const filePath = opts.project
    ? projectSettingsPath(opts.rootOverride ?? resolveRoot().startDir)
    : userSettingsPath();

  const { content: beforeContent } = readSettings(filePath);
  let after = beforeContent.length > 0 ? beforeContent : '{}';

  const parsedNow = (): SettingsShape => {
    try { return (parse(after) as SettingsShape) ?? {}; } catch { return {}; }
  };

  const changes: ChangeSummary[] = [];
  const apply = (
    eventName: 'PreToolUse' | 'PostToolUse' | 'SessionStart',
    matcher: string | undefined,
    command: string,
  ): void => {
    const settings = parsedNow();
    const existing = settings.hooks?.[eventName];
    const { merged, change, detail } = planHookGroup(existing, matcher, command);
    if (change !== 'unchanged') {
      const edits = modify(after, ['hooks', eventName], merged, { formattingOptions: FMT });
      after = applyEdits(after, edits);
    }
    changes.push({ hook: eventName, action: change, detail });
  };

  apply('PreToolUse', PRE_MATCHER, hookCommand('pre'));
  apply('PostToolUse', POST_MATCHER, hookCommand('post'));
  apply('SessionStart', undefined, hookCommand('session-start'));

  return { filePath, beforeContent, afterContent: after, changes };
}

function planMcp(opts: InstallOptions): McpPlan | undefined {
  if (!opts.mcp) return undefined;
  const root = opts.rootOverride ?? resolveRoot().startDir;
  const filePath = projectMcpJsonPath(root);

  const beforeContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  let after = beforeContent.length > 0 ? beforeContent : '{}';

  const desiredArgs = ['serve', ...(opts.bakeRoot ? ['--root', root] : [])];
  // Settings.json command field is a single shell-style string; .mcp.json is
  // a structured object so we set command + args separately. Always absolute.
  const desired = {
    command: nodeBin(),
    args: [distBin('cli'), ...desiredArgs],
  };

  // Detect existing entry equality.
  let existing: { command?: string; args?: string[] } | undefined;
  try {
    const parsed = parse(after) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    existing = parsed?.mcpServers?.nexus;
  } catch { /* ignore */ }

  const equal = existing
    && existing.command === desired.command
    && JSON.stringify(existing.args ?? []) === JSON.stringify(desired.args);

  if (equal) {
    return {
      filePath,
      beforeContent,
      afterContent: after,
      changes: [{ hook: 'mcpServers.nexus', action: 'unchanged', detail: 'already correct' }],
    };
  }

  const edits = modify(after, ['mcpServers', 'nexus'], desired, { formattingOptions: FMT });
  after = applyEdits(after, edits);

  return {
    filePath,
    beforeContent,
    afterContent: after,
    changes: [{
      hook: 'mcpServers.nexus',
      action: existing ? 'updated' : 'added',
      detail: opts.bakeRoot ? `with --root ${root}` : 'no --root',
    }],
  };
}

export function planInstall(opts: InstallOptions = {}): InstallPlan {
  const out: InstallPlan = { settings: planSettings(opts) };
  const mcp = planMcp(opts);
  if (mcp) out.mcp = mcp;
  return out;
}

/** Write the planned changes to disk, with backups. Returns the same plan. */
export function applyInstall(plan: InstallPlan): InstallPlan {
  writePlanned(plan.settings);
  if (plan.mcp) writePlanned(plan.mcp);
  return plan;
}

function writePlanned(p: SettingsPlan | McpPlan): void {
  if (p.afterContent === p.beforeContent) return;
  fs.mkdirSync(path.dirname(p.filePath), { recursive: true });

  if (p.beforeContent.length > 0) {
    const stamp = timestamp();
    const backup = `${p.filePath}.bak-${stamp}`;
    fs.writeFileSync(backup, p.beforeContent, 'utf-8');
  }
  fs.writeFileSync(p.filePath, p.afterContent, 'utf-8');
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── Uninstall ───────────────────────────────────────────────────────

/**
 * Plan removal of all hook entries we own (matched by their command path
 * containing `hook-entry.js`), and optionally the `mcpServers.nexus` entry.
 */
export function planUninstall(opts: InstallOptions = {}): InstallPlan {
  const filePath = opts.project
    ? projectSettingsPath(opts.rootOverride ?? resolveRoot().startDir)
    : userSettingsPath();
  const { content: beforeContent } = readSettings(filePath);
  if (beforeContent.length === 0) {
    return {
      settings: {
        filePath,
        beforeContent: '',
        afterContent: '',
        changes: [],
      },
    };
  }
  let after = beforeContent;
  const parsedNow = (): SettingsShape => {
    try { return (parse(after) as SettingsShape) ?? {}; } catch { return {}; }
  };
  const changes: ChangeSummary[] = [];

  const removeFromGroup = (
    eventName: 'PreToolUse' | 'PostToolUse' | 'SessionStart',
  ): void => {
    const groups = parsedNow().hooks?.[eventName];
    if (!groups) return;
    let touched = false;
    const remaining = groups
      .map((g) => {
        const before = g.hooks?.length ?? 0;
        const filteredHooks = (g.hooks ?? []).filter((h) => !isOwnedHookCommand(h.command));
        if (filteredHooks.length !== before) touched = true;
        return { ...g, hooks: filteredHooks };
      })
      .filter((g) => (g.hooks ?? []).length > 0);
    if (touched) {
      const edits = modify(after, ['hooks', eventName], remaining, { formattingOptions: FMT });
      after = applyEdits(after, edits);
      changes.push({ hook: eventName, action: 'updated', detail: 'removed Nexus entries' });
    } else {
      changes.push({ hook: eventName, action: 'unchanged', detail: 'no Nexus entries to remove' });
    }
  };
  removeFromGroup('PreToolUse');
  removeFromGroup('PostToolUse');
  removeFromGroup('SessionStart');

  return { settings: { filePath, beforeContent, afterContent: after, changes } };
}

function isOwnedHookCommand(cmd: string): boolean {
  const c = cmd.toLowerCase().replace(/\\/g, '/');
  return c.includes('hook-entry.js') || /\bnexus-hook\b/.test(c);
}
