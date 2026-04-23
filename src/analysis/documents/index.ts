export { parsePackageJson } from './package-json.js';
export type { ParsedPackageJson } from './package-json.js';

export { parseTsconfig } from './tsconfig.js';
export type { ParsedTsconfig } from './tsconfig.js';

export { parseGenericJson } from './generic-json.js';

export { parseGhaWorkflow } from './gha-workflow.js';
export type { ParsedGhaWorkflow } from './gha-workflow.js';

export { parseGenericYaml } from './generic-yaml.js';

export { parseCargoToml } from './cargo-toml.js';
export type { ParsedCargoToml } from './cargo-toml.js';

export { parseGenericToml } from './generic-toml.js';

export { parseYarnLock } from './yarn-lock.js';
export type { ParsedYarnLock } from './yarn-lock.js';

export { parsePackageLock } from './package-lock.js';
export type { ParsedPackageLock } from './package-lock.js';

export { parsePnpmLock } from './pnpm-lock.js';
export type { ParsedPnpmLock } from './pnpm-lock.js';

export { parseCargoLock } from './cargo-lock.js';
export type { ParsedCargoLock } from './cargo-lock.js';

// Loaders (A2) — read + size-cap + parse + cache.
export {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
  loadYarnLock, loadPackageLock, loadPnpmLock, loadCargoLock,
  SIZE_CAPS,
} from './loaders.js';
export type { LoadError } from './loaders.js';
export {
  getDocumentCache, resetDocumentCache, DocumentCache,
} from './cache.js';
export type { CacheOptions } from './cache.js';
