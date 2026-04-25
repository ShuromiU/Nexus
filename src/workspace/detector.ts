import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ─── Workspace info ────────────────────────────────────────────────────

export type WorkspaceMode = 'standalone' | 'main' | 'worktree';

/** Effective index strategy chosen at build time, recorded in meta. */
export type IndexMode = 'full' | 'overlay-on-parent' | 'worktree-isolated';

export interface StandaloneWorkspaceInfo {
  mode: 'standalone';
  root: string;
  sourceRoot: string;
}

export interface MainWorkspaceInfo {
  mode: 'main';
  root: string;
  sourceRoot: string;
  gitDir: string;
}

export interface WorktreeWorkspaceInfo {
  mode: 'worktree';
  root: string;
  sourceRoot: string;
  parentRoot: string;
  baseIndexPath: string;
  overlayPath: string;
  gitDir: string;
  commonDir: string;
}

export type WorkspaceInfo =
  | StandaloneWorkspaceInfo
  | MainWorkspaceInfo
  | WorktreeWorkspaceInfo;

/**
 * Detect workspace info by walking up from `startDir`.
 *
 * Nearest-marker-wins, with one rule for ambiguity: when both `.git` and
 * `.nexus.json` are present in the same directory, `.git` wins. This matters
 * because Claude Desktop copies the project's `.mcp.json` (and sometimes
 * `.nexus.json`) into worktree directories, and the worktree's `.git` pointer
 * file is the canonical anchor we want to honor.
 */
