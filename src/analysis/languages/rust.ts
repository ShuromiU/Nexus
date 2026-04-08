import type Parser from 'tree-sitter';
import type { LanguageAdapter, ExtractionResult } from './registry.js';
import { registerAdapter } from './registry.js';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../../db/store.js';

type SymbolOut = Omit<SymbolRow, 'id' | 'file_id'>;
type EdgeOut = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;
type OccOut = Omit<OccurrenceRow, 'id' | 'file_id'>;

// ── Helpers ─────────────────────────────────────────────────────────────

function getDoc(node: Parser.SyntaxNode): string | null {
  // Walk backwards through siblings to find doc comments,
  // skipping attribute items (#[derive(...)]) that may sit between doc and definition
  let prev: Parser.SyntaxNode | null = node.previousSibling;
  while (prev) {
    if (prev.type === 'line_comment') {
      const text = prev.text;
      if (text.startsWith('///') || text.startsWith('//!')) return text;
      break;
    }
    if (prev.type === 'block_comment') {
      if (prev.text.startsWith('/**')) return prev.text;
      break;
    }
    // Skip attribute items between doc and definition
    if (prev.type === 'attribute_item') {
      prev = prev.previousSibling;
      continue;
    }
    break;
  }
  return null;
}

function isPublic(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)!.type === 'visibility_modifier') return true;
  }
  return false;
}

function getSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName('parameters');
  const ret = node.childForFieldName('return_type');
  if (!params) return null;

  let sig = params.text;
  if (ret) sig += ' -> ' + ret.text;
  return sig;
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
      case 'function_item':
      case 'function_signature_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: scope ? 'method' : 'function',
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

      case 'struct_item': {
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
        }
        break;
      }

      case 'enum_item': {
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

      case 'trait_item': {
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

          // Visit trait body for method signatures
          const body = node.childForFieldName('body') ?? node.namedChildren.find(c => c.type === 'declaration_list');
          if (body) {
            for (let i = 0; i < body.namedChildCount; i++) {
              visit(body.namedChild(i)!, nameNode.text);
            }
          }
        }
        break;
      }

      case 'impl_item': {
        // impl Type { ... } or impl Trait for Type { ... }
        const typeIdents = node.namedChildren.filter(c => c.type === 'type_identifier');
        const implScope = typeIdents.length > 0 ? typeIdents[typeIdents.length - 1].text : null;

        const body = node.namedChildren.find(c => c.type === 'declaration_list');
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            visit(body.namedChild(i)!, implScope);
          }
        }
        break;
      }

      case 'const_item': {
        const nameNode = node.childForFieldName('name');
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
        break;
      }

      case 'static_item': {
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

      case 'type_item': {
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
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'mod_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          // Visit mod body
          const body = node.namedChildren.find(c => c.type === 'declaration_list');
          if (body) {
            for (let i = 0; i < body.namedChildCount; i++) {
              visit(body.namedChild(i)!, nameNode.text);
            }
          }
        }
        break;
      }
    }
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    visit(root.namedChild(i)!, null);
  }

  return symbols;
}

// ── Module Edge Extraction ──────────────────────────────────────────────

function extractEdges(root: Parser.SyntaxNode): EdgeOut[] {
  const edges: EdgeOut[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'use_declaration') {
      // use std::fmt; / use std::collections::HashMap;
      const pathNode = node.namedChildren.find(c =>
        c.type === 'scoped_identifier' || c.type === 'identifier' || c.type === 'use_list' || c.type === 'scoped_use_list',
      );
      if (pathNode) {
        extractUse(pathNode, node.startPosition.row + 1, edges);
      }
    }

    // Check for pub items → exports
    if (isPublic(node)) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isTypeDef = node.type === 'struct_item' || node.type === 'enum_item'
          || node.type === 'trait_item' || node.type === 'type_item';
        edges.push({
          kind: 'export',
          name: nameNode.text,
          alias: null,
          source: null,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: isTypeDef,
        });
      }
    }
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    visit(root.namedChild(i)!);
  }

  return edges;
}

function extractUse(node: Parser.SyntaxNode, line: number, edges: EdgeOut[]): void {
  if (node.type === 'scoped_identifier') {
    const name = node.childForFieldName('name')?.text ?? null;
    edges.push({
      kind: 'import',
      name,
      alias: null,
      source: node.text,
      line,
      is_default: false,
      is_star: false,
      is_type: false,
    });
  } else if (node.type === 'identifier') {
    edges.push({
      kind: 'import',
      name: node.text,
      alias: null,
      source: node.text,
      line,
      is_default: false,
      is_star: false,
      is_type: false,
    });
  }
}

// ── Occurrence Extraction ───────────────────────────────────────────────

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
  'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
  'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
  'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
  'unsafe', 'use', 'where', 'while', 'yield',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64', 'bool', 'char', 'str',
  'Vec', 'Box', 'String', 'Option', 'Some', 'None', 'Ok', 'Err',
]);

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'field_identifier') {
      const name = node.text;
      if (!RUST_KEYWORDS.has(name) && name.length > 1) {
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

const rustAdapter: LanguageAdapter = {
  language: 'rust',
  capabilities: {
    definitions: true,
    imports: true,
    exports: true,
    occurrences: true,
    occurrenceQuality: 'heuristic',
    typeExports: false,
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

registerAdapter(rustAdapter);
