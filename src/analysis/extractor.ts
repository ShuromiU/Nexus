import * as fs from 'node:fs';
import type Parser from 'tree-sitter';
import { getParser, resolveGrammar } from './parser.js';
import { getAdapter } from './languages/registry.js';
import type { ExtractionResult } from './languages/registry.js';

// Ensure all adapters are registered on import
import './languages/typescript.js';
import './languages/python.js';
import './languages/go.js';
import './languages/rust.js';
import './languages/java.js';
import './languages/csharp.js';

/**
 * Result of extracting a single file, including parse metadata.
 */
export interface FileExtractionResult extends ExtractionResult {
  /** Whether parsing succeeded */
  parsed: true;
}

/**
 * Error result when extraction fails.
 */
export interface FileExtractionError {
  parsed: false;
  error: string;
}

/**
 * Extract symbols, edges, and occurrences from a source file.
 *
 * @param absolutePath — Absolute path to the file on disk
 * @param relativePath — POSIX-relative path for display
 * @param language — Language name from the scanner (e.g., "typescript")
 */
export function extractFile(
  absolutePath: string,
  relativePath: string,
  language: string,
): FileExtractionResult | FileExtractionError {
  // Read source
  let source: string;
  try {
    source = fs.readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    return { parsed: false, error: `Failed to read file: ${(err as Error).message}` };
  }

  return extractSource(source, relativePath, language);
}

/**
 * Extract from source code string (useful for testing without disk I/O).
 */
export function extractSource(
  source: string,
  filePath: string,
  language: string,
): FileExtractionResult | FileExtractionError {
  // Resolve grammar
  const grammarKey = resolveGrammar(language, filePath);
  if (!grammarKey) {
    return { parsed: false, error: `No grammar available for language: ${language}` };
  }

  // Get parser
  const parser = getParser(grammarKey);
  if (!parser) {
    return { parsed: false, error: `Failed to create parser for grammar: ${grammarKey}` };
  }

  // Parse
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (err) {
    return { parsed: false, error: `Parse failed: ${(err as Error).message}` };
  }

  // Get adapter
  const adapter = getAdapter(language);
  if (!adapter) {
    return { parsed: false, error: `No adapter registered for language: ${language}` };
  }

  // Extract
  try {
    const result = adapter.extract(tree, source, filePath);
    return { parsed: true, ...result };
  } catch (err) {
    return { parsed: false, error: `Extraction failed: ${(err as Error).message}` };
  }
}