export function detectWorkspace(startDir: string): WorkspaceInfo {
  let dir = path.resolve(startDir);
  let standaloneCandidate: string | null = null;

  while (true) {
    const gitEntry = path.join(dir, '.git');
    const nexusJson = path.join(dir, '.nexus.json');
    const hasGit = fs.existsSync(gitEntry);
    const hasNexusJson = fs.existsSync(nexusJson);

    if (hasGit) {
      // .git present — wins over .nexus.json at the same directory.
      let stat: fs.Stats;
      try {
        stat = fs.statSync(gitEntry);
      } catch {
        // Symlink / permission issue — fall back to standalone path.
        return { mode: 'standalone', root: dir, sourceRoot: dir };
      }

      if (stat.isDirectory()) {
        return { mode: 'main', root: dir, sourceRoot: dir, gitDir: gitEntry };
      }

      if (stat.isFile()) {
        const wt = parseWorktreeGitFile(dir, gitEntry);
        if (wt) return wt;
        // Malformed pointer — degrade to main mode rooted at this dir.
        return { mode: 'main', root: dir, sourceRoot: dir, gitDir: gitEntry };
      }

      // Some other entry kind — treat as standalone.
      return { mode: 'standalone', root: dir, sourceRoot: dir };
    }

    if (hasNexusJson && standaloneCandidate === null) {
      // Record the nearest .nexus.json so we can fall back to it if no
      // ancestor `.git` is found. We DO NOT stop here — a parent `.git`
      // would still win nothing because nearest-marker-wins, but historical
      // semantics treat .nexus.json as "stop here, this is the project".
      // Keep that behavior: a .nexus.json with no .git at the same dir
      // marks the standalone root.
      return { mode: 'standalone', root: dir, sourceRoot: dir };
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (standaloneCandidate) {
    return { mode: 'standalone', root: standaloneCandidate, sourceRoot: standaloneCandidate };
  }
  return { mode: 'standalone', root: path.resolve(startDir), sourceRoot: path.resolve(startDir) };
}

function parseWorktreeGitFile(worktreeRoot: string, gitFile: string): WorktreeWorkspaceInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(gitFile, 'utf-8');
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;

  // gitdir may be absolute or relative to the worktree root.
  let gitDir = match[1].trim();
  if (!path.isAbsolute(gitDir)) {
    gitDir = path.resolve(worktreeRoot, gitDir);
  }

  // Resolve commondir: <gitDir>/commondir is a file containing a path
  // relative to gitDir (or absolute) that points at the shared .git dir.
  let commonDir: string;
  try {
    const commonDirEntry = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    commonDir = path.isAbsolute(commonDirEntry)
      ? commonDirEntry
      : path.resolve(gitDir, commonDirEntry);
  } catch {
    // If commondir file is missing, derive it: `<repo>/.git/worktrees/<name>` → `<repo>/.git`.
    commonDir = path.resolve(gitDir, '..', '..');
  }

  const parentRoot = path.dirname(commonDir);
  return {
    mode: 'worktree',
    root: worktreeRoot,
    sourceRoot: worktreeRoot,
    parentRoot,
    baseIndexPath: path.join(parentRoot, '.nexus', 'index.db'),
    overlayPath: path.join(worktreeRoot, '.nexus', 'overlay.db'),
    gitDir,
    commonDir,
  };
}

/**
 * Backward-compat shim. Returns the workspace root path. New callers should
 * use `detectWorkspace()` to get full mode info.
 */
export function detectRoot(startDir: string): string {
  return detectWorkspace(startDir).root;
}

// ─── Shared root resolution (single source for all entry points) ─────

export interface ResolvedRoot {
  startDir: string;
  source: 'arg' | 'env-nexus' | 'env-claude' | 'mcp-roots' | 'cwd';
}

export interface ResolveRootOptions {
  rootArg?: string;
  /** Roots received from MCP client `roots/list`, if any. */
  mcpRoots?: string[];
}

/**
 * Resolve the working directory from which to detect workspace, using the
 * unified precedence chain. Used by every entry point: MCP server, CLI,
 * policy-entry, hook-entry, doctor.
 *
 * Precedence: `--root` arg → `NEXUS_ROOT` env → `CLAUDE_PROJECT_DIR` env →
 * MCP roots (when MCP SDK exposes them) → `process.cwd()`.
 */
export function resolveRoot(opts: ResolveRootOptions = {}): ResolvedRoot {
  if (opts.rootArg && opts.rootArg.length > 0) {
    return { startDir: path.resolve(opts.rootArg), source: 'arg' };
  }
  const envNexus = process.env.NEXUS_ROOT;
  if (envNexus && envNexus.length > 0) {
    return { startDir: path.resolve(envNexus), source: 'env-nexus' };
  }
  const envClaude = process.env.CLAUDE_PROJECT_DIR;
  if (envClaude && envClaude.length > 0) {
    return { startDir: path.resolve(envClaude), source: 'env-claude' };
  }
  if (opts.mcpRoots && opts.mcpRoots.length > 0) {
    // First root wins; MCP clients typically send one root per session.
    return { startDir: path.resolve(opts.mcpRoots[0]), source: 'mcp-roots' };
  }
  return { startDir: process.cwd(), source: 'cwd' };
}

// ─── Worktree-safe git helpers (shell out, never read .git directly) ─

function runGit(cwd: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.error) return { stdout: '', status: 1 };
  return { stdout: result.stdout ?? '', status: result.status ?? 1 };
}

/** Returns the current HEAD commit hash, or null if not a git repo. */
export function gitHead(rootDir: string): string | null {
  const { stdout, status } = runGit(rootDir, ['rev-parse', '--verify', 'HEAD']);
  if (status !== 0) return null;
  const head = stdout.trim();
  return head.length > 0 ? head : null;
}

export interface CleanCheckOptions {
  /**
   * Path prefixes to ignore in the porcelain output. Should typically include
   * just `.nexus/` (Nexus's auto-generated artifacts). Note: `.nexus.json`
   * and `.nexusignore` are real user config and should NOT be ignored — they
   * affect indexing and a dirty config means the parent index is not a
   * reusable base.
   */
  ignorePaths: string[];
}

/**
 * Returns true if the working tree at `rootDir` has no uncommitted or
 * untracked changes, ignoring the specified path prefixes.
 *
 * MUST be called BEFORE any `.nexus/` writes if used to determine
 * `clean_at_index_time`, or the result is meaningless.
 */
export function gitStatusClean(rootDir: string, opts: CleanCheckOptions): boolean {
  const { stdout, status } = runGit(rootDir, ['status', '--porcelain']);
  if (status !== 0) return false;
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return true;

  const ignores = opts.ignorePaths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''));
  const isIgnored = (porcelainLine: string): boolean => {
    // Porcelain v1 format: "XY <path>" or "XY <orig> -> <new>".
    // The path starts at column 3.
    const rest = porcelainLine.slice(3);
    const target = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
    const norm = target.replace(/\\/g, '/').trim().replace(/^"(.*)"$/, '$1');
    return ignores.some((ign) => norm === ign || norm.startsWith(ign + '/'));
  };

  return lines.every(isIgnored);
}

