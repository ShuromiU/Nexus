export interface ParsedPackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
}

export type ParseError = { error: string };

export function parsePackageJson(content: string): ParsedPackageJson | ParseError {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'package.json root must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedPackageJson = {};
  if (typeof obj.name === 'string') result.name = obj.name;
  if (typeof obj.version === 'string') result.version = obj.version;
  if (isStringMap(obj.dependencies)) result.dependencies = obj.dependencies;
  if (isStringMap(obj.devDependencies)) result.devDependencies = obj.devDependencies;
  if (isStringMap(obj.peerDependencies)) result.peerDependencies = obj.peerDependencies;
  if (isStringMap(obj.scripts)) result.scripts = obj.scripts;
  if (Array.isArray(obj.workspaces) && obj.workspaces.every(w => typeof w === 'string')) {
    result.workspaces = obj.workspaces as string[];
  } else if (isWorkspacesObject(obj.workspaces)) {
    result.workspaces = obj.workspaces;
  }
  return result;
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(x => typeof x === 'string');
}

function isWorkspacesObject(v: unknown): v is { packages: string[] } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = (v as { packages?: unknown }).packages;
  return Array.isArray(p) && p.every(x => typeof x === 'string');
}
