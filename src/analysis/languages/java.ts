import type Parser from 'tree-sitter';
import type { LanguageAdapter, ExtractionResult } from './registry.js';
import { registerAdapter } from './registry.js';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../../db/store.js';

type SymbolOut = Omit<SymbolRow, 'id' | 'file_id'>;
type EdgeOut = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;
type OccOut = Omit<OccurrenceRow, 'id' | 'file_id'>;

// ── Helpers ─────────────────────────────────────────────────────────────

function getDoc(node: Parser.SyntaxNode): string | null {
  const prev = node.previousSibling;
  if (prev?.type === 'block_comment' && prev.text.startsWith('/**')) return prev.text;
  if (prev?.type === 'line_comment') return prev.text;
  return null;
}

function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  const mods = node.namedChildren.find(c => c.type === 'modifiers');
  if (!mods) return false;
  for (let i = 0; i < mods.childCount; i++) {
    if (mods.child(i)?.text === modifier) return true;
  }
  return false;
}

function getMethodSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName('parameters');
  if (!params) return null;
  return params.text;
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

          const body = node.childForFieldName('body');
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

          const body = node.childForFieldName('body');
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
        // Static final fields → constants
        if (hasModifier(node, 'static') && hasModifier(node, 'final')) {
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i)!;
            if (child.type === 'variable_declarator') {
              const nameNode = child.childForFieldName('name');
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

      case 'program': {
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

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i)!;

    if (node.type === 'import_declaration') {
      const pathNode = node.namedChildren.find(c => c.type === 'scoped_identifier');
      if (pathNode) {
        const name = pathNode.childForFieldName('name')?.text ?? null;
        edges.push({
          kind: 'import',
          name,
          alias: null,
          source: pathNode.text,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: false,
          is_type: false,
        });
      }

      // Wildcard import: import java.util.*
      const asterisk = node.namedChildren.find(c => c.type === 'asterisk');
      if (asterisk) {
        const scope = node.namedChildren.find(c => c.type === 'scoped_identifier');
        edges.push({
          kind: 'import',
          name: null,
          alias: null,
          source: scope?.text ?? null,
          line: node.startPosition.row + 1,
          is_default: false,
          is_star: true,
          is_type: false,
        });
      }
    }
  }

  // Java: public symbols are exported
  for (const sym of symbols) {
    // We mark top-level public symbols as exports
    if (sym.scope === null) {
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

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch',
  'char', 'class', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'final', 'finally', 'float', 'for',
  'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while',
  'true', 'false', 'null',
  'String', 'Object', 'Integer', 'Boolean', 'System', 'Override',
]);

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier' || node.type === 'type_identifier') {
      const name = node.text;
      if (!JAVA_KEYWORDS.has(name) && name.length > 1) {
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

const javaAdapter: LanguageAdapter = {
  language: 'java',
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
    const symbols = extractSymbols(root, source);
    return {
      symbols,
      edges: extractEdges(root, symbols),
      occurrences: extractOccurrences(root, source),
    };
  },
};

registerAdapter(javaAdapter);