export interface GitChange {
  status: 'A' | 'M' | 'D';
  path: string;
}

/**
 * Parse `git diff --name-status -z` output. With `-z`, both the field
 * separator (normally TAB) and the record separator (normally LF) become
 * NUL bytes. So a regular entry is `STATUS\0PATH\0` and a rename/copy is
 * `R<score>\0OLD\0NEW\0`. We decompose renames/copies into delete-old +
 * add-new pairs.
 */
function parseNameStatusZ(stdout: string): GitChange[] {
  const out: GitChange[] = [];
  if (stdout.length === 0) return out;
  // Split on NUL but keep all tokens; trailing NUL leaves an empty final element which we filter.
  const tokens = stdout.split('\0').filter((t) => t.length > 0);

  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        out.push({ status: 'D', path: oldPath });
        out.push({ status: 'A', path: newPath });
      }
      i += 3;
      continue;
    }
    const p = tokens[i + 1];
    if (p !== undefined) {
      const status: GitChange['status'] = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
      out.push({ status, path: p });
    }
    i += 2;
  }
  return out;
}

/** Committed changes between `base` and HEAD: `git diff <base>...HEAD`. */
export function gitDiffNameStatus(rootDir: string, base: string): GitChange[] {
  const { stdout, status } = runGit(rootDir, [
    'diff', '--name-status', '-z', '--no-renames', `${base}...HEAD`,
  ]);
  if (status !== 0) return [];
  return parseNameStatusZ(stdout);
}

/** Staged but uncommitted changes. */
export function gitDiffStaged(rootDir: string): GitChange[] {
  const { stdout, status } = runGit(rootDir, [
    'diff', '--cached', '--name-status', '-z', '--no-renames', 'HEAD',
  ]);
  if (status !== 0) return [];
  return parseNameStatusZ(stdout);
}

/** Unstaged working-tree changes. */
export function gitDiffUnstaged(rootDir: string): GitChange[] {
  const { stdout, status } = runGit(rootDir, [
    'diff', '--name-status', '-z', '--no-renames',
  ]);
  if (status !== 0) return [];
  return parseNameStatusZ(stdout);
}

/** Untracked files (excluding standard ignores). */
export function gitLsFilesUntracked(rootDir: string): string[] {
  const { stdout, status } = runGit(rootDir, [
    'ls-files', '--others', '--exclude-standard', '-z',
  ]);
  if (status !== 0) return [];
  return stdout.split('\0').filter((t) => t.length > 0);
}

/**
 * True iff `a` is an ancestor commit of `b`. Used to verify that the parent
 * index's git_head can serve as a diff base for the worktree's HEAD.
 */
export function gitMergeBaseIsAncestor(rootDir: string, a: string, b: string): boolean {
  const { status } = runGit(rootDir, ['merge-base', '--is-ancestor', a, b]);
  return status === 0;
}

// ─── Filesystem helpers (preserved from previous version) ────────────

/**
 * Detect whether the filesystem at `rootDir` is case-sensitive.
 * Creates a temp file with a known name, checks if the uppercase variant resolves.
 */
export function detectCaseSensitivity(rootDir: string): boolean {
  const tmpName = `.nexus-case-probe-${randomUUID()}`;
  const tmpPath = path.join(rootDir, tmpName);

  try {
    fs.writeFileSync(tmpPath, '');
    const upperPath = path.join(rootDir, tmpName.toUpperCase());
    const isCaseInsensitive = fs.existsSync(upperPath);
    return !isCaseInsensitive;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Get the current git HEAD commit hash, or null if not a git repo.
 *
 * Works in both main checkouts and worktrees by shelling out to git
 * (the previous fs-based implementation read `<root>/.git/HEAD` directly,
 * which fails in worktrees where `.git` is a pointer file).
 */
export function getGitHead(rootDir: string): string | null {
  return gitHead(rootDir);
}
