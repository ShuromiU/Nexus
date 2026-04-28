import { describe, it, expect } from 'vitest';
import { getAdapter } from '../src/analysis/languages/registry.js';
import { getParser } from '../src/analysis/parser.js';

import '../src/analysis/languages/typescript.js';

function extractRelations(src: string) {
  const parser = getParser('typescript');
  const tree = parser.parse(src);
  const adapter = getAdapter('typescript')!;
  return adapter.extract(tree, src, 'test.ts').relations;
}

describe('TypeScript relation_edges extractor — extends_class (T3)', () => {
  it('plain class extends', () => {
    const r = extractRelations('class A {}\nclass B extends A {}');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: 'extends_class',
      target_name: 'A',
      confidence: 'declared',
      line: 2,
    });
  });

  it('strips generic type arguments', () => {
    const r = extractRelations('class B extends Base<T> {}');
    expect(r).toHaveLength(1);
    expect(r[0].target_name).toBe('Base');
  });

  it('preserves member-expression target (ns.Base)', () => {
    const r = extractRelations('class B extends ns.Base {}');
    expect(r).toHaveLength(1);
    expect(r[0].target_name).toBe('ns.Base');
  });

  it('emits textual target for mixin call expression', () => {
    const r = extractRelations('class B extends Mixin(Base) {}');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('extends_class');
    expect(r[0].target_name).toBe('Mixin(Base)');
  });

  it('handles abstract_class_declaration', () => {
    const r = extractRelations('abstract class B extends Base {}');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'extends_class', target_name: 'Base' });
  });

  it('emits no relation rows for class with no extends', () => {
    const r = extractRelations('class A {}');
    expect(r).toHaveLength(0);
  });

  it('source_symbol_index points at the declaring class', () => {
    const src = 'class A {}\nclass B {}\nclass C extends A {}';
    const parser = getParser('typescript');
    const tree = parser.parse(src);
    const adapter = getAdapter('typescript')!;
    const result = adapter.extract(tree, src, 'test.ts');
    const cIdx = result.symbols.findIndex(s => s.name === 'C' && s.kind === 'class');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].source_symbol_index).toBe(cIdx);
  });
});

describe('TypeScript relation_edges extractor — implements (T4)', () => {
  it('class with single implements', () => {
    const r = extractRelations('class B implements IUser {}');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'implements', target_name: 'IUser' });
  });

  it('class with multiple implements', () => {
    const r = extractRelations('class B implements IUser, IAdmin, IGuest {}');
    expect(r).toHaveLength(3);
    expect(r.map(x => x.target_name).sort()).toEqual(['IAdmin', 'IGuest', 'IUser']);
    expect(r.every(x => x.kind === 'implements')).toBe(true);
  });

  it('class with both extends and implements', () => {
    const r = extractRelations('class B extends Base implements IUser, IAdmin {}');
    const exts = r.filter(x => x.kind === 'extends_class');
    const impls = r.filter(x => x.kind === 'implements');
    expect(exts).toHaveLength(1);
    expect(exts[0].target_name).toBe('Base');
    expect(impls).toHaveLength(2);
  });

  it('strips generic args on implements targets', () => {
    const r = extractRelations('class B implements IRepo<User> {}');
    expect(r).toHaveLength(1);
    expect(r[0].target_name).toBe('IRepo');
  });
});

describe('TypeScript relation_edges extractor — extends_interface (T5)', () => {
  it('interface with single extends', () => {
    const r = extractRelations('interface A extends B {}');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'extends_interface', target_name: 'B' });
  });

  it('interface with multiple extends', () => {
    const r = extractRelations('interface A extends B, C, D {}');
    expect(r).toHaveLength(3);
    expect(r.map(x => x.target_name).sort()).toEqual(['B', 'C', 'D']);
    expect(r.every(x => x.kind === 'extends_interface')).toBe(true);
  });

  it('interface with no extends emits nothing', () => {
    const r = extractRelations('interface A {}');
    expect(r).toHaveLength(0);
  });

  it('strips generic args on interface extends', () => {
    const r = extractRelations('interface A extends Base<T> {}');
    expect(r).toHaveLength(1);
    expect(r[0].target_name).toBe('Base');
  });

  it('class extends and interface extends do not cross-pollute kinds', () => {
    const src = 'class C extends Base {}\ninterface I extends J {}';
    const r = extractRelations(src);
    expect(r).toHaveLength(2);
    const c = r.find(x => x.target_name === 'Base')!;
    const i = r.find(x => x.target_name === 'J')!;
    expect(c.kind).toBe('extends_class');
    expect(i.kind).toBe('extends_interface');
  });
});

describe('TypeScript relation_edges extractor — combined fixtures', () => {
  it('mixed file with classes and interfaces', () => {
    const src = `
      interface IUser { id: string }
      interface IAdmin extends IUser { role: string }
      class Base {}
      class User extends Base implements IUser {
        constructor(public id: string) {}
      }
      class Admin extends User implements IAdmin {
        constructor(id: string, public role: string) { super(id); }
      }
    `;
    const r = extractRelations(src);
    const groups = {
      extends_class: r.filter(x => x.kind === 'extends_class').map(x => x.target_name).sort(),
      implements: r.filter(x => x.kind === 'implements').map(x => x.target_name).sort(),
      extends_interface: r.filter(x => x.kind === 'extends_interface').map(x => x.target_name).sort(),
    };
    expect(groups.extends_class).toEqual(['Base', 'User']);
    expect(groups.implements).toEqual(['IAdmin', 'IUser']);
    expect(groups.extends_interface).toEqual(['IUser']);
  });

  it('every relation references a symbol in the same ExtractionResult', () => {
    const src = 'class A {}\nclass B extends A {}\ninterface I extends J {}';
    const parser = getParser('typescript');
    const tree = parser.parse(src);
    const adapter = getAdapter('typescript')!;
    const result = adapter.extract(tree, src, 'test.ts');
    for (const rel of result.relations) {
      expect(rel.source_symbol_index).toBeGreaterThanOrEqual(0);
      expect(rel.source_symbol_index).toBeLessThan(result.symbols.length);
    }
  });
});
