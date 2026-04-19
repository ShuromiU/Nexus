// tests/fixtures/ref-kind-sample.ts
// Each identifier below is annotated with the expected ref_kind in a
// comment. The comments themselves are not parsed — the expected kinds
// are wired up in tests/ref-kind-precision.test.ts.

export const MAX = 10;            // MAX: declaration
export type Foo = { a: number };  // Foo: declaration

export function greet(name: string): string { // greet: declaration, name: declaration, string: type-ref
  return 'hi ' + name;             // name: read
}

export function main(): void {     // main: declaration
  let x: number = 0;               // x: declaration, number: type-ref
  x = x + MAX;                     // x (LHS): write, x (RHS): read, MAX: read
  greet('world');                  // greet: call
}

const obj: Foo = { a: 1 };         // obj: declaration, Foo: type-ref
obj.a = 2;                         // obj: read (member access base), a (property): write
