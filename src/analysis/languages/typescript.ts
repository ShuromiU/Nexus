import type Parser from 'tree-sitter';
import type { LanguageAdapter, ExtractionResult } from './registry.js';
import { registerAdapter } from './registry.js';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../../db/store.js';

type SymbolOut = Omit<SymbolRow, 'id' | 'file_id'>;
type EdgeOut = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;
type OccOut = Omit<OccurrenceRow, 'id' | 'file_id'>;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Get the JSDoc comment immediately preceding a node, if any.
 */
function getDoc(node: Parser.SyntaxNode): string | null {
  const prev = node.previousSibling;
  if (prev?.type === 'comment') {
    const text = prev.text;
    if (text.startsWith('/**')) {
      return text;
    }
  }
  return null;
}

/**
 * Extract a function/method signature from its parameters and return type.
 */
function getSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName('parameters');
  if (!params) return null;

  let sig = params.text;

  // Look for return type annotation
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'type_annotation') {
      sig += child.text;
      break;
    }
  }

  return sig;
}

/**
 * Build context string for an occurrence (surrounding line, capped 200 chars).
 */
function buildContext(source: string, line: number): string {
  const lines = source.split('\n');
  if (line < 0 || line >= lines.length) return '';
  const lineText = lines[line].trim();
  return lineText.length > 200 ? lineText.slice(0, 200) : lineText;
}

/**
 * Detect if a name looks like a React component (PascalCase).
 */
function isComponentName(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

/**
 * Detect if a name looks like a React hook (starts with "use").
 */
function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/**
 * Check if an arrow function or function expression contains JSX.
 */
function containsJsx(node: Parser.SyntaxNode): boolean {
  if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element' || node.type === 'jsx_fragment') {
    return true;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    if (containsJsx(node.namedChild(i)!)) return true;
  }
  return false;
}

/**
 * Unwrap a value node through call expressions like useCallback(...), useMemo(...), forwardRef(...)
 * to find the inner arrow function or function expression.
 * Returns the original node if no unwrapping is needed.
 */
function unwrapCallValue(node: Parser.SyntaxNode): Parser.SyntaxNode {
  if (node.type === 'call_expression') {
    const args = node.childForFieldName('arguments');
    if (args && args.namedChildCount > 0) {
      const firstArg = args.namedChild(0)!;
      if (firstArg.type === 'arrow_function' || firstArg.type === 'function_expression') {
        return firstArg;
      }
    }
  }
  return node;
}

/**
 * Extract identifiers from a destructuring pattern (array or object).
 */
function extractDestructuredNames(pattern: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  if (pattern.type === 'array_pattern') {
    for (let i = 0; i < pattern.namedChildCount; i++) {
      const el = pattern.namedChild(i)!;
      if (el.type === 'identifier') {
        names.push(el.text);
      } else if (el.type === 'assignment_pattern') {
        const left = el.childForFieldName('left');
        if (left?.type === 'identifier') names.push(left.text);
      } else if (el.type === 'array_pattern' || el.type === 'object_pattern') {
        names.push(...extractDestructuredNames(el));
      }
    }
  } else if (pattern.type === 'object_pattern') {
    for (let i = 0; i < pattern.namedChildCount; i++) {
      const prop = pattern.namedChild(i)!;
      if (prop.type === 'shorthand_property_identifier_pattern') {
        names.push(prop.text);
      } else if (prop.type === 'pair_pattern') {
        const valNode = prop.childForFieldName('value');
        if (valNode?.type === 'identifier') {
          names.push(valNode.text);
        } else if (valNode?.type === 'array_pattern' || valNode?.type === 'object_pattern') {
          names.push(...extractDestructuredNames(valNode));
        }
      } else if (prop.type === 'rest_pattern') {
        const inner = prop.namedChild(0);
        if (inner?.type === 'identifier') names.push(inner.text);
      }
    }
  }

  return names;
}

/**
 * Determine the kind of a const/let/var declaration.
 */
/**
 * Check if a value node resolves to a function (arrow, expression, or wrapped in a call/ternary).
 */
