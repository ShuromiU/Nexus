import { parse as parseToml } from 'smol-toml';

export interface ParsedCargoLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Parse `Cargo.lock`. Uses `smol-toml`, which decodes `[[package]]` as an
 * array of tables at key `package`. Each entry with both a string `name` and
 * string `version` becomes an output row.
 */
export function parseCargoLock(content: string): ParsedCargoLock | ParseError {
  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid TOML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Cargo.lock root must be a table' };
  }
  const pkgs = (raw as Record<string, unknown>).package;
  if (!Array.isArray(pkgs)) return { entries: [] };

  const entries: { name: string; version: string }[] = [];
  for (const item of pkgs) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string' || typeof obj.version !== 'string') continue;
    entries.push({ name: obj.name, version: obj.version });
  }
  return { entries };
}
