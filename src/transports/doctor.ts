import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  detectWorkspace,
  resolveRoot,
  gitHead,
  type WorkspaceInfo,
} from '../workspace/detector.js';

// ─── Report shape (also the JSON output) ─────────────────────────────

export interface DoctorReport {
  workspace: {
    fs_mode: 'standalone' | 'main' | 'worktree';
    root: string;
    sourceRoot: string;
    parentRoot?: string;
    gitDir?: string;
    commonDir?: string;
    baseIndexPath?: string;
    overlayPath?: string;
  };
  resolvedRoot: {
    source: 'arg' | 'env-nexus' | 'env-claude' | 'mcp-roots' | 'cwd';
    startDir: string;
    env: {
      NEXUS_ROOT: string | null;
      CLAUDE_PROJECT_DIR: string | null;
      cwd: string;
    };
  };
  index: IndexHealth | null;
  overlay: IndexHealth | null;
  mcp: McpReport;
  hooks: HooksReport;
  binaries: BinariesReport;
  telemetry: TelemetryReport | null;
}

export interface IndexHealth {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  schemaVersion?: number;
  extractorVersion?: number;
  rootPath?: string;
  gitHead?: string;
  cleanAtIndexTime?: boolean;
  indexMode?: string;
  degradedReason?: string;
  parentGitHead?: string;
  parentIndexPath?: string;
  builtAt?: string;
  lastIndexedAt?: string;
}

export interface McpReport {
  projectMcpJson: { path: string; exists: boolean; nexusEntry?: McpEntry } | null;
  liveBinding?: { commandIsAbsolute: boolean; bakedRoot: string | null };
}

export interface McpEntry {
  command: string;
  args: string[];
  commandIsAbsolute: boolean;
  bakedRoot: string | null;
}

export interface HooksReport {
  user: HooksLayer;
  project: HooksLayer;
}

export interface HooksLayer {
  path: string;
  exists: boolean;
  preToolUse: HookSummary[];
  postToolUse: HookSummary[];
  sessionStart: HookSummary[];
}

export interface HookSummary {
  matcher?: string;
  command: string;
  classification: 'nexus-hook' | 'nexus-policy-check' | 'legacy-bash' | 'unknown';
}

export interface BinariesReport {
  nexus: BinaryInfo | null;
  nexusHook: BinaryInfo | null;
  nexusPolicyCheck: BinaryInfo | null;
}

export interface BinaryInfo {
  path: string;
  version?: string;
}

export interface TelemetryReport {
  path: string;
  enabled: boolean;
  totals?: {
    allow: number;
    ask: number;
    deny: number;
    noop: number;
  };
  recentHourCounts?: {
    allow: number;
    ask: number;
    deny: number;
  };
}

// ─── Builder ──────────────────────────────────────────────────────────

export function buildDoctorReport(): DoctorReport {
  const resolved = resolveRoot();
  const info = detectWorkspace(resolved.startDir);

  const report: DoctorReport = {
    workspace: workspaceSection(info),
    resolvedRoot: {
      source: resolved.source,
      startDir: resolved.startDir,
      env: {
        NEXUS_ROOT: process.env.NEXUS_ROOT ?? null,
        CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
        cwd: process.cwd(),
      },
    },
    index: indexSection(info),
    overlay: overlaySection(info),
    mcp: mcpSection(info),
    hooks: hooksSection(info),
    binaries: binariesSection(),
    telemetry: telemetrySection(info),
  };
  return report;
}

function workspaceSection(info: WorkspaceInfo): DoctorReport['workspace'] {
  if (info.mode === 'standalone') {
    return { fs_mode: 'standalone', root: info.root, sourceRoot: info.sourceRoot };
  }
  if (info.mode === 'main') {
    return { fs_mode: 'main', root: info.root, sourceRoot: info.sourceRoot, gitDir: info.gitDir };
  }
  return {
    fs_mode: 'worktree',
    root: info.root,
    sourceRoot: info.sourceRoot,
    parentRoot: info.parentRoot,
    gitDir: info.gitDir,
    commonDir: info.commonDir,
    baseIndexPath: info.baseIndexPath,
    overlayPath: info.overlayPath,
  };
}

function indexSection(info: WorkspaceInfo): IndexHealth | null {
  const dbPath = info.mode === 'worktree'
    ? info.baseIndexPath
    : path.join(info.root, '.nexus', 'index.db');
  return readIndexHealth(dbPath);
}

function overlaySection(info: WorkspaceInfo): IndexHealth | null {
  if (info.mode !== 'worktree') return null;
  return readIndexHealth(info.overlayPath);
}