function resolvesFunctionValue(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const inner = unwrapCallValue(node);
  if (inner.type === 'arrow_function' || inner.type === 'function_expression') {
    return inner;
  }
  // Check ternary branches: const handler = cond ? () => a : () => b
  if (node.type === 'ternary_expression') {
    const consequent = node.childForFieldName('consequence');
    const alternate = node.childForFieldName('alternative');
    if (consequent) {
      const cInner = unwrapCallValue(consequent);
      if (cInner.type === 'arrow_function' || cInner.type === 'function_expression') return cInner;
    }
    if (alternate) {
      const aInner = unwrapCallValue(alternate);
      if (aInner.type === 'arrow_function' || aInner.type === 'function_expression') return aInner;
    }
  }
  return null;
}

function classifyVariable(
  name: string,
  declarator: Parser.SyntaxNode,
  declarationKind: string,
): string {
  const value = declarator.childForFieldName('value');

  if (value) {
    const fn = resolvesFunctionValue(value);
    if (fn) {
      if (isHookName(name)) return 'hook';
      if (isComponentName(name) && containsJsx(fn)) return 'component';
      return 'function';
    }
  }

  // SCREAMING_SNAKE or PascalCase const → constant
  if (declarationKind === 'const') {
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) return 'constant';
    return 'variable';
  }

  return 'variable';
}

// ── Symbol Extraction ───────────────────────────────────────────────────

function extractSymbols(root: Parser.SyntaxNode, source: string): SymbolOut[] {
  const symbols: SymbolOut[] = [];

  function visitAssignedValue(value: Parser.SyntaxNode, scopeName: string): void {
    switch (value.type) {
      case 'arrow_function':
      case 'function_expression':
      case 'generator_function':
      case 'class': {
        visit(value, scopeName);
        break;
      }
      case 'call_expression': {
        // Recurse into useCallback/useMemo/forwardRef etc. — first arg is often a function
        const inner = unwrapCallValue(value);
        if (inner !== value) {
          visit(inner, scopeName);
        }
        break;
      }
      case 'object': {
        // Extract methods and function-valued properties from object literals:
        // { onClick() {}, validate: (x) => x > 0 }
        for (let i = 0; i < value.namedChildCount; i++) {
          const child = value.namedChild(i)!;
          if (child.type === 'method_definition') {
            // Shorthand method: { onClick() {} }
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
              symbols.push({
                name: nameNode.text,
                kind: 'method',
                line: child.startPosition.row + 1,
                col: child.startPosition.column,
                end_line: child.endPosition.row + 1,
                signature: getSignature(child),
                scope: scopeName,
                doc: getDoc(child),
              });
            }
          } else if (child.type === 'pair') {
            // Key-value property: { validate: (x) => x > 0 }
            const keyNode = child.childForFieldName('key');
            const valNode = child.childForFieldName('value');
            if (keyNode && valNode) {
              const innerVal = unwrapCallValue(valNode);
              if (innerVal.type === 'arrow_function' || innerVal.type === 'function_expression') {
                symbols.push({
                  name: keyNode.text,
                  kind: 'function',
                  line: child.startPosition.row + 1,
                  col: child.startPosition.column,
                  end_line: child.endPosition.row + 1,
                  signature: getSignature(innerVal),
                  scope: scopeName,
                  doc: getDoc(child),
                });
              }
            }
          }
        }
        break;
      }
    }
  }

  function visit(node: Parser.SyntaxNode, scope: string | null): void {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          let kind: string = 'function';
          if (isHookName(name)) kind = 'hook';

          symbols.push({
            name,
            kind,
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getSignature(node),
            scope,
            doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
          });
        }
        // Visit nested functions
        const body = node.childForFieldName('body');
        if (body) {
          const nameText = node.childForFieldName('name')?.text ?? null;
          for (let i = 0; i < body.namedChildCount; i++) {
            visit(body.namedChild(i)!, nameText);
          }
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope,
            doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
          });

          // Visit class body for methods
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.namedChildCount; i++) {
              visit(body.namedChild(i)!, nameNode.text);
            }
          }
        }
        break;
      }

      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'method',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getSignature(node),
            scope,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'public_field_definition': {
        // Class fields: handleClick = () => {}, state = {}, etc.
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const value = node.childForFieldName('value');
          let kind: string = 'variable';
          let sig: string | null = null;

          if (value) {
            const inner = unwrapCallValue(value);
            if (inner.type === 'arrow_function' || inner.type === 'function_expression') {
              kind = isHookName(name) ? 'hook' : 'function';
              sig = getSignature(inner);
            } else if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
              kind = 'constant';
            }
          }

          symbols.push({
            name,
            kind,
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: sig,
            scope,
            doc: getDoc(node),
          });

          // Recurse into the value if it's a function
          if (value) {
            visitAssignedValue(value, name);
          }
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'interface',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope,
            doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
          });
        }
        break;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'type',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope,
            doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
          });
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const enumName = nameNode.text;
          symbols.push({
            name: enumName,
            kind: 'enum',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope,
            doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
          });

          // Extract enum members as scoped constants
          const body = node.childForFieldName('body');
          if (body) {
            for (let j = 0; j < body.namedChildCount; j++) {
              const member = body.namedChild(j)!;
              // enum_assignment (Name = value) or just property_identifier (Name)
              const memberName = member.type === 'enum_assignment'
                ? member.childForFieldName('name')
                : member.type === 'property_identifier' ? member : null;
              if (memberName) {
                symbols.push({
                  name: memberName.text,
                  kind: 'constant',
                  line: member.startPosition.row + 1,
                  col: member.startPosition.column,
                  end_line: member.endPosition.row + 1,
                  signature: null,
                  scope: enumName,
                  doc: getDoc(member),
                });
              }
            }
          }
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        const keyword = node.child(0)?.text ?? 'var'; // const, let, var
        for (let i = 0; i < node.namedChildCount; i++) {
          const declarator = node.namedChild(i)!;
          if (declarator.type !== 'variable_declarator') continue;

          const nameNode = declarator.childForFieldName('name');
          if (!nameNode) continue;

          // Handle destructured patterns: const [a, b] = ... / const { x, y } = ...
          if (nameNode.type === 'array_pattern' || nameNode.type === 'object_pattern') {
            const destructuredNames = extractDestructuredNames(nameNode);
            for (const dname of destructuredNames) {
              symbols.push({
                name: dname,
                kind: 'variable',
                line: nameNode.startPosition.row + 1,
                col: nameNode.startPosition.column,
                end_line: nameNode.endPosition.row + 1,
                signature: null,
                scope,
                doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
              });
            }
            continue;
          }

          if (nameNode.type !== 'identifier') continue;

          const name = nameNode.text;
          const kind = classifyVariable(name, declarator, keyword);

          const value = declarator.childForFieldName('value');
          let sig: string | null = null;
          if (value) {
            const fn = resolvesFunctionValue(value);
            if (fn) {
              sig = getSignature(fn);
            }
          }

          symbols.push({
            name,
            kind,
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: sig,
            scope,
            doc: getDoc(node.parent?.type === 'export_statement' ? node.parent : node),
          });

          if (value) {
            visitAssignedValue(value, name);
          }
        }
        break;
      }

      case 'export_statement': {
        // Dive into the declaration inside export
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i)!;
          // Skip export_clause, string (source) — those are edges
          if (child.type === 'export_clause' || child.type === 'string') continue;
          visit(child, scope);
        }
        break;
      }

      default: {
        // Recurse into top-level statements
        for (let i = 0; i < node.namedChildCount; i++) {
          visit(node.namedChild(i)!, scope);
        }
        break;
      }
    }
  }

  // Only visit top-level children of program
  for (let i = 0; i < root.namedChildCount; i++) {
    visit(root.namedChild(i)!, null);
  }

  return symbols;
}

