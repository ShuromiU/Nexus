/**
 * Stale-doc detection (B3 v1).
 *
 * Pure parsers for JSDoc `@param` / `@returns` tags and TS-style function
 * signatures. Used by `QueryEngine.staleDocs` to flag drift between a
 * symbol's docstring and its actual signature.
 *
 * v1 scope: parameter-name mismatches only (added/renamed/removed) for
 * symbols with a non-null doc AND signature AND at least one `@param`
 * tag. Symbols whose doc has no `@param` tags are not flagged — we only
 * report drift in docs the author has clearly committed to.
 */

/**
 * Extract `@param name` tag names from a JSDoc block comment. Tolerates
 * leading `*`, hyphens after the name, and curly-typed `@param {T} name`.
 * Order is preserved.
 */
export function extractDocParams(doc: string): string[] {
  const out: string[] = [];
  // Normalize: strip block-comment open/close, then split on lines and
  // strip per-line `*` decorations. This handles single-line block
  // comments (`/** @param x */`) and multi-line JSDoc uniformly.
  const normalized = doc.replace(/\/\*+/g, '').replace(/\*+\//g, '');
  const lines = normalized.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/^\s*\*?\s*/, '');
    const m = /^@param(?:\s+\{[^}]*\})?\s+(\[?)(\.{0,3})([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) continue;
    out.push(m[3]);
  }
  return out;
}

/**
 * Whether the doc has at least one `@returns` (or `@return`) tag.
 */
export function docHasReturns(doc: string): boolean {
  return /(^|\n)\s*\*?\s*@returns?\b/.test(doc);
}

/**
 * Extract parameter names from a TS-style signature like
 * `(a: number, b?: string, ...rest: any[])`. Returns an array where each
 * entry is either the param name, or `null` for positions we cannot
 * reliably parse (destructured params, complex defaults). The caller can
 * skip nulls when comparing to doc params.
 */
export function extractSignatureParams(signature: string): (string | null)[] {
  // Strip the parameter list off the front of the signature. The signature
  // string may contain a return type after the parens — we only want the
  // parens body.
  const open = signature.indexOf('(');
  if (open < 0) return [];
  const body = sliceBalanced(signature, open);
  if (body === null) return [];

  const parts = splitTopLevelCommas(body);
  return parts.map(parseSingleParam);
}

/**
 * Take the body between matching parens starting at `open` in `signature`,
 * returning the inner text or null if unbalanced. Tracks (), [], {}, <>,
 * and skips string contents.
 */
function sliceBalanced(signature: string, open: number): string | null {
  if (signature[open] !== '(') return null;
  let depth = 0;
  let i = open;
  let inString: string | null = null;
  while (i < signature.length) {
    const ch = signature[i];
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return signature.slice(open + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * Split a parameter-list body on top-level commas, ignoring commas inside
 * any of: (), [], {}, <>, or string literals.
 */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      buf += ch;
      if (ch === '\\') { buf += body[i + 1] ?? ''; i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

/**
 * Parse one comma-separated chunk into its parameter name. Returns null
 * for shapes we don't try to handle (destructured, complex literals).
 */
function parseSingleParam(chunk: string): string | null {
  let s = chunk.trim();
  if (s.length === 0) return null;
  // Strip leading visibility / readonly / decorators (`@Foo() x: T`, `public readonly x: T`).
  s = s.replace(/^@\w+(\([^)]*\))?\s+/, '');
  s = s.replace(/^(public|private|protected|readonly)\s+/, '');
  s = s.replace(/^(public|private|protected|readonly)\s+/, '');
  // Rest parameter: `...args: T[]` → name `args`.
  if (s.startsWith('...')) s = s.slice(3);
  // Destructured / array-bound: bail.
  if (s.startsWith('{') || s.startsWith('[')) return null;
  const m = /^([A-Za-z_$][\w$]*)/.exec(s);
  return m ? m[1] : null;
}

export interface StaleDocIssue {
  kind: 'unknown_param' | 'undocumented_param';
  detail: string;
}

/**
 * Compute drift issues between a doc's `@param` set and a signature's
 * parameter set. Returns empty array if the doc has no `@param` tags
 * (full-skip rule) or the signature has no parseable params.
 */
export function diffDocAgainstSignature(doc: string, signature: string): StaleDocIssue[] {
  const docParams = extractDocParams(doc);
  if (docParams.length === 0) return [];
  const sigParams = extractSignatureParams(signature)
    .filter((p): p is string => p !== null);
  if (sigParams.length === 0) return [];

  const sigSet = new Set(sigParams);
  const docSet = new Set(docParams);
  const issues: StaleDocIssue[] = [];

  for (const dp of docParams) {
    if (!sigSet.has(dp)) {
      issues.push({ kind: 'unknown_param', detail: dp });
    }
  }
  for (const sp of sigParams) {
    if (!docSet.has(sp)) {
      issues.push({ kind: 'undocumented_param', detail: sp });
    }
  }
  return issues;
}
