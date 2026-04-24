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