// ── Module Edge Extraction ──────────────────────────────────────────────

function extractEdges(root: Parser.SyntaxNode): EdgeOut[] {
  const edges: EdgeOut[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i)!;

    if (node.type === 'import_statement') {
      extractImport(node, edges);
    } else if (node.type === 'export_statement') {
      extractExport(node, edges);
    }
  }

  // Walk full AST for dynamic import() and require() calls
  extractDynamicImportsAndRequires(root, edges);

  return edges;
}

/**
 * Walk the full AST to find dynamic import() and require() calls.
 *
 * Dynamic import: call_expression → import (keyword) + arguments → string → string_fragment
 * Require:        call_expression → identifier "require" + arguments → string → string_fragment
 */
function extractDynamicImportsAndRequires(node: Parser.SyntaxNode, edges: EdgeOut[]): void {
  if (node.type === 'call_expression') {
    const fn = node.firstChild;

    // Dynamic import(): import('./foo')
    if (fn?.type === 'import') {
      const source = extractCallSource(node);
      if (source) {
        edges.push({
          kind: 'dynamic-import',
          name: null,
          alias: null,
          source,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: false,
        });
      }
      return;
    }

    // require(): const x = require('./foo')
    if (fn?.type === 'identifier' && fn.text === 'require') {
      const source = extractCallSource(node);
      if (source) {
        edges.push({
          kind: 'require',
          name: null,
          alias: null,
          source,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: false,
        });
      }
      return;
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    extractDynamicImportsAndRequires(node.child(i)!, edges);
  }
}

/** Extract the string source from a call_expression's arguments. */
function extractCallSource(node: Parser.SyntaxNode): string | null {
  const args = node.namedChildren.find(c => c.type === 'arguments');
  const str = args?.namedChildren.find(c => c.type === 'string');
  return str?.namedChildren.find(c => c.type === 'string_fragment')?.text ?? null;
}

function extractImport(node: Parser.SyntaxNode, edges: EdgeOut[]): void {
  // Get source module
  const sourceNode = node.namedChildren.find(c => c.type === 'string');
  const source = sourceNode?.namedChildren.find(c => c.type === 'string_fragment')?.text ?? null;
  if (!source) return;

  // Check for top-level `import type`
  const isTypeImport = hasChildToken(node, 'type');

  const importClause = node.namedChildren.find(c => c.type === 'import_clause');
  if (!importClause) return;

  for (let i = 0; i < importClause.childCount; i++) {
    const child = importClause.child(i)!;

    if (child.type === 'identifier') {
      // Default import: import foo from '...'
      edges.push({
        kind: 'import',
        name: child.text,
        alias: null,
        source,
        line: node.startPosition.row + 1,
        is_default: true,
        is_star: false,
        is_type: isTypeImport,
      });
    } else if (child.type === 'namespace_import') {
      // Star import: import * as ns from '...'
      const ident = child.namedChildren.find(c => c.type === 'identifier');
      edges.push({
        kind: 'import',
        name: null,
        alias: ident?.text ?? null,
        source,
        line: node.startPosition.row + 1,
        is_default: false,
        is_star: true,
        is_type: isTypeImport,
      });
    } else if (child.type === 'named_imports') {
      // Named imports: import { a, b as c, type D } from '...'
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j)!;
        if (spec.type !== 'import_specifier') continue;

        const isSpecType = isTypeImport || hasChildToken(spec, 'type');
        const identifiers = spec.namedChildren.filter(c => c.type === 'identifier');

        if (identifiers.length === 2) {
          // aliased: import { foo as bar }
          edges.push({
            kind: 'import',
            name: identifiers[0].text,
            alias: identifiers[1].text,
            source,
            line: node.startPosition.row + 1,
            is_default: false,
            is_star: false,
            is_type: isSpecType,
          });
        } else if (identifiers.length === 1) {
          edges.push({
            kind: 'import',
            name: identifiers[0].text,
            alias: null,
            source,
            line: node.startPosition.row + 1,
            is_default: false,
            is_star: false,
            is_type: isSpecType,
          });
        }
      }
    }
  }
}

