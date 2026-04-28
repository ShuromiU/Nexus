import type Parser from 'tree-sitter';
import type { LanguageAdapter, ExtractionResult } from './registry.js';
import { registerAdapter } from './registry.js';
import type { SymbolRow, OccurrenceRow } from '../../db/store.js';

type SymbolOut = Omit<SymbolRow, 'id' | 'file_id'>;
type OccOut = Omit<OccurrenceRow, 'id' | 'file_id'>;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Get the CSS comment immediately preceding a node, if any.
 */
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

/**
 * Extract the full text of a selector from a rule_set's selectors child.
 * Examples: ":root", "[data-theme=\"dark\"]", ".card", "#app"
 */
function getSelectorText(ruleSet: Parser.SyntaxNode): string {
  for (let i = 0; i < ruleSet.childCount; i++) {
    const child = ruleSet.child(i)!;
    if (child.type === 'selectors') {
      return child.text.trim();
    }
  }
  return '';
}

/**
 * Get the block child of a rule_set, keyframes_statement, media_statement, etc.
 */
function getBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'block' || child.type === 'keyframe_block_list') {
      return child;
    }
  }
  return null;
}

/**
 * Extract the value text from a declaration (everything between : and ;).
 */
function getDeclarationValue(decl: Parser.SyntaxNode): string {
  const parts: string[] = [];
  let pastColon = false;
  for (let i = 0; i < decl.childCount; i++) {
    const child = decl.child(i)!;
    if (child.type === ':') {
      pastColon = true;
      continue;
    }
    if (child.type === ';') break;
    if (pastColon) parts.push(child.text);
  }
  return parts.join(' ').trim();
}

// ── Symbol Extraction ───────────────────────────────────────────────────

function extractSymbols(root: Parser.SyntaxNode, source: string): SymbolOut[] {
  const symbols: SymbolOut[] = [];

  function walkRuleSet(node: Parser.SyntaxNode, parentScope: string): void {
    const selector = getSelectorText(node);
    const scope = parentScope ? `${parentScope} > ${selector}` : selector;

    // Emit the selector itself as a symbol
    if (selector) {
      symbols.push({
        name: selector,
        kind: 'selector',
        line: node.startPosition.row + 1,
        col: node.startPosition.column,
        end_line: node.endPosition.row + 1,
        signature: null,
        scope: parentScope || null,
        doc: getDoc(node),
      });
    }

    // Walk declarations inside the block
    const block = getBlock(node);
    if (block) {
      for (let i = 0; i < block.childCount; i++) {
        const child = block.child(i)!;

        if (child.type === 'declaration') {
          const propNode = child.namedChildren.find(c => c.type === 'property_name');
          if (propNode && propNode.text.startsWith('--')) {
            const value = getDeclarationValue(child);
            symbols.push({
              name: propNode.text,
              kind: 'variable',
              line: child.startPosition.row + 1,
              col: child.startPosition.column,
              end_line: child.endPosition.row + 1,
              signature: `${propNode.text}: ${value}`,
              scope,
              doc: getDoc(child),
            });
          }
        }

        // Handle nested rule_sets (CSS nesting)
        if (child.type === 'rule_set') {
          walkRuleSet(child, scope);
        }
      }
    }
  }

  function walkMediaStatement(node: Parser.SyntaxNode): void {
    // Build the @media query text from everything before the block
    const parts: string[] = ['@media'];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === 'block') break;
      if (child.type !== '@media') parts.push(child.text);
    }
    const mediaQuery = parts.join(' ').trim();

    symbols.push({
      name: mediaQuery,
      kind: 'media',
      line: node.startPosition.row + 1,
      col: node.startPosition.column,
      end_line: node.endPosition.row + 1,
      signature: mediaQuery,
      scope: null,
      doc: getDoc(node),
    });

    // Walk rule_sets inside the @media block
    const block = getBlock(node);
    if (block) {
      for (let i = 0; i < block.childCount; i++) {
        const child = block.child(i)!;
        if (child.type === 'rule_set') {
          walkRuleSet(child, mediaQuery);
        }
      }
    }
  }

  function walkKeyframesStatement(node: Parser.SyntaxNode): void {
    const nameNode = node.namedChildren.find(c => c.type === 'keyframes_name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'keyframes',
        line: node.startPosition.row + 1,
        col: node.startPosition.column,
        end_line: node.endPosition.row + 1,
        signature: `@keyframes ${nameNode.text}`,
        scope: null,
        doc: getDoc(node),
      });
    }
  }

  // Walk top-level nodes
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!;

    switch (node.type) {
      case 'rule_set':
        walkRuleSet(node, '');
        break;
      case 'media_statement':
        walkMediaStatement(node);
        break;
      case 'keyframes_statement':
        walkKeyframesStatement(node);
        break;
    }
  }

  return symbols;
}

// ── Occurrence Extraction ───────────────────────────────────────────────

function extractOccurrences(root: Parser.SyntaxNode, source: string): OccOut[] {
  const occurrences: OccOut[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');

  function walk(node: Parser.SyntaxNode): void {
    // Track var() references to CSS custom properties
    if (node.type === 'call_expression') {
      const funcName = node.namedChildren.find(c => c.type === 'function_name');
      if (funcName?.text === 'var') {
        const args = node.namedChildren.find(c => c.type === 'arguments');
        if (args) {
          const varRef = args.namedChildren.find(c => c.type === 'plain_value');
          if (varRef && varRef.text.startsWith('--')) {
            const key = `${varRef.text}:${node.startPosition.row}:${node.startPosition.column}`;
            if (!seen.has(key)) {
              seen.add(key);
              occurrences.push({
                name: varRef.text,
                line: node.startPosition.row + 1,
                col: node.startPosition.column,
                context: buildContext(lines, node.startPosition.row),
                confidence: 'exact',
              });
            }
          }
        }
      }
    }

    // Also track property_name occurrences for custom properties (definitions are also references)
    if (node.type === 'property_name' && node.text.startsWith('--')) {
      const key = `${node.text}:${node.startPosition.row}:${node.startPosition.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        occurrences.push({
          name: node.text,
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
          context: buildContext(lines, node.startPosition.row),
          confidence: 'exact',
        });
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

const cssAdapter: LanguageAdapter = {
  language: 'css',
  capabilities: {
    definitions: true,
    imports: false,
    exports: false,
    occurrences: true,
    occurrenceQuality: 'exact',
    typeExports: false,
    docstrings: false,
    signatures: true,
    refKinds: [],
    relationKinds: [],
  },
  extract(tree: Parser.Tree, source: string, _filePath: string): ExtractionResult {
    const root = tree.rootNode;
    return {
      symbols: extractSymbols(root, source),
      edges: [],
      occurrences: extractOccurrences(root, source),
      relations: [],
    };
  },
};

registerAdapter(cssAdapter);
