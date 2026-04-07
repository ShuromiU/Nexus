import type Parser from 'tree-sitter';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../../db/store.js';

/**
 * What a language adapter can extract.
 */
export interface LanguageCapabilities {
  definitions: true; // always true
  imports: boolean;
  exports: boolean;
  occurrences: boolean;
  occurrenceQuality: 'exact' | 'heuristic';
  typeExports: boolean;
  docstrings: boolean;
  signatures: boolean;
}

/**
 * Result of extracting data from a single file.
 * file_id is left as 0 — the orchestrator fills it in after DB insert.
 */
export interface ExtractionResult {
  symbols: Omit<SymbolRow, 'id' | 'file_id'>[];
  edges: Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>[];
  occurrences: Omit<OccurrenceRow, 'id' | 'file_id'>[];
}

/**
 * A language adapter extracts symbols, module edges, and occurrences
 * from a tree-sitter AST for a specific language.
 */
export interface LanguageAdapter {
  /** Language name (must match scanner's language assignment) */
  language: string;
  /** What this adapter can extract */
  capabilities: LanguageCapabilities;
  /** Extract everything from a parsed AST */
  extract(tree: Parser.Tree, source: string, filePath: string): ExtractionResult;
}

/** Registry of all language adapters */
const adapters = new Map<string, LanguageAdapter>();

/**
 * Register a language adapter.
 */
export function registerAdapter(adapter: LanguageAdapter): void {
  adapters.set(adapter.language, adapter);
}

/**
 * Get the adapter for a language.
 */
export function getAdapter(language: string): LanguageAdapter | null {
  return adapters.get(language) ?? null;
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): LanguageAdapter[] {
  return Array.from(adapters.values());
}

/**
 * Check if a language has a registered adapter.
 */
export function hasAdapter(language: string): boolean {
  return adapters.has(language);
}