function extractExport(node: Parser.SyntaxNode, edges: EdgeOut[]): void {
  const isDefault = hasChildToken(node, 'default');
  const isTypeExport = hasChildToken(node, 'type') && !node.namedChildren.some(c =>
    c.type === 'type_alias_declaration' || c.type === 'interface_declaration',
  );

  // Check for re-export source
  const sourceNode = node.namedChildren.find(c => c.type === 'string');
  const source = sourceNode?.namedChildren.find(c => c.type === 'string_fragment')?.text ?? null;
  const kind = source ? 're-export' : 'export';

  // Star export: export * from '...'
  if (hasChildToken(node, '*') && source) {
    edges.push({
      kind: 're-export',
      name: null,
      alias: null,
      source,
      line: node.startPosition.row + 1,
      is_default: false,
      is_star: true,
      is_type: isTypeExport,
    });
    return;
  }

  // Export clause: export { a, b as c } or export { a } from '...'
  const exportClause = node.namedChildren.find(c => c.type === 'export_clause');
  if (exportClause) {
    for (let j = 0; j < exportClause.namedChildCount; j++) {
      const spec = exportClause.namedChild(j)!;
      if (spec.type !== 'export_specifier') continue;

      const identifiers = spec.namedChildren.filter(c => c.type === 'identifier');

      if (identifiers.length === 2) {
        edges.push({
          kind,
          name: identifiers[0].text,
          alias: identifiers[1].text,
          source,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: isTypeExport,
        });
      } else if (identifiers.length === 1) {
        edges.push({
          kind,
          name: identifiers[0].text,
          alias: null,
          source,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: isTypeExport,
        });
      }
    }
    return;
  }

  // Declaration export: export function/class/const/interface/type/enum
  const declaration = node.namedChildren.find(c =>
    c.type === 'function_declaration' ||
    c.type === 'class_declaration' ||
    c.type === 'lexical_declaration' ||
    c.type === 'variable_declaration' ||
    c.type === 'interface_declaration' ||
    c.type === 'type_alias_declaration' ||
    c.type === 'enum_declaration',
  );

  if (declaration) {
    const names = extractDeclaredNames(declaration);
    const isTypeDef = declaration.type === 'interface_declaration' || declaration.type === 'type_alias_declaration';
    for (const name of names) {
      edges.push({
        kind: 'export',
        name,
        alias: null,
        source: null,
        line: node.startPosition.row + 1,
        is_default: isDefault,
        is_star: false,
        is_type: isTypeDef,
      });
    }
    return;
  }

  // Default export of expression: export default <expr>
  if (isDefault) {
    edges.push({
      kind: 'export',
      name: null,
      alias: null,
      source: null,
      line: node.startPosition.row + 1,
      is_default: true,
      is_star: false,
      is_type: false,
    });
  }
}

