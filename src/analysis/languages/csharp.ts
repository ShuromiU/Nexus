import type Parser from 'tree-sitter';
import type { LanguageAdapter, ExtractionResult } from './registry.js';
import { registerAdapter } from './registry.js';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../../db/store.js';

type SymbolOut = Omit<SymbolRow, 'id' | 'file_id'>;
type EdgeOut = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;
type OccOut = Omit<OccurrenceRow, 'id' | 'file_id'>;

// ── Helpers ─────────────────────────────────────────────────────────────

function getDoc(node: Parser.SyntaxNode): string | null {
  // C# uses /// XML doc comments, which tree-sitter parses as regular comments
  const prev = node.previousSibling;
  if (prev?.type === 'comment') {
    const text = prev.text;
    if (text.startsWith('///') || text.startsWith('/**')) return text;
  }
  return null;
}

function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === 'modifier' && child.text === modifier) return true;
  }
  return false;
}

function getMethodSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName('parameters');
  if (!params) return null;
  return params.text;
}

function buildContext(lines: string[], line: number): string {
  if (line < 0 || line >= lines.length) return '';
  const lineText = lines[line].trim();
  return lineText.length > 200 ? lineText.slice(0, 200) : lineText;
}

// ── Symbol Extraction ───────────────────────────────────────────────────

function extractSymbols(root: Parser.SyntaxNode, source: string): SymbolOut[] {
  const symbols: SymbolOut[] = [];

  function visit(node: Parser.SyntaxNode, scope: string | null): void {
    switch (node.type) {
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
            doc: getDoc(node),
          });

          const body = node.namedChildren.find(c => c.type === 'declaration_list');
          if (body) {
            for (let i = 0; i < body.namedChildCount; i++) {
              visit(body.namedChild(i)!, nameNode.text);
            }
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
            doc: getDoc(node),
          });

          const body = node.namedChildren.find(c => c.type === 'declaration_list');
          if (body) {
            for (let i = 0; i < body.namedChildCount; i++) {
              visit(body.namedChild(i)!, nameNode.text);
            }
          }
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'enum',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'method',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getMethodSignature(node),
            scope,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'method',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getMethodSignature(node),
            scope,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'field_declaration': {
        // const fields → constants
        if (hasModifier(node, 'const')) {
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i)!;
            if (child.type === 'variable_declaration') {
              const declarator = child.namedChildren.find(c => c.type === 'variable_declarator');
              const nameNode = declarator?.childForFieldName('name') ?? child.childForFieldName('name');
              if (nameNode) {
                symbols.push({
                  name: nameNode.text,
                  kind: 'constant',
                  line: node.startPosition.row + 1,
                  col: node.startPosition.column,
                  end_line: node.endPosition.row + 1,
                  signature: null,
                  scope,
                  doc: getDoc(node),
                });
              }
            }
          }
        }
        break;
      }

      case 'property_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'variable',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'namespace_declaration': {
        const body = node.namedChildren.find(c => c.type === 'declaration_list');
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            visit(body.namedChild(i)!, scope);
          }
        }
        break;
      }

      case 'compilation_unit': {
        for (let i = 0; i < node.namedChildCount; i++) {
          visit(node.namedChild(i)!, scope);
        }
        break;
      }
    }
  }

  visit(root, null);
  return symbols;
}

// ── Module Edge Extraction ──────────────────────────────────────────────

function extractEdges(root: Parser.SyntaxNode, symbols: SymbolOut[]): EdgeOut[] {
  const edges: EdgeOut[] = [];

  function visitEdges(node: Parser.SyntaxNode): void {
    if (node.type === 'using_directive') {
      // using System; / using System.Collections.Generic;
      const nameNode = node.namedChildren.find(c =>
        c.type === 'identifier' || c.type === 'qualified_name',
      );
      if (nameNode) {
        const name = nameNode.type === 'qualified_name'
          ? nameNode.childForFieldName('name')?.text ?? null
          : nameNode.text;
        edges.push({
          kind: 'import',
          name,
          alias: null,
          source: nameNode.text,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: false,
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      visitEdges(node.namedChild(i)!);
    }
  }

  visitEdges(root);

  // C#: public symbols are exports
  for (const sym of symbols) {
    if (sym.scope === null) {
      // Top-level classes, interfaces, enums
      edges.push({
        kind: 'export',
        name: sym.name,
        alias: null,
        source: null,
        line: sym.line,
        is_default: false,
        is_star: false,
        is_type: sym.kind === 'interface',
      });
    }
  }

  return edges;
}

// ── Occurrence Extraction ───────────────────────────────────────────────

const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch',
  'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
  'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit',
  'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach',
  'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal',
  'is', 'lock', 'long', 'namespace', 'new', 'null', 'object',
  'operator', 'out', 'override', 'params', 'private', 'protected',
  'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
  'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
  'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void',
  'volatile', 'while', 'var', 'async', 'await', 'get', 'set', 'value',
  'Array', 'Console', 'Task',
]);

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier') {
      const name = node.text;
      if (!CSHARP_KEYWORDS.has(name) && name.length > 1) {
        const key = `${name}:${node.startPosition.row}:${node.startPosition.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          occurrences.push({
            name,
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            context: buildContext(lines, node.startPosition.row),
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

// ── Adapter Registration ────────────────────────────────────────────────

const csharpAdapter: LanguageAdapter = {
  language: 'csharp',
  capabilities: {
    definitions: true,
    imports: true,
    exports: true,
    occurrences: true,
    occurrenceQuality: 'heuristic',
    typeExports: false,
    docstrings: true,
    signatures: true,
    refKinds: [],
    relationKinds: [],
  },
  extract(tree: Parser.Tree, source: string, _filePath: string): ExtractionResult {
    const root = tree.rootNode;
    const symbols = extractSymbols(root, source);
    return {
      symbols,
      edges: extractEdges(root, symbols),
      occurrences: extractOccurrences(root, source),
      relations: [],
    };
  },
};

registerAdapter(csharpAdapter);
