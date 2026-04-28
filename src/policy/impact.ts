import type { OutlineForImpact } from './types.js';

export interface SymbolMatch {
  name: string;
  topLevel: boolean;
  exported: boolean;
  line: number;
  end_line: number;
}

export type RiskBucket = 'low' | 'medium' | 'high';

/**
 * Resolve the top-level symbol whose body encloses an `Edit` tool's
 * `old_string`. Returns `null` if the string isn't found, the first match
 * lands outside every top-level entry, or every candidate entry lacks
 * `end_line`. Nested matches collapse to the enclosing top-level entry.
 */
export function findSymbolAtEdit(
  fileContent: string,
  oldString: string,
  outline: OutlineForImpact,
): SymbolMatch | null {
  if (oldString.length === 0) return null;
  const index = fileContent.indexOf(oldString);
  if (index < 0) return null;

  const line = fileContent.slice(0, index).split('\n').length;

  for (const entry of outline.outline) {
    if (entry.end_line === undefined) continue;
    if (line < entry.line || line > entry.end_line) continue;
    return {
      name: entry.name,
      topLevel: true,
      exported: outline.exports.includes(entry.name),
      line: entry.line,
      end_line: entry.end_line,
    };
  }
  return null;
}

export function bucketRisk(callerCount: number): RiskBucket {
  if (callerCount <= 2) return 'low';
  if (callerCount <= 10) return 'medium';
  return 'high';
}

export const SUMMARY_MAX_CHARS = 600;

export interface EditImpact {
  symbol: string;
  file: string;
  importers: string[];
  importerCount: number;
  callerCount: number;
  risk: RiskBucket;
  /**
   * B6 v1.5: when relation data is available, surface the rename-safety
   * driver (e.g. `has_children:2`, `has_importers:5`). Empty when the
   * verdict came from the legacy `bucketRisk(callerCount)` path.
   */
  reasons?: string[];
  /** Number of subclasses/implementers — non-zero pushes risk to `high`. */
  childCount?: number;
}

export interface WriteImpact {
  file: string;
  importers: string[];
  importerCount: number;
  affectedSymbols: { name: string; callerCount: number; risk: RiskBucket }[];
  /** Max over affectedSymbols. */
  risk: RiskBucket;
}

/**
 * Build a human-readable one-paragraph summary for a single-symbol Edit.
 * Guaranteed ≤ SUMMARY_MAX_CHARS; trailing "…" is appended if truncated.
 */
export function summarizeEditImpact(impact: EditImpact): string {
  const head = `⚠️ Editing exported symbol \`${impact.symbol}\` in \`${impact.file}\` (risk: ${impact.risk}).`;

  let importerClause = '';
  if (impact.importerCount > 0) {
    const sample = impact.importers.slice(0, 3).map(f => `\`${f}\``).join(', ');
    const extra = impact.importerCount > 3 ? `, +${impact.importerCount - 3} more` : '';
    importerClause = ` ${impact.importerCount} file(s) import this module: ${sample}${extra};`;
  } else {
    importerClause = ` 0 files import this module;`;
  }

  const callerClause = ` ${impact.callerCount} caller(s) found.`;

  // B6 v1.5: prepend a structural-risk clause when subclasses/implementers
  // exist, since renaming a base class breaks them at a different layer than
  // callers (cited reasons make the driver explicit).
  let structuralClause = '';
  if (impact.childCount && impact.childCount > 0) {
    structuralClause = ` ${impact.childCount} subclass/implementer(s) depend on this type;`;
  }

  const hint = ` Run nexus_rename_safety('${impact.symbol}') for the full verdict.`;
  return capSummary(`${head}${structuralClause}${importerClause}${callerClause}${hint}`);
}

/**
 * Build a human-readable summary for a Write that replaces every export in
 * an existing file. Lists the top-3 affected symbols by caller count.
 */
export function summarizeWriteImpact(impact: WriteImpact): string {
  const head = `⚠️ Rewriting ${impact.file} replaces ${impact.affectedSymbols.length} exported symbol(s) (max risk: ${impact.risk}).`;

  const top = impact.affectedSymbols
    .slice()
    .sort((a, b) => b.callerCount - a.callerCount)
    .slice(0, 3)
    .map(s => `\`${s.name}\` (${s.callerCount} caller${s.callerCount === 1 ? '' : 's'})`)
    .join(', ');
  const topClause = top.length > 0 ? ` Top by callers: ${top}.` : '';

  const importerClause = ` ${impact.importerCount} importer(s).`;
  const hint = ` Run nexus_callers for any symbol to see full call sites.`;

  return capSummary(`${head}${topClause}${importerClause}${hint}`);
}

function capSummary(s: string): string {
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return s.slice(0, SUMMARY_MAX_CHARS - 1) + '…';
}
