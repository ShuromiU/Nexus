import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';

/**
 * Tree-sitter native bindings are loaded lazily so that consumers who
 * never parse source code (notably `nexus-policy-check`, which uses the
 * QueryEngine for SQL-only queries) don't pay the ~70-100 ms cold-start
 * cost of importing all grammar bindings.
 *
 * Both the host `tree-sitter` package and each grammar are CJS native
 * modules; we pull them in synchronously via `createRequire` only when a
 * caller actually asks for a parser.
 */

// Side-effect-free static knowledge: which logical names exist and which
// CJS package each one comes from. Loading these strings has no runtime cost.
const GRAMMAR_PACKAGES: Record<string, string> = {
  // typescript-family — the package exports both `typescript` and `tsx` keys.
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript',
  javascript: 'tree-sitter-typescript',
  jsx: 'tree-sitter-typescript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  csharp: 'tree-sitter-c-sharp',
  css: 'tree-sitter-css',
};

const requireCJS = createRequire(import.meta.url);

let cachedParserCtor: typeof Parser | null = null;
function loadParserCtor(): typeof Parser {
  if (cachedParserCtor) return cachedParserCtor;
  // tree-sitter exports the host binding as a default export under CJS.
  const mod = requireCJS('tree-sitter') as typeof Parser | { default: typeof Parser };
  cachedParserCtor = (mod as { default?: typeof Parser }).default ?? (mod as typeof Parser);
  return cachedParserCtor;
}

const grammarCache = new Map<string, unknown>();
function loadGrammar(grammarKey: string): unknown | null {
  if (grammarCache.has(grammarKey)) return grammarCache.get(grammarKey) ?? null;
  const pkg = GRAMMAR_PACKAGES[grammarKey];
  if (!pkg) return null;
  let mod: unknown;
  try {
    mod = requireCJS(pkg);
  } catch {
    return null;
  }
  // tree-sitter-typescript exports { typescript, tsx } as named keys; the rest
  // are the language object directly.
  let grammar: unknown;
  if (grammarKey === 'typescript' || grammarKey === 'javascript') {
    grammar = (mod as { typescript: unknown }).typescript;
  } else if (grammarKey === 'tsx' || grammarKey === 'jsx') {
    grammar = (mod as { tsx: unknown }).tsx;
  } else {
    grammar = mod;
  }
  if (!grammar) return null;
  grammarCache.set(grammarKey, grammar);
  return grammar;
}

/** Cached parser instances per grammar (avoid re-creating). */
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
    const grammar = loadGrammar(grammarKey);
    if (!grammar) return null;
    const ParserCtor = loadParserCtor();
    parser = new ParserCtor();
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
  if (language in GRAMMAR_PACKAGES) return language;

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
  if (language in GRAMMAR_PACKAGES) return language;
  return null;
}

/**
 * Check if a language has a tree-sitter grammar available.
 */
export function hasGrammar(language: string): boolean {
  return language in GRAMMAR_PACKAGES;
}

/**
 * Get the list of supported grammar names.
 */
export function supportedGrammars(): string[] {
  return Object.keys(GRAMMAR_PACKAGES);
}
