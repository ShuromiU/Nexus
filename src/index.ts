export { openDatabase, applySchema, initializeMeta, SCHEMA_VERSION, EXTRACTOR_VERSION } from './db/schema.js';
export { NexusStore } from './db/store.js';
export type { FileRow, SymbolRow, ModuleEdgeRow, OccurrenceRow, IndexRunRow } from './db/store.js';
export { quickCheck, fullIntegrityCheck, openWithIntegrityCheck, repair } from './db/integrity.js';
export { IndexLock } from './index/state.js';

// Workspace
export { loadConfig, computeConfigHash } from './config.js';
export type { NexusConfig } from './config.js';
export { detectRoot, detectCaseSensitivity, getGitHead } from './workspace/detector.js';
export { buildIgnoreMatcher } from './workspace/ignores.js';
export type { IgnoreMatcher } from './workspace/ignores.js';
export { scanDirectory, buildExtraExtensions } from './workspace/scanner.js';
export type { ScannedFile, ScanOptions } from './workspace/scanner.js';
export { detectChanges, hashFile, summarizeChanges } from './workspace/changes.js';
export type { FileChange } from './workspace/changes.js';

// Analysis
export { getParser, parseSource, resolveGrammar, hasGrammar, supportedGrammars } from './analysis/parser.js';
export { registerAdapter, getAdapter, getAllAdapters, hasAdapter } from './analysis/languages/registry.js';
export type { LanguageCapabilities, LanguageAdapter, ExtractionResult } from './analysis/languages/registry.js';
export { extractFile, extractSource } from './analysis/extractor.js';
export type { FileExtractionResult, FileExtractionError } from './analysis/extractor.js';
// Side-effect: register all language adapters
import './analysis/languages/typescript.js';
import './analysis/languages/python.js';
import './analysis/languages/go.js';
import './analysis/languages/rust.js';
import './analysis/languages/java.js';
import './analysis/languages/csharp.js';

// Index orchestrator
export { runIndex } from './index/orchestrator.js';
export type { IndexResult } from './index/orchestrator.js';

// Query engine
export { QueryEngine } from './query/engine.js';
export type {
  NexusResult, SymbolResult, OccurrenceResult,
  ModuleEdgeResult, ImporterResult, GrepResult, TreeEntry, IndexStats,
  OutlineEntry, OutlineResult, SourceResult, DepNode, DepsResult,
} from './query/engine.js';
export { fuzzyScore, rankResults } from './query/ranking.js';
export type { FuzzyMatch } from './query/ranking.js';

// CLI (formatters only — program creation is in transports/cli.ts)
export {
  formatSymbols, formatOccurrences, formatEdges, formatTree, formatGrepResults, formatStats,
  formatOutline, formatSource, formatDeps,
} from './transports/cli.js';

// MCP server
export { createMcpServer, startServer } from './transports/mcp.js';
