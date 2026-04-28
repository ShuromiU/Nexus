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
  if (prev?.type === 'comment') return prev.text;
  return null;
}

function buildContext(lines: string[], line: number): string {
  if (line < 0 || line >= lines.length) return '';
  const lineText = lines[line].trim();
  return lineText.length > 200 ? lineText.slice(0, 200) : lineText;
}

function getFuncSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName('parameters');
  const result = node.childForFieldName('result');
  if (!params) return null;

  let sig = params.text;
  if (result) sig += ' ' + result.text;
  return sig;
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// ── Symbol Extraction ───────────────────────────────────────────────────

function extractSymbols(root: Parser.SyntaxNode, source: string): SymbolOut[] {
  const symbols: SymbolOut[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i)!;

    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getFuncSignature(node),
            scope: null,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const receiver = node.namedChildren.find(c => c.type === 'parameter_list');
        let scope: string | null = null;
        if (receiver) {
          // Extract receiver type name
          const paramDecl = receiver.namedChildren.find(c => c.type === 'parameter_declaration');
          if (paramDecl) {
            const typeNode = paramDecl.namedChildren.find(c =>
              c.type === 'type_identifier' || c.type === 'pointer_type',
            );
            if (typeNode) {
              scope = typeNode.type === 'pointer_type'
                ? typeNode.namedChildren.find(c => c.type === 'type_identifier')?.text ?? null
                : typeNode.text;
            }
          }
        }

        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'method',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: getFuncSignature(node),
            scope,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'type_declaration': {
        for (let j = 0; j < node.namedChildCount; j++) {
          const spec = node.namedChild(j)!;
          if (spec.type !== 'type_spec') continue;

          const nameNode = spec.childForFieldName('name');
          if (!nameNode) continue;

          const typeBody = spec.namedChildren.find(c => c !== nameNode);
          let kind = 'type';
          if (typeBody?.type === 'struct_type') kind = 'class'; // struct → class
          else if (typeBody?.type === 'interface_type') kind = 'interface';

          symbols.push({
            name: nameNode.text,
            kind,
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
            end_line: node.endPosition.row + 1,
            signature: null,
            scope: null,
            doc: getDoc(node),
          });
        }
        break;
      }

      case 'const_declaration':
      case 'var_declaration': {
        for (let j = 0; j < node.namedChildCount; j++) {
          const spec = node.namedChild(j)!;
          if (spec.type !== 'const_spec' && spec.type !== 'var_spec') continue;

          const nameNode = spec.childForFieldName('name');
          if (!nameNode) continue;

          symbols.push({
            name: nameNode.text,
            kind: node.type === 'const_declaration' ? 'constant' : 'variable',
            line: spec.startPosition.row + 1,
            col: spec.startPosition.column,
            end_line: spec.endPosition.row + 1,
            signature: null,
            scope: null,
            doc: getDoc(node),
          });
        }
        break;
      }
    }
  }

  return symbols;
}

// ── Module Edge Extraction ──────────────────────────────────────────────

function extractEdges(root: Parser.SyntaxNode, symbols: SymbolOut[]): EdgeOut[] {
  const edges: EdgeOut[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i)!;

    if (node.type === 'import_declaration') {
      // Single import or import block
      const specList = node.namedChildren.find(c => c.type === 'import_spec_list');
      if (specList) {
        for (let j = 0; j < specList.namedChildCount; j++) {
          const spec = specList.namedChild(j)!;
          if (spec.type === 'import_spec') {
            extractImportSpec(spec, node.startPosition.row + 1, edges);
          }
        }
      } else {
        const spec = node.namedChildren.find(c => c.type === 'import_spec');
        if (spec) extractImportSpec(spec, node.startPosition.row + 1, edges);
      }
    }
  }

  // Go exports: capitalized names are exported
  for (const sym of symbols) {
    if (isExported(sym.name)) {
      edges.push({
        kind: 'export',
        name: sym.name,
        alias: null,
        source: null,
        line: sym.line,
        is_default: false,
        is_star: false,
        is_type: sym.kind === 'type' || sym.kind === 'interface',
      });
    }
  }

  return edges;
}

function extractImportSpec(spec: Parser.SyntaxNode, line: number, edges: EdgeOut[]): void {
  const pathNode = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
  const source = pathNode?.text.replace(/"/g, '') ?? null;
  const aliasNode = spec.childForFieldName('name');

  edges.push({
    kind: 'import',
    name: null,
    alias: aliasNode?.text ?? null,
    source,
    line,
    is_default: false,
    is_star: aliasNode?.text === '.' || false,
    is_type: false,
  });
}

// ── Occurrence Extraction ───────────────────────────────────────────────

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
  'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
  'interface', 'map', 'package', 'range', 'return', 'select', 'struct',
  'switch', 'type', 'var', 'nil', 'true', 'false', 'iota',
  'append', 'cap', 'close', 'copy', 'delete', 'len', 'make', 'new',
  'panic', 'print', 'println', 'recover',
  'string', 'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'complex64', 'complex128',
  'byte', 'rune', 'bool', 'error', 'any',
]);

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'field_identifier') {
      const name = node.text;
      if (!GO_KEYWORDS.has(name) && name.length > 1) {
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

const goAdapter: LanguageAdapter = {
  language: 'go',
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

registerAdapter(goAdapter);
