import { describe, it, expect } from 'vitest';
import { parsePackageLock } from '../src/analysis/documents/package-lock.js';
import { parsePnpmLock } from '../src/analysis/documents/pnpm-lock.js';

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

describe('parsePnpmLock', () => {
  it('parses pnpm v6/v9 packages keys (/name@version)', () => {
    const src = `lockfileVersion: '9.0'
packages:
  /react@18.2.0:
    resolution: { integrity: sha512-foo }
  /@scope/pkg@0.3.1:
    resolution: { integrity: sha512-bar }
  /lodash@4.17.21:
    resolution: { integrity: sha512-baz }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: '@scope/pkg', version: '0.3.1' },
      { name: 'lodash', version: '4.17.21' },
    ]));
  });

  it('parses legacy pnpm keys (/name/version)', () => {
    const src = `lockfileVersion: '5.4'
packages:
  /react/18.2.0:
    resolution: { integrity: sha512-foo }
  /@scope/pkg/0.3.1:
    resolution: { integrity: sha512-bar }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: '@scope/pkg', version: '0.3.1' },
    ]));
  });

  it('strips peer-dependency suffixes from keys', () => {
    const src = `lockfileVersion: '9.0'
packages:
  /react-dom@18.2.0(react@18.2.0):
    resolution: { integrity: sha512-foo }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([{ name: 'react-dom', version: '18.2.0' }]);
  });

  it('returns { error } on invalid YAML', () => {
    const r = parsePnpmLock(':::not: valid: yaml: :');
    expect('error' in r).toBe(true);
  });

  it('returns empty entries when packages is absent', () => {
    const r = parsePnpmLock("lockfileVersion: '9.0'\n");
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([]);
  });

  it('handles git-URL versions (first @ wins)', () => {
    const src = `lockfileVersion: '9.0'
packages:
  /foo@git+ssh://git@github.com/x/y.git:
    resolution: { integrity: sha512-foo }
  /@scope/bar@git+ssh://git@host/y.git:
    resolution: { integrity: sha512-bar }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'foo', version: 'git+ssh://git@github.com/x/y.git' },
      { name: '@scope/bar', version: 'git+ssh://git@host/y.git' },
    ]));
  });

  it('returns { error } when YAML root is not an object', () => {
    const r = parsePnpmLock('just-a-string\n');
    expect('error' in r).toBe(true);
  });
});