/**
 * Extract declared names from a declaration node.
 */
function extractDeclaredNames(node: Parser.SyntaxNode): string[] {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return [nameNode.text];

  // lexical_declaration / variable_declaration can have multiple declarators
  const names: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === 'variable_declarator') {
      const name = child.childForFieldName('name');
      if (name?.type === 'identifier') {
        names.push(name.text);
      } else if (name?.type === 'array_pattern' || name?.type === 'object_pattern') {
        // Handle: export const { x, y } = obj; / export const [a, b] = arr;
        names.push(...extractDestructuredNames(name));
      }
    }
  }
  return names;
}

// ── Occurrence Extraction ───────────────────────────────────────────────

/** Keywords and built-ins that should not be recorded as occurrences */
const IGNORED_IDENTIFIERS = new Set([
  // JS keywords
  'true', 'false', 'null', 'undefined', 'this', 'super',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'return', 'throw', 'try', 'catch', 'finally',
  'new', 'delete', 'typeof', 'instanceof', 'void', 'in', 'of',
  'let', 'const', 'var', 'function', 'class', 'extends', 'implements',
  'import', 'export', 'default', 'from', 'as', 'async', 'await',
  'yield', 'static', 'get', 'set',
  // TS keywords
  'type', 'interface', 'enum', 'namespace', 'module', 'declare',
  'abstract', 'readonly', 'private', 'protected', 'public',
  'keyof', 'infer', 'is', 'asserts', 'satisfies',
  // Common built-ins
  'console', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Map', 'Set', 'Error', 'JSON', 'Math', 'Date',
  'RegExp', 'Symbol', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require',
]);

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>(); // Dedup: "name:line:col"

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
      const name = node.text;
      if (!IGNORED_IDENTIFIERS.has(name) && name.length > 1) {
        const key = `${name}:${node.startPosition.row}:${node.startPosition.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          occurrences.push({
            name,
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            context: buildContext(source, node.startPosition.row),
            confidence: 'heuristic',
          });
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }

  walk(root);
  return occurrences;
}

// ── Utility ─────────────────────────────────────────────────────────────

/**
 * Check if a node has a non-named child token with the given text.
 */
function hasChildToken(node: Parser.SyntaxNode, tokenText: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (!child.isNamed && child.text === tokenText) return true;
  }
  return false;
}

// ── Adapter Registration ────────────────────────────────────────────────

const typescriptAdapter: LanguageAdapter = {
  language: 'typescript',
  capabilities: {
    definitions: true,
    imports: true,
    exports: true,
    occurrences: true,
    occurrenceQuality: 'heuristic',
    typeExports: true,
    docstrings: true,
    signatures: true,
  },
  extract(tree: Parser.Tree, source: string, _filePath: string): ExtractionResult {
    const root = tree.rootNode;
    return {
      symbols: extractSymbols(root, source),
      edges: extractEdges(root),
      occurrences: extractOccurrences(root, source),
    };
  },
};

// Register for both typescript and javascript (same adapter, same AST patterns)
registerAdapter(typescriptAdapter);
registerAdapter({ ...typescriptAdapter, language: 'javascript' });
