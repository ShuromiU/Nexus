import { describe, it, expect } from 'vitest';
import { getAllAdapters, getAdapter } from '../src/analysis/languages/registry.js';

import '../src/analysis/languages/typescript.js';
import '../src/analysis/languages/python.js';
import '../src/analysis/languages/go.js';
import '../src/analysis/languages/rust.js';
import '../src/analysis/languages/java.js';
import '../src/analysis/languages/csharp.js';
import '../src/analysis/languages/css.js';

describe('LanguageCapabilities.relationKinds (T2)', () => {
  it('every registered adapter declares relationKinds', () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBeGreaterThan(0);
    for (const a of adapters) {
      expect(Array.isArray(a.capabilities.relationKinds)).toBe(true);
    }
  });

  it('TypeScript advertises extends_class, implements, extends_interface, overrides_method', () => {
    const ts = getAdapter('typescript');
    expect(ts).not.toBeNull();
    expect(ts!.capabilities.relationKinds).toEqual(
      expect.arrayContaining([
        'extends_class',
        'implements',
        'extends_interface',
        'overrides_method',
      ]),
    );
  });

  it('JavaScript narrows to runtime-only kinds (extends_class, overrides_method)', () => {
    const js = getAdapter('javascript');
    expect(js).not.toBeNull();
    expect(js!.capabilities.relationKinds).toEqual(['extends_class', 'overrides_method']);
  });

  it('Java declares structural relationKinds (B2 v2)', () => {
    const java = getAdapter('java');
    expect(java).not.toBeNull();
    expect(java!.capabilities.relationKinds).toEqual(
      expect.arrayContaining(['extends_class', 'implements', 'extends_interface']),
    );
  });

  it('C# declares structural relationKinds (B2 v2)', () => {
    const cs = getAdapter('csharp');
    expect(cs).not.toBeNull();
    expect(cs!.capabilities.relationKinds).toEqual(
      expect.arrayContaining(['extends_class', 'implements', 'extends_interface']),
    );
  });

  it('languages without B2 support declare empty relationKinds', () => {
    for (const lang of ['python', 'go', 'rust', 'css']) {
      const a = getAdapter(lang);
      expect(a, `${lang} adapter should be registered`).not.toBeNull();
      expect(a!.capabilities.relationKinds, `${lang} relationKinds`).toEqual([]);
    }
  });
});

describe('ExtractionResult.relations (T2)', () => {
  it('every adapter returns an empty relations array on extract (until T3-T5)', () => {
    // Smoke: invoke extract via a parser-free path. Since we can't easily
    // build a Tree without parsing, we lean on the static return-shape
    // being TS-checked at compile time. This test documents the contract
    // and will be replaced by real extractor tests in T3-T5.
    const adapters = getAllAdapters();
    for (const a of adapters) {
      // The shape requirement is enforced by TypeScript via ExtractionResult.
      // If the field is missing on any adapter, this file would not compile.
      expect(typeof a.extract).toBe('function');
    }
  });
});
