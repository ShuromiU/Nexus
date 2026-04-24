import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PolicyRule, PolicyContext, PolicyEvent, QueryEngineLike, OutlineForImpact } from '../types.js';
import { classifyPath } from '../../workspace/classify.js';
import {
  findSymbolAtEdit,
  bucketRisk,
  summarizeEditImpact,
  summarizeWriteImpact,
  type EditImpact,
  type WriteImpact,
  type RiskBucket,
} from '../impact.js';

const EMPTY_CONFIG = { languages: {} };
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * `preedit-impact` — on `Edit` or `Write` events targeting an exported
 * symbol of an indexed source file with ≥1 importer, emit
 * `allow + additional_context` carrying a summary of downstream callers.
 * Never denies; any failure path returns `null` (silent allow).
 */
export const preeditImpactRule: PolicyRule = {
  name: 'preedit-impact',
  evaluate(event, ctx) {
    if (event.tool_name !== 'Edit' && event.tool_name !== 'Write') return null;
    if (!ctx.queryEngine) return null;

    const rawPath = event.tool_input.file_path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) return null;

    const { relPath, absPath } = relativize(rawPath, ctx.rootDir);
    const basename = path.posix.basename(relPath);
    if (basename.length === 0) return null;

    let kind;
    try {
      kind = classifyPath(relPath, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }
    if (kind.kind !== 'source') return null;

    if (event.tool_name === 'Edit') {
      return evaluateEdit(event, ctx, relPath, absPath);
    }
    return evaluateWrite(ctx, relPath, absPath);
  },
};

function evaluateEdit(
  event: PolicyEvent,
  ctx: PolicyContext,
  relPath: string,
  absPath: string,
) {
  const oldString = event.tool_input.old_string;
  if (typeof oldString !== 'string' || oldString.length === 0) return null;

  const content = readCapped(absPath);
  if (content === null) return null;

  const engine = ctx.queryEngine as QueryEngineLike;

  let importers;
  try {
    importers = engine.importers(relPath);
  } catch {
    return null;
  }
  if (importers.count === 0) return null;

  let outlineEnvelope;
  try {
    outlineEnvelope = engine.outline(relPath);
  } catch {
    return null;
  }
  const outline: OutlineForImpact | undefined = outlineEnvelope.results[0];
  if (!outline) return null;

  const match = findSymbolAtEdit(content, oldString, outline);
  if (!match || !match.exported || !match.topLevel) return null;

  let callerCount = 0;
  try {
    const env = engine.callers(match.name, { file: relPath, limit: 50 });
    callerCount = env.results[0]?.callers?.length ?? 0;
  } catch {
    callerCount = 0;
  }

  const impact: EditImpact = {
    symbol: match.name,
    file: relPath,
    importers: importers.results.map(r => r.file),
    importerCount: importers.count,
    callerCount,
    risk: bucketRisk(callerCount),
  };

  return {
    decision: 'allow' as const,
    rule: 'preedit-impact',
    additional_context: summarizeEditImpact(impact),
  };
}

function evaluateWrite(ctx: PolicyContext, relPath: string, absPath: string) {
  try {
    fs.statSync(absPath);
  } catch {
    return null; // new file: no prior importers by definition
  }

  const engine = ctx.queryEngine as QueryEngineLike;

  let importers;
  try {
    importers = engine.importers(relPath);
  } catch {
    return null;
  }
  if (importers.count === 0) return null;

  let outlineEnvelope;
  try {
    outlineEnvelope = engine.outline(relPath);
  } catch {
    return null;
  }
  const outline: OutlineForImpact | undefined = outlineEnvelope.results[0];
  if (!outline) return null;

  const exportedTopLevel = outline.outline.filter(e => outline.exports.includes(e.name));
  if (exportedTopLevel.length === 0) return null;

  const affectedSymbols = exportedTopLevel.map(entry => {
    let callerCount = 0;
    try {
      const env = engine.callers(entry.name, { file: relPath, limit: 50 });
      callerCount = env.results[0]?.callers?.length ?? 0;
    } catch {
      callerCount = 0;
    }
    return { name: entry.name, callerCount, risk: bucketRisk(callerCount) };
  });

  const maxRisk = affectedSymbols.reduce<RiskBucket>(
    (acc, s) => riskMax(acc, s.risk),
    'low',
  );

  const impact: WriteImpact = {
    file: relPath,
    importers: importers.results.map(r => r.file),
    importerCount: importers.count,
    affectedSymbols,
    risk: maxRisk,
  };

  return {
    decision: 'allow' as const,
    rule: 'preedit-impact',
    additional_context: summarizeWriteImpact(impact),
  };
}

function riskMax(a: RiskBucket, b: RiskBucket): RiskBucket {
  const rank: Record<RiskBucket, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function readCapped(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function relativize(rawPath: string, rootDir: string): { relPath: string; absPath: string } {
  const normalized = rawPath.replace(/\\/g, '/');
  const rootDirPosix = rootDir.replace(/\\/g, '/');
  // POSIX `isAbsolute` doesn't recognize Windows drive-letter prefixes (e.g. "C:/..."),
  // so detect those explicitly — otherwise `resolve` concatenates the cwd + root + path.
  const isWinAbs = /^[a-zA-Z]:\//.test(normalized);
  const absPath = isWinAbs || path.posix.isAbsolute(normalized)
    ? normalized
    : path.posix.resolve(rootDirPosix || '/', normalized);
  const candidateRel = rootDirPosix
    ? path.posix.relative(rootDirPosix, absPath)
    : normalized;
  const relPath = candidateRel.startsWith('..') ? normalized : candidateRel;
  return { relPath, absPath };
}
