import { describe, it, expect } from 'vitest';
import { parsePackageLock } from '../src/analysis/documents/package-lock.js';

describe('parsePackageLock', () => {
  it('parses lockfileVersion 3 (packages map)', () => {
    const src = JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/react': { version: '18.2.0' },
        'node_modules/@scope/pkg': { version: '0.3.1' },
        'node_modules/nested/node_modules/lodash': { version: '4.17.21' },
      },
    });
    const r = parsePackageLock(src);
    expect('error' in r).toBe(false);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: '@scope/pkg', version: '0.3.1' },
      { name: 'lodash', version: '4.17.21' },
    ]));
    expect(r.entries.find(e => e.name === 'root')).toBeUndefined();
  });

  it('falls back to lockfileVersion 1 (dependencies tree)', () => {
    const src = JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 1,
      dependencies: {
        react: { version: '17.0.2' },
        lodash: {
          version: '4.17.21',
          dependencies: {
            '@scope/nested': { version: '0.1.0' },
          },
        },
      },
    });
    const r = parsePackageLock(src);
    if ('error' in r) throw new Error('unreachable');
    const names = r.entries.map(e => `${e.name}@${e.version}`);
    expect(names).toEqual(expect.arrayContaining([
      'react@17.0.2',
      'lodash@4.17.21',
      '@scope/nested@0.1.0',
    ]));
  });

  it('returns { error } on invalid JSON', () => {
    const r = parsePackageLock('{not-json');
    expect('error' in r).toBe(true);
  });

  it('returns { error } when root is not an object', () => {
    const r = parsePackageLock('[]');
    expect('error' in r).toBe(true);
  });

  it('returns empty entries when neither packages nor dependencies exist', () => {
    const r = parsePackageLock('{}');
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([]);
  });
});
