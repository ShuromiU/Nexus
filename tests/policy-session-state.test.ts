import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendTestRun,
  hasTestRunThisSession,
  readSessionState,
} from '../src/policy/session-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-d3-state-'));
});

describe('appendTestRun', () => {
  it('creates .nexus/session-state.json with one entry', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    const file = path.join(tmpDir, '.nexus', 'session-state.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.session_id).toBe('s1');
    expect(parsed.tests_run).toHaveLength(1);
    expect(parsed.tests_run[0].cmd).toBe('npm test');
  });

  it('appends entries in order for same session_id', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    appendTestRun(tmpDir, 's1', { cmd: 'pytest', ts_ms: 2000, exit: 0 });
    const state = readSessionState(tmpDir, 's1');
    expect(state?.tests_run.map(r => r.cmd)).toEqual(['npm test', 'pytest']);
  });

  it('rewrites file fresh when session_id differs', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    appendTestRun(tmpDir, 's2', { cmd: 'pytest', ts_ms: 2000, exit: 0 });
    const s1 = readSessionState(tmpDir, 's1');
    const s2 = readSessionState(tmpDir, 's2');
    expect(s1).toBeNull();
    expect(s2?.tests_run).toHaveLength(1);
    expect(s2?.tests_run[0].cmd).toBe('pytest');
  });

  it('caps at 256 entries (FIFO)', () => {
    for (let i = 0; i < 257; i++) {
      appendTestRun(tmpDir, 's1', { cmd: `cmd${i}`, ts_ms: i, exit: 0 });
    }
    const state = readSessionState(tmpDir, 's1');
    expect(state?.tests_run).toHaveLength(256);
    expect(state?.tests_run[0].cmd).toBe('cmd1');
    expect(state?.tests_run[255].cmd).toBe('cmd256');
  });

  it('creates .nexus/ directory when missing', () => {
    expect(fs.existsSync(path.join(tmpDir, '.nexus'))).toBe(false);
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    expect(fs.existsSync(path.join(tmpDir, '.nexus'))).toBe(true);
  });
});

describe('hasTestRunThisSession', () => {
  it('returns false when file does not exist', () => {
    expect(hasTestRunThisSession(tmpDir, 's1')).toBe(false);
  });

  it('returns true after a successful append', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    expect(hasTestRunThisSession(tmpDir, 's1')).toBe(true);
  });

  it('returns false for a different session_id', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    expect(hasTestRunThisSession(tmpDir, 's2')).toBe(false);
  });
});

describe('readSessionState', () => {
  it('returns null when file does not exist', () => {
    expect(readSessionState(tmpDir, 's1')).toBeNull();
  });

  it('returns null for corrupt JSON without deleting the file', () => {
    const dir = path.join(tmpDir, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session-state.json');
    fs.writeFileSync(file, '{ not json');
    expect(readSessionState(tmpDir, 's1')).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('returns null when session_id mismatches the stored file', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1000, exit: 0 });
    expect(readSessionState(tmpDir, 's2')).toBeNull();
  });

  it('drops malformed entries on read', () => {
    const dir = path.join(tmpDir, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session-state.json'),
      JSON.stringify({
        session_id: 's1',
        started_at: 1000,
        tests_run: [
          { cmd: 'npm test', ts_ms: 1, exit: 0 },
          { cmd: 'bad' /* missing fields */ },
          null,
          { cmd: 'pytest', ts_ms: 2, exit: 0 },
        ],
      }),
    );
    const state = readSessionState(tmpDir, 's1');
    expect(state?.tests_run.map(r => r.cmd)).toEqual(['npm test', 'pytest']);
  });
});

describe('concurrent writes', () => {
  it('atomic write: file is always parseable JSON', async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() =>
        appendTestRun(tmpDir, 's1', { cmd: `cmd${i}`, ts_ms: i, exit: 0 }),
      ),
    );
    await Promise.all(writes);
    const file = path.join(tmpDir, '.nexus', 'session-state.json');
    const raw = fs.readFileSync(file, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toBe('s1');
    expect(parsed.tests_run.length).toBeGreaterThanOrEqual(1);
    expect(parsed.tests_run.length).toBeLessThanOrEqual(10);
  });
});
