import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const ENV_VAR = 'NEXUS_TELEMETRY';

/**
 * Resolve telemetry on/off. Env trumps config; defaults to enabled.
 *
 * Precedence:
 *   1. NEXUS_TELEMETRY=0|false → disabled
 *   2. NEXUS_TELEMETRY=1|true  → enabled (overrides config)
 *   3. .nexus.json telemetry:false → disabled
 *   4. .nexus.json telemetry:true  → enabled
 *   5. Default → enabled
 *
 * Unknown env values (e.g. "yes") fall through to config/default.
 * Malformed config falls through to default (enabled).
 */
export function isTelemetryEnabled(rootDir: string): boolean {
  const env = process.env[ENV_VAR];
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return true;

  try {
    const raw = fs.readFileSync(path.join(rootDir, '.nexus.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { telemetry?: unknown };
    if (typeof parsed.telemetry === 'boolean') return parsed.telemetry;
  } catch {
    /* missing or malformed → default */
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * 16-char hex prefix of SHA256 over canonical-JSON-serialized `tool_input`.
 * Used by D5 to correlate PreToolUse `ask` decisions to PostToolUse events
 * within the same session for override-rate measurement.
 */
export function computeInputHash(toolInput: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(toolInput)).digest('hex').slice(0, 16);
}
