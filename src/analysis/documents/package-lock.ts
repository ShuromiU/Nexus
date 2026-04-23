export interface ParsedPackageLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Parse npm `package-lock.json`. Supports lockfileVersion 1 (legacy
 * `dependencies` tree) and lockfileVersion 2/3 (flat `packages` map keyed on
 * `node_modules/<pkg>` paths).
 *
 * Returns every `{name, version}` pair encountered. Duplicates (same package
 * at different versions) are preserved — callers decide how to dedupe.
 */
export function parsePackageLock(content: string): ParsedPackageLock | ParseError {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'package-lock.json root must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const entries: { name: string; version: string }[] = [];

  // Prefer v2/v3 `packages` map.
  if (typeof obj.packages === 'object' && obj.packages !== null && !Array.isArray(obj.packages)) {
    for (const [key, value] of Object.entries(obj.packages as Record<string, unknown>)) {
      if (key === '') continue; // root package
      const name = packageNameFromPath(key);
      if (!name) continue;
      const version = extractVersion(value);
      if (version === null) continue;
      entries.push({ name, version });
    }
    return { entries };
  }

  // Fall back to v1 `dependencies` tree.
  if (typeof obj.dependencies === 'object' && obj.dependencies !== null && !Array.isArray(obj.dependencies)) {
    walkV1Deps(obj.dependencies as Record<string, unknown>, entries);
  }
  return { entries };
}

/**
 * `node_modules/foo` → `foo`
 * `node_modules/@scope/pkg` → `@scope/pkg`
 * `node_modules/foo/node_modules/bar` → `bar`
 * Returns null if the path has no `node_modules/` segment.
 */
function packageNameFromPath(p: string): string | null {
  const marker = 'node_modules/';
  const idx = p.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = p.slice(idx + marker.length);
  if (rest.length === 0) return null;
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const nextSlash = rest.indexOf('/', slash + 1);
    return nextSlash === -1 ? rest : rest.slice(0, nextSlash);
  }
  const nextSlash = rest.indexOf('/');
  return nextSlash === -1 ? rest : rest.slice(0, nextSlash);
}

function extractVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>).version;
  return typeof v === 'string' ? v : null;
}

function walkV1Deps(
  deps: Record<string, unknown>,
  out: { name: string; version: string }[],
): void {
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    if (typeof obj.version === 'string') {
      out.push({ name, version: obj.version });
    }
    if (typeof obj.dependencies === 'object' && obj.dependencies !== null && !Array.isArray(obj.dependencies)) {
      walkV1Deps(obj.dependencies as Record<string, unknown>, out);
    }
  }
}
