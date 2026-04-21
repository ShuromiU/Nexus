import * as fs from 'node:fs';
import { parsePackageJson, type ParsedPackageJson } from './package-json.js';
import { parseTsconfig, type ParsedTsconfig } from './tsconfig.js';
import { parseGenericJson } from './generic-json.js';
import { getDocumentCache } from './cache.js';

export const SIZE_CAPS = {
  package_json: 1 * 1024 * 1024,
  tsconfig_json: 1 * 1024 * 1024,
  cargo_toml: 1 * 1024 * 1024,
  gha_workflow: 1 * 1024 * 1024,
  json_generic: 5 * 1024 * 1024,
  yaml_generic: 5 * 1024 * 1024,
  toml_generic: 5 * 1024 * 1024,
  yarn_lock: 20 * 1024 * 1024,
} as const;

export type LoadError = {
  error: string;
  limit?: number;
  actual?: number;
};

function loadCached<T>(
  absPath: string,
  limit: number,
  parse: (content: string) => T,
): T | LoadError {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'stat failed' };
  }
  if (!stat.isFile()) return { error: 'not a regular file' };
  if (stat.size > limit) {
    return { error: 'file_too_large', limit, actual: stat.size };
  }

  const cache = getDocumentCache();
  const cached = cache.get(absPath, stat.mtimeMs, stat.size) as T | undefined;
  if (cached !== undefined) return cached;

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'read failed' };
  }

  const parsed = parse(content);
  cache.set(absPath, stat.mtimeMs, stat.size, parsed, content.length);
  return parsed;
}

export function loadPackageJson(absPath: string): ParsedPackageJson | LoadError {
  return loadCached(absPath, SIZE_CAPS.package_json, parsePackageJson);
}

export function loadTsconfig(absPath: string): ParsedTsconfig | LoadError {
  return loadCached(absPath, SIZE_CAPS.tsconfig_json, parseTsconfig);
}

export function loadGenericJson(absPath: string): unknown | LoadError {
  return loadCached(absPath, SIZE_CAPS.json_generic, parseGenericJson);
}
