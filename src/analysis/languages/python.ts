import type Parser from 'tree-sitter';
import type { LanguageAdapter, ExtractionResult } from './registry.js';
import { registerAdapter } from './registry.js';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../../db/store.js';

type SymbolOut = Omit<SymbolRow, 'id' | 'file_id'>;
type EdgeOut = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;
type OccOut = Omit<OccurrenceRow, 'id' | 'file_id'>;

// ── Helpers ─────────────────────────────────────────────────────────────

function getDocstring(node: Parser.SyntaxNode): string | null {
  // Docstrings are the first statement in a block body — expression_statement > string
  const body = node.childForFieldName('body');
  if (!body) return null;

  const first = body.namedChild(0);
  if (first?.type === 'expression_statement') {
    const str = first.namedChild(0);
    if (str?.type === 'string') {
      return str.text;
    }
  }
  return null;
}

function getComment(node: Parser.SyntaxNode): string | null {
  const prev = node.previousSibling;
  if (prev?.type === 'comment') return prev.text;
  // Check for docstring above an expression_statement (module-level assignments)
  return null;
}

function getSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName('parameters');
  if (!params) return null;

  let sig = params.text;

  const ret = node.childForFieldName('return_type');
  if (ret) sig += ' -> ' + ret.text;

  return sig;
}

function buildContext(source: string, line: number): string {
  const lines = source.split('\n');
  if (line < 0 || line >= lines.length) return '';
  const lineText = lines[line].trim();
  return lineText.length > 200 ? lineText.slice(0, 200) : lineText;
}

// ── Symbol Extraction ───────────────────────────────────────────────────

function extractSymbols(root: Parser.SyntaxNode, source: string): SymbolOut[] {
  const symbols: SymbolOut[] = [];

  function visit(node: Parser.SyntaxNode, scope: string | null): void {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getSignature(node),
            scope,
            doc: getDocstring(node),
          });
        }
        break;
      }

      case 'class_definition': {
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
            doc: getDocstring(node),
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

      case 'decorated_definition': {
        // Visit the inner definition
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i)!;
          if (child.type !== 'decorator') {
            visit(child, scope);
          }
        }
        break;
      }

      case 'expression_statement': {
        // Module-level assignments: NAME = value
        const assignment = node.namedChild(0);
        if (assignment?.type === 'assignment' && scope === null) {
          const left = assignment.childForFieldName('left');
          if (left?.type === 'identifier') {
            const name = left.text;
            // SCREAMING_SNAKE → constant
            const kind = /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable';
            symbols.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              end_line: node.endPosition.row + 1,
              signature: null,
              scope,
              doc: getComment(node),
            });
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

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i)!;

    if (node.type === 'import_statement') {
      // import os / import json as j
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        if (nameNode.type === 'aliased_import') {
          const dotted = nameNode.namedChildren.find(c => c.type === 'dotted_name');
          const alias = nameNode.namedChildren.find(c => c.type === 'identifier');
          edges.push({
            kind: 'import',
            name: dotted?.text ?? null,
            alias: alias?.text ?? null,
            source: dotted?.text ?? null,
            line: node.startPosition.row + 1,
            is_default: false,
            is_star: false,
            is_type: false,
          });
        } else {
          edges.push({
            kind: 'import',
            name: nameNode.text,
            alias: null,
            source: nameNode.text,
            line: node.startPosition.row + 1,
            is_default: false,
            is_star: false,
            is_type: false,
          });
        }
      }
    } else if (node.type === 'import_from_statement') {
      // from X import Y, Z
      const moduleNode = node.childForFieldName('module_name');
      const source = moduleNode?.text ?? null;

      // Check for wildcard: from X import *
      let isStar = false;
      for (let j = 0; j < node.childCount; j++) {
        if (node.child(j)?.type === 'wildcard_import') {
          isStar = true;
          break;
        }
      }

      if (isStar) {
        edges.push({
          kind: 'import',
          name: null,
          alias: null,
          source,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: true,
          is_type: false,
        });
      } else {
        // Named imports
        for (let j = 0; j < node.namedChildCount; j++) {
          const child = node.namedChild(j)!;
          if (child.type === 'dotted_name') {
            // Skip the module_name field
            if (child === moduleNode) continue;
            edges.push({
              kind: 'import',
              name: child.text,
              alias: null,
              source,
              line: node.startPosition.row + 1,
              is_default: false,
              is_star: false,
              is_type: false,
            });
          } else if (child.type === 'aliased_import') {
            const dotted = child.namedChildren.find(c => c.type === 'dotted_name');
            const alias = child.namedChildren.find(c => c.type === 'identifier');
            edges.push({
              kind: 'import',
              name: dotted?.text ?? null,
              alias: alias?.text ?? null,
              source,
              line: node.startPosition.row + 1,
              is_default: false,
              is_star: false,
              is_type: false,
            });
          }
        }
      }
    }
  }

  // Python doesn't have explicit exports — all top-level names are implicitly exported
  // We treat public (non-underscore) top-level definitions as exports
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i)!;
    const names = getExportedNames(node);
    for (const name of names) {
      if (!name.startsWith('_')) {
        edges.push({
          kind: 'export',
          name,
          alias: null,
          source: null,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: false,
        });
      }
    }
  }

  return edges;
}

function getExportedNames(node: Parser.SyntaxNode): string[] {
  switch (node.type) {
    case 'function_definition': {
      const name = node.childForFieldName('name')?.text;
      return name ? [name] : [];
    }
    case 'class_definition': {
      const name = node.childForFieldName('name')?.text;
      return name ? [name] : [];
    }
    case 'decorated_definition': {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i)!;
        if (child.type !== 'decorator') return getExportedNames(child);
      }
      return [];
    }
    case 'expression_statement': {
      const assignment = node.namedChild(0);
      if (assignment?.type === 'assignment') {
        const left = assignment.childForFieldName('left');
        if (left?.type === 'identifier') return [left.text];
      }
      return [];
    }
    default:
      return [];
  }
}

// ── Occurrence Extraction ───────────────────────────────────────────────

const PYTHON_KEYWORDS = new Set([
  'True', 'False', 'None', 'self', 'cls',
  'if', 'else', 'elif', 'for', 'while', 'with', 'as',
  'try', 'except', 'finally', 'raise', 'assert',
  'return', 'yield', 'break', 'continue', 'pass',
  'import', 'from', 'def', 'class', 'lambda',
  'and', 'or', 'not', 'in', 'is', 'del', 'global', 'nonlocal',
  'async', 'await',
  'print', 'len', 'range', 'type', 'int', 'str', 'float', 'bool',
  'list', 'dict', 'set', 'tuple', 'object', 'super',
]);

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier') {
      const name = node.text;
      if (!PYTHON_KEYWORDS.has(name) && name.length > 1) {
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

// ── Adapter Registration ────────────────────────────────────────────────

const pythonAdapter: LanguageAdapter = {
  language: 'python',
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

registerAdapter(pythonAdapter);