function readIndexHealth(dbPath: string): IndexHealth {
  const exists = fs.existsSync(dbPath);
  if (!exists) return { path: dbPath, exists: false };

  let sizeBytes: number | undefined;
  try { sizeBytes = fs.statSync(dbPath).size; } catch { /* ignore */ }

  const out: IndexHealth = { path: dbPath, exists: true, sizeBytes };
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = new Map(rows.map((r) => [r.key, r.value]));

    const schema = meta.get('schema_version');
    if (schema) out.schemaVersion = parseInt(schema, 10);
    const extractor = meta.get('extractor_version');
    if (extractor) out.extractorVersion = parseInt(extractor, 10);
    if (meta.has('root_path')) out.rootPath = meta.get('root_path');
    if (meta.has('git_head')) out.gitHead = meta.get('git_head');
    if (meta.has('clean_at_index_time')) {
      out.cleanAtIndexTime = meta.get('clean_at_index_time') === 'true';
    }
    if (meta.has('index_mode')) out.indexMode = meta.get('index_mode');
    if (meta.has('degraded_reason')) out.degradedReason = meta.get('degraded_reason');
    if (meta.has('parent_git_head')) out.parentGitHead = meta.get('parent_git_head');
    if (meta.has('parent_index_path')) out.parentIndexPath = meta.get('parent_index_path');
    if (meta.has('built_at')) out.builtAt = meta.get('built_at');
    if (meta.has('last_indexed_at')) out.lastIndexedAt = meta.get('last_indexed_at');
  } catch {
    // Unreadable — just report what we have.
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return out;
}

function mcpSection(info: WorkspaceInfo): McpReport {
  const mcpPath = path.join(info.root, '.mcp.json');
  const exists = fs.existsSync(mcpPath);
  if (!exists) return { projectMcpJson: { path: mcpPath, exists: false } };

  try {
    const raw = fs.readFileSync(mcpPath, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    const nexus = parsed.mcpServers?.nexus;
    if (!nexus) {
      return { projectMcpJson: { path: mcpPath, exists: true } };
    }
    const cmd = nexus.command ?? '';
    const args = nexus.args ?? [];
    const rootIdx = args.findIndex((a) => a === '--root');
    const bakedRoot = rootIdx >= 0 && rootIdx + 1 < args.length ? args[rootIdx + 1] : null;
    return {
      projectMcpJson: {
        path: mcpPath,
        exists: true,
        nexusEntry: {
          command: cmd,
          args,
          commandIsAbsolute: path.isAbsolute(cmd),
          bakedRoot,
        },
      },
    };
  } catch {
    return { projectMcpJson: { path: mcpPath, exists: true } };
  }
}

function hooksSection(info: WorkspaceInfo): HooksReport {
  const userPath = path.join(os.homedir(), '.claude', 'settings.json');
  const projectPath = path.join(info.root, '.claude', 'settings.json');
  return {
    user: readHooksLayer(userPath),
    project: readHooksLayer(projectPath),
  };
}

function readHooksLayer(filePath: string): HooksLayer {
  const empty: HooksLayer = {
    path: filePath,
    exists: false,
    preToolUse: [],
    postToolUse: [],
    sessionStart: [],
  };
  if (!fs.existsSync(filePath)) return empty;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Strip simple // line comments to handle JSONC settings without bringing
    // in jsonc-parser at this layer (doctor stays low-dependency).
    const stripped = raw
      .split(/\r?\n/)
      .map((line) => {
        const inString = (() => {
          let count = 0;
          for (let i = 0; i < line.length; i++) {
            if (line[i] === '"' && (i === 0 || line[i - 1] !== '\\')) count++;
          }
          return count;
        })();
        if (inString % 2 === 0) {
          const idx = line.indexOf('//');
          if (idx >= 0) return line.slice(0, idx);
        }
        return line;
      })
      .join('\n');
    const parsed = JSON.parse(stripped) as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> };
    return {
      path: filePath,
      exists: true,
      preToolUse: extractHookSummaries(parsed.hooks?.PreToolUse),
      postToolUse: extractHookSummaries(parsed.hooks?.PostToolUse),
      sessionStart: extractHookSummaries(parsed.hooks?.SessionStart),
    };
  } catch {
    return { ...empty, exists: true };
  }
}

