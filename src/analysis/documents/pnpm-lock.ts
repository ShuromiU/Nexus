import { parse as parseYaml } from 'yaml';

export interface ParsedPnpmLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Parse `pnpm-lock.yaml`. Walks the top-level `packages` map and extracts
 * `{name, version}` from each key. Supports two key formats:
 *   - Modern (pnpm v6+): `/name@version` and `/@scope/name@version`
 *   - Legacy (pnpm ≤v5): `/name/version` and `/@scope/name/version`
 *
 * Peer-dependency suffixes (`/foo@1.0.0(bar@2.0.0)`) are stripped.
 */
export function parsePnpmLock(content: string): ParsedPnpmLock | ParseError {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid YAML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entries: [] };
  }
  const obj = raw as Record<string, unknown>;
  const pkgs = obj.packages;
  if (typeof pkgs !== 'object' || pkgs === null || Array.isArray(pkgs)) {
    return { entries: [] };
  }

  const entries: { name: string; version: string }[] = [];
  for (const rawKey of Object.keys(pkgs as Record<string, unknown>)) {
    const parsed = parsePnpmKey(rawKey);
    if (parsed) entries.push(parsed);
  }
  return { entries };
}

/**
 * Turn a pnpm packages-key into {name, version}.
 * Accepts modern `/name@version` and legacy `/name/version`. Returns null
 * if we can't confidently extract both.
 */
function parsePnpmKey(raw: string): { name: string; version: string } | null {
  let key = raw.startsWith('/') ? raw.slice(1) : raw;
  // Strip peer-dep suffix: `foo@1.0.0(react@18.2.0)` → `foo@1.0.0`
  const parenIdx = key.indexOf('(');
  if (parenIdx !== -1) key = key.slice(0, parenIdx);

  if (key.startsWith('@')) {
    // Scoped: @scope/name@version OR @scope/name/version
    const slash = key.indexOf('/');
    if (slash === -1) return null;
    const rest = key.slice(slash + 1); // `name@version` or `name/version`
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      return { name: key.slice(0, slash + 1 + at), version: rest.slice(at + 1) };
    }
    const slash2 = rest.lastIndexOf('/');
    if (slash2 > 0) {
      return { name: key.slice(0, slash + 1 + slash2), version: rest.slice(slash2 + 1) };
    }
    return null;
  }

  const at = key.lastIndexOf('@');
  if (at > 0) {
    return { name: key.slice(0, at), version: key.slice(at + 1) };
  }
  const slash = key.lastIndexOf('/');
  if (slash > 0) {
    return { name: key.slice(0, slash), version: key.slice(slash + 1) };
  }
  return null;
}
