import { parse as parseToml } from 'smol-toml';

export interface ParsedCargoToml {
  package?: { name?: string; version?: string; edition?: string };
  dependencies?: Record<string, unknown>;
  'dev-dependencies'?: Record<string, unknown>;
  workspace?: { members?: string[] };
}

export type ParseError = { error: string };

export function parseCargoToml(content: string): ParsedCargoToml | ParseError {
  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid TOML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Cargo.toml root must be a table' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedCargoToml = {};
  if (typeof obj.package === 'object' && obj.package !== null && !Array.isArray(obj.package)) {
    const pkg = obj.package as Record<string, unknown>;
    const p: ParsedCargoToml['package'] = {};
    if (typeof pkg.name === 'string') p.name = pkg.name;
    if (typeof pkg.version === 'string') p.version = pkg.version;
    if (typeof pkg.edition === 'string') p.edition = pkg.edition;
    result.package = p;
  }
  if (typeof obj.dependencies === 'object' && obj.dependencies !== null && !Array.isArray(obj.dependencies)) {
    result.dependencies = obj.dependencies as Record<string, unknown>;
  }
  if (typeof obj['dev-dependencies'] === 'object' && obj['dev-dependencies'] !== null && !Array.isArray(obj['dev-dependencies'])) {
    result['dev-dependencies'] = obj['dev-dependencies'] as Record<string, unknown>;
  }
  if (typeof obj.workspace === 'object' && obj.workspace !== null && !Array.isArray(obj.workspace)) {
    const ws = obj.workspace as Record<string, unknown>;
    const w: ParsedCargoToml['workspace'] = {};
    if (Array.isArray(ws.members) && ws.members.every(x => typeof x === 'string')) {
      w.members = ws.members as string[];
    }
    result.workspace = w;
  }
  return result;
}