function extractHookSummaries(
  group: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> | undefined,
): HookSummary[] {
  if (!group) return [];
  const out: HookSummary[] = [];
  for (const entry of group) {
    const matcher = entry.matcher;
    for (const h of entry.hooks ?? []) {
      if (!h.command) continue;
      out.push({
        ...(matcher !== undefined ? { matcher } : {}),
        command: h.command,
        classification: classifyHookCommand(h.command),
      });
    }
  }
  return out;
}

function classifyHookCommand(cmd: string): HookSummary['classification'] {
  const c = cmd.toLowerCase().replace(/\\/g, '/');
  if (/(?:^|[\s/"'])nexus-hook(?:[\s"']|$)/.test(c) || /hook-entry\.js/.test(c)) {
    return 'nexus-hook';
  }
  if (/(?:^|[\s/"'])nexus-policy-check(?:[\s"']|$)/.test(c) || /policy-entry\.js/.test(c)) {
    return 'nexus-policy-check';
  }
  if (/\bbash\b/.test(c) && /nexus.*\.sh/.test(c)) {
    return 'legacy-bash';
  }
  return 'unknown';
}

function binariesSection(): BinariesReport {
  return {
    nexus: locateBinary('nexus'),
    nexusHook: locateBinary('nexus-hook'),
    nexusPolicyCheck: locateBinary('nexus-policy-check'),
  };
}

function locateBinary(name: string): BinaryInfo | null {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  const r = spawnSync(cmd, [name], { encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const binPath = lines[0].trim();
  let version: string | undefined;
  try {
    const v = spawnSync(binPath, ['--version'], { encoding: 'utf-8', windowsHide: true, timeout: 3000 });
    if (v.status === 0) {
      version = v.stdout.trim().split(/\s+/).pop();
    }
  } catch { /* version unavailable */ }
  return version !== undefined ? { path: binPath, version } : { path: binPath };
}

function telemetrySection(info: WorkspaceInfo): TelemetryReport | null {
  const dbPath = path.join(info.root, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return { path: dbPath, enabled: false };

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const totals = db
      .prepare("SELECT decision, COUNT(*) AS n FROM events GROUP BY decision")
      .all() as { decision: string | null; n: number }[];
    const t = { allow: 0, ask: 0, deny: 0, noop: 0 };
    for (const row of totals) {
      if (row.decision && row.decision in t) {
        (t as Record<string, number>)[row.decision] = row.n;
      }
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recent = db
      .prepare("SELECT decision, COUNT(*) AS n FROM events WHERE ts_ms >= ? GROUP BY decision")
      .all(cutoff) as { decision: string | null; n: number }[];
    const r = { allow: 0, ask: 0, deny: 0 };
    for (const row of recent) {
      if (row.decision === 'allow' || row.decision === 'ask' || row.decision === 'deny') {
        r[row.decision] = row.n;
      }
    }
    return { path: dbPath, enabled: true, totals: t, recentHourCounts: r };
  } catch {
    return { path: dbPath, enabled: false };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ─── Human-readable formatter ────────────────────────────────────────

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push('═══ Nexus doctor ═══');
  push('');

  push('▸ Workspace');
  push(`  fs_mode: ${report.workspace.fs_mode}`);
  push(`  root:        ${report.workspace.root}`);
  push(`  sourceRoot:  ${report.workspace.sourceRoot}`);
  if (report.workspace.parentRoot) push(`  parentRoot:  ${report.workspace.parentRoot}`);
  if (report.workspace.gitDir) push(`  gitDir:      ${report.workspace.gitDir}`);
  if (report.workspace.commonDir) push(`  commonDir:   ${report.workspace.commonDir}`);
  push('');

  push('▸ Resolved root (used by every Nexus entry point)');
  push(`  source:    ${report.resolvedRoot.source}`);
  push(`  startDir:  ${report.resolvedRoot.startDir}`);
  push(`  env.NEXUS_ROOT:           ${report.resolvedRoot.env.NEXUS_ROOT ?? '(unset)'}`);
  push(`  env.CLAUDE_PROJECT_DIR:   ${report.resolvedRoot.env.CLAUDE_PROJECT_DIR ?? '(unset)'}`);
  push(`  process.cwd:              ${report.resolvedRoot.env.cwd}`);
  push('');

  push('▸ Parent index');
  if (!report.index || !report.index.exists) {
    push(`  ✗ MISSING at ${report.index?.path ?? '(unknown)'}`);
    push(`    Run: nexus build`);
  } else {
    push(`  ✓ ${report.index.path} (${formatBytes(report.index.sizeBytes ?? 0)})`);
    push(`    schema=${report.index.schemaVersion ?? '?'} extractor=${report.index.extractorVersion ?? '?'}`);
    push(`    git_head=${report.index.gitHead ?? '(unset)'} clean_at_index_time=${report.index.cleanAtIndexTime ?? '(unset)'}`);
    push(`    index_mode=${report.index.indexMode ?? '(unset)'}`);
    if (report.index.lastIndexedAt) push(`    last_indexed_at=${report.index.lastIndexedAt}`);
  }
  push('');

  if (report.workspace.fs_mode === 'worktree') {
    push('▸ Worktree overlay');
    if (!report.overlay || !report.overlay.exists) {
      push(`  ✗ MISSING at ${report.overlay?.path ?? '(unknown)'}`);
      push(`    Will be built on next 'nexus build' (or SessionStart hook).`);
    } else {
      push(`  ✓ ${report.overlay.path} (${formatBytes(report.overlay.sizeBytes ?? 0)})`);
      push(`    index_mode=${report.overlay.indexMode ?? '(unset)'}`);
      push(`    parent_git_head=${report.overlay.parentGitHead ?? '(unset)'}`);
      push(`    git_head=${report.overlay.gitHead ?? '(unset)'}`);
      if (report.overlay.builtAt) push(`    built_at=${report.overlay.builtAt}`);
      if (report.overlay.degradedReason) push(`    ⚠ degraded_reason=${report.overlay.degradedReason}`);
    }
    // Live HEAD check for the worktree (helps spot "overlay built against an older HEAD")
    const live = gitHead(report.workspace.root);
    push(`    live worktree HEAD: ${live ?? '(none)'}`);
    push('');
  }

  push('▸ MCP (.mcp.json at project root)');
  if (!report.mcp.projectMcpJson || !report.mcp.projectMcpJson.exists) {
    push(`  ✗ MISSING at ${report.mcp.projectMcpJson?.path ?? '(unknown)'}`);
  } else if (!report.mcp.projectMcpJson.nexusEntry) {
    push(`  ⚠ ${report.mcp.projectMcpJson.path} exists but no 'nexus' entry`);
  } else {
    const e = report.mcp.projectMcpJson.nexusEntry;
    push(`  ✓ ${report.mcp.projectMcpJson.path}`);
    push(`    command: ${e.command} ${e.commandIsAbsolute ? '(absolute)' : '⚠ (relative — depends on PATH)'}`);
    push(`    args:    ${e.args.join(' ')}`);
    push(`    --root:  ${e.bakedRoot ?? '(none — relies on env/cwd)'}`);
  }
  push('');

  push('▸ Hooks');
  for (const layer of [report.hooks.user, report.hooks.project] as const) {
    const tag = layer === report.hooks.user ? 'user' : 'project';
    push(`  ${tag}: ${layer.path}${layer.exists ? '' : ' (missing)'}`);
    if (!layer.exists) continue;
    const renderHook = (label: string, summaries: HookSummary[]) => {
      if (summaries.length === 0) {
        push(`    ${label}: (none)`);
        return;
      }
      for (const s of summaries) {
        const m = s.matcher ? ` matcher=${JSON.stringify(s.matcher)}` : '';
        push(`    ${label}:${m} [${s.classification}]`);
        push(`      ${s.command}`);
      }
    };
    renderHook('PreToolUse', layer.preToolUse);
    renderHook('PostToolUse', layer.postToolUse);
    renderHook('SessionStart', layer.sessionStart);
  }
  push('');

  push('▸ Binaries');
  const renderBin = (label: string, info: BinaryInfo | null) => {
    if (!info) push(`  ${label}: (not found on PATH)`);
    else push(`  ${label}: ${info.path}${info.version ? ` v${info.version}` : ''}`);
  };
  renderBin('nexus            ', report.binaries.nexus);
  renderBin('nexus-hook       ', report.binaries.nexusHook);
  renderBin('nexus-policy-chk ', report.binaries.nexusPolicyCheck);
  push('');

  if (report.telemetry) {
    push('▸ Telemetry');
    push(`  path:    ${report.telemetry.path}`);
    push(`  enabled: ${report.telemetry.enabled}`);
    if (report.telemetry.totals) {
      const t = report.telemetry.totals;
      push(`  totals:  allow=${t.allow} ask=${t.ask} deny=${t.deny} noop=${t.noop}`);
    }
    if (report.telemetry.recentHourCounts) {
      const r = report.telemetry.recentHourCounts;
      push(`  last hr: allow=${r.allow} ask=${r.ask} deny=${r.deny}`);
    }
  }

  return lines.join('\n') + '\n';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
