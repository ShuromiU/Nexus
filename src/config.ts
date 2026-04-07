import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface NexusConfig {
  root: string;
  exclude: string[];
  include: string[];
  languages: Record<string, { extensions: string[] }>;
  maxFileSize: number;
  minifiedLineLength: number;
}

const DEFAULT_CONFIG: NexusConfig = {
  root: '.',
  exclude: [],
  include: [],
  languages: {},
  maxFileSize: 1_048_576, // 1MB
  minifiedLineLength: 500,
};

/**
 * Load .nexus.json from the given directory. All fields are optional;
 * missing fields get sensible defaults.
 */
export function loadConfig(rootDir: string): NexusConfig {
  const configPath = path.join(rootDir, '.nexus.json');

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<NexusConfig>;

    return {
      root: parsed.root ?? DEFAULT_CONFIG.root,
      exclude: parsed.exclude ?? DEFAULT_CONFIG.exclude,
      include: parsed.include ?? DEFAULT_CONFIG.include,
      languages: parsed.languages ?? DEFAULT_CONFIG.languages,
      maxFileSize: parsed.maxFileSize ?? DEFAULT_CONFIG.maxFileSize,
      minifiedLineLength: parsed.minifiedLineLength ?? DEFAULT_CONFIG.minifiedLineLength,
    };
  } catch {
    // No config file or invalid JSON — use all defaults
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Compute a deterministic hash of the config for invalidation.
 * Changes to .nexus.json trigger a full rebuild.
 */
export function computeConfigHash(config: NexusConfig): string {
  const serialized = JSON.stringify(config);
  return createHash('sha256').update(serialized).digest('hex');
}
