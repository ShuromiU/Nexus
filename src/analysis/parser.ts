import Parser from 'tree-sitter';
import treeSitterTS from 'tree-sitter-typescript';
import treeSitterPython from 'tree-sitter-python';
import treeSitterGo from 'tree-sitter-go';
import treeSitterRust from 'tree-sitter-rust';
import treeSitterJava from 'tree-sitter-java';
import treeSitterCSharp from 'tree-sitter-c-sharp';
import treeSitterCSS from 'tree-sitter-css';

const { typescript: tsLanguage, tsx: tsxLanguage } = treeSitterTS as {
  typescript: unknown;
  tsx: unknown;
};

/**
 * Grammar table: maps language names to tree-sitter Language objects.
 * setLanguage() accepts `any`, so we store as unknown and cast at use site.
 */
const GRAMMARS: Record<string, unknown> = {
  typescript: tsLanguage,
  tsx: tsxLanguage,
  javascript: tsLanguage, // JS is a subset of TS grammar
  jsx: tsxLanguage,       // JSX is a subset of TSX grammar
  python: treeSitterPython,
  go: treeSitterGo,
  rust: treeSitterRust,
  java: treeSitterJava,
  csharp: treeSitterCSharp,
  css: treeSitterCSS,
};

/** Cached parser instances per grammar (avoid re-creating) */
const parserCache = new Map<string, Parser>();

/**
 * Get a parser instance for the given language.
 * Parsers are cached and reused.
 */
export function getParser(language: string): Parser | null {
  // Map language variants to their grammar key
  const grammarKey = resolveGrammarKey(language);
  if (!grammarKey) return null;

  let parser = parserCache.get(grammarKey);
  if (!parser) {
    const grammar = GRAMMARS[grammarKey];
    if (!grammar) return null;
    parser = new Parser();
    parser.setLanguage(grammar as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    parserCache.set(grammarKey, parser);
  }
  return parser;
}

/**
 * Parse source code into a tree-sitter Tree.
 */
export function parseSource(source: string, language: string): Parser.Tree | null {
  const parser = getParser(language);
  if (!parser) return null;
  return parser.parse(source);
}

/**
 * Resolve a language name (e.g., "typescript") and file extension
 * to the appropriate grammar key.
 */
function resolveGrammarKey(language: string): string | null {
  // Direct match
  if (GRAMMARS[language]) return language;

  // TypeScript uses tsx grammar for .tsx files
  // The scanner assigns "typescript" for .ts/.tsx and "javascript" for .js/.jsx
  // but we need the right grammar variant
  return null;
}

/**
 * Resolve the correct grammar key based on language + file extension.
 * TSX/JSX files need the tsx grammar for JSX support.
 */
export function resolveGrammar(language: string, filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  if (language === 'typescript') {
    return ext === '.tsx' ? 'tsx' : 'typescript';
  }
  if (language === 'javascript') {
    return ext === '.jsx' ? 'jsx' : 'javascript';
  }

  // Variant mappings
  if (language === 'typescriptreact') return 'tsx';
  if (language === 'javascriptreact') return 'jsx';

  // Other languages — direct lookup
  if (GRAMMARS[language]) return language;
  return null;
}

/**
 * Check if a language has a tree-sitter grammar available.
 */
export function hasGrammar(language: string): boolean {
  return language in GRAMMARS;
}

/**
 * Get the list of supported grammar names.
 */
export function supportedGrammars(): string[] {
  return Object.keys(GRAMMARS);
}
