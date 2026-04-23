/**
 * Compact transport for NexusResult envelopes.
 *
 * Drops envelope chrome (query, timing, status flags) and renames result keys
 * to single-letter aliases to roughly halve the JSON payload. Opt-in per call
 * via the `compact` flag exposed on every tool's input schema.
 *
 * Compact mode is purely a transport concern — engine methods always return
 * the verbose shape; transports call `compactify()` before serialization.
 */

import type { NexusResult, NexusResultType } from './engine.js';

/** Single-letter key map. Keep alphabetized by long key for review sanity. */
const KEY_MAP: Record<string, string> = {
  actual: 'ac',
  alias: 'a',
  call_sites: 'cs',
  callers: 'cl',
  caller: 'c',
  change_type: 'ct',
  children: 'ch',
  col: 'cc',
  confidence: 'cf',
  context: 'x',
  count: 'n',
  deps: 'dp',
  direction: 'dr',
  doc: 'd',
  doc_summary: 'ds',
  end_line: 'el',
  entries: 'es',
  exports: 'ex',
  file: 'f',
  found: 'fd',
  imports: 'im',
  is_default: 'id',
  is_star: 'is',
  is_type: 'it',
  key: 'ke',
  kind: 'k',
  language: 'lg',
  length: 'ln',
  limit: 'lm',
  line: 'l',
  lines: 'ls',
  match: 'm',
  name: 'nm',
  names: 'nms',
  outline: 'o',
  path: 'p',
  payload: 'pl',
  preview: 'pr',
  results: 'r',
  scope: 'sc',
  signature: 's',
  source: 'src',
  status: 'st',
  symbol_count: 'sn',
  target: 'tg',
  tokens: 't',
  truncated: 'tr',
  type: 'ty',
  value: 'v',
  value_kind: 'vk',
  version: 've',
};

/** Reverse-map exported for tests/debug. */
export const COMPACT_KEY_MAP = KEY_MAP;

/** Recursively rename keys; drop null/undefined and empty arrays/strings. */
function shrink(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const v = shrink(item);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' && v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (v === false) continue; // boolean flags collapse: presence === true
      const shrunken = shrink(v);
      if (shrunken === undefined) continue;
      const newKey = KEY_MAP[k] ?? k;
      out[newKey] = shrunken;
    }
    return out;
  }
  return value;
}

/**
 * Convert a verbose NexusResult into its compact transport shape.
 *
 * Verbose: { query, type, results: [...], count, index_status, index_health, timing_ms }
 * Compact: { ty: <type>, r: [...] }
 *
 * Suggestions are preserved (rare and useful) under `sg`.
 */
export function compactify<T>(result: NexusResult<T>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ty: result.type,
    r: shrink(result.results) ?? [],
  };
  if (result.suggestions && result.suggestions.length > 0) {
    out.sg = result.suggestions;
  }
  if (result.index_health === 'partial') {
    out.h = 'partial';
  }
  return out;
}

/** Compactify a non-NexusResult value (used by batch sub-results). */
export function compactifyValue(value: unknown): unknown {
  return shrink(value);
}

/** Helper for transports: returns either the compacted shape or the raw result. */
export function maybeCompactify<T>(
  result: NexusResult<T>,
  compact: boolean | undefined,
): NexusResult<T> | Record<string, unknown> {
  return compact ? compactify(result) : result;
}

/** Type guard re-export so transport code can narrow on result.type. */
export type { NexusResultType };
