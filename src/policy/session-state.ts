import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `.nexus/session-state.json` store for the D3 test-tracker rule. Keeps a
 * per-session log of successful test invocations so the evidence-summary
 * rule can answer `tests_run_this_session: bool`.
 *
 * Cross-session isolation is by file: when a write arrives with a
 * different `session_id`, the file is rewritten fresh.
 */

export interface TestRunRecord {
  cmd: string;
  ts_ms: number;
  exit: number;
}

export interface SessionState {
  session_id: string;
  started_at: number;
  tests_run: TestRunRecord[];
}

const FILE_NAME = 'session-state.json';
const MAX_ENTRIES = 256;

function statePath(rootDir: string): string {
  return path.join(rootDir, '.nexus', FILE_NAME);
}

function isTestRunRecord(v: unknown): v is TestRunRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.cmd === 'string'
    && typeof r.ts_ms === 'number'
    && typeof r.exit === 'number';
}

export function readSessionState(rootDir: string, sessionId: string): SessionState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath(rootDir), 'utf-8');
  } catch {
    return null;
  }
  let parsed: Partial<SessionState>;
  try {
    parsed = JSON.parse(raw) as Partial<SessionState>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.session_id !== 'string') return null;
  if (parsed.session_id !== sessionId) return null;
  return {
    session_id: parsed.session_id,
    started_at: typeof parsed.started_at === 'number' ? parsed.started_at : Date.now(),
    tests_run: Array.isArray(parsed.tests_run) ? parsed.tests_run.filter(isTestRunRecord) : [],
  };
}

export function hasTestRunThisSession(rootDir: string, sessionId: string): boolean {
  const s = readSessionState(rootDir, sessionId);
  return !!s && s.tests_run.length > 0;
}

export function appendTestRun(
  rootDir: string,
  sessionId: string,
  record: TestRunRecord,
): void {
  const dir = path.join(rootDir, '.nexus');
  fs.mkdirSync(dir, { recursive: true });

  let state: SessionState | null = readSessionState(rootDir, sessionId);
  if (!state) {
    state = { session_id: sessionId, started_at: Date.now(), tests_run: [] };
  }
  state.tests_run.push(record);
  if (state.tests_run.length > MAX_ENTRIES) {
    state.tests_run = state.tests_run.slice(state.tests_run.length - MAX_ENTRIES);
  }

  const real = statePath(rootDir);
  const tmp = `${real}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, real);
}
