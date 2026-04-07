# Nexus

**Codebase index for AI coding assistants.** One query replaces five searches.

Nexus parses your entire codebase into a local SQLite database of symbols, imports, exports, and cross-references. Instead of AI assistants burning tokens on blind file searches (`grep`, `find`, `cat`), they query a pre-built index and get precise answers in under 50ms.

Built for [Claude Code](https://claude.ai/claude-code). Works with any MCP-compatible assistant.

## Why

AI coding assistants waste significant time and tokens exploring codebases. A typical investigation — "find where this function is defined, who calls it, what it imports" — takes 5-10 tool calls with grep and file reads. Nexus answers that in one call.

**Without Nexus:**
```
grep → read file → grep again → read another file → grep again → finally found it
```

**With Nexus:**
```
nexus_refs("activeProjectId") → 102 occurrences across 15 files, instantly
```

## Install

```bash
npm install -g nexus-index
```

> **Requires Node.js 18+** and native build tools (tree-sitter uses C bindings):
> - **macOS:** `xcode-select --install`
> - **Linux:** `sudo apt install build-essential python3`
> - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++")

Verify it works:

```bash
nexus --version
```

## Quick Start

```bash
cd your-project

# Build the index (first run: full parse, ~8 seconds for 300 files)
nexus build

# Search for symbols (supports multi-word and fuzzy matching)
nexus search "UserProfile"
nexus search "drag drop handler"

# Find a definition
nexus find useState --kind hook

# Find all references across the codebase
nexus refs activeProjectId

# Who imports from this module?
nexus importers react
nexus importers "./utils"

# Explore project structure
nexus tree src/components
nexus exports src/utils/helpers.ts
nexus symbols src/App.tsx --kind function

# Check index health
nexus stats
```

## How It Works

### The Indexing Pipeline

```
Source files  →  tree-sitter parser  →  AST  →  language adapter  →  SQLite database
```

**1. Scan** — Nexus walks your project directory, respecting `.gitignore` and any custom excludes. It detects each file's language by extension (`.ts` → TypeScript, `.py` → Python, `.go` → Go, etc.). Skips `node_modules`, `dist`, `.git`, binary files, and minified code automatically.

**2. Parse** — Each file is parsed by [tree-sitter](https://tree-sitter.github.io/), the same parser used by GitHub and Neovim. This produces a full Abstract Syntax Tree — a structured representation of the code, not just text matching.

**3. Extract** — A language-specific adapter walks the AST and pulls out:
- **Symbols** — every function, class, type, variable, interface, with name, location, signature, and docstring
- **Imports/Exports** — what each file imports from where, what it exports
- **References** — every place an identifier appears (not just where it's defined)

**4. Store** — Everything goes into `.nexus/index.db`, a single SQLite file in your project. Uses WAL mode for concurrent read access during reindex.

### When Does It Index?

| Trigger | What happens |
|---------|-------------|
| `nexus build` | Incremental update — only reparses changed files |
| `nexus rebuild` | Full reparse of everything |
| MCP server startup | Auto-runs incremental build before accepting queries |

**There is no background daemon.** Nexus indexes on demand — when you run `build` or when the MCP server starts. In practice, the MCP server re-indexes every time Claude Code opens a session, so the index is always fresh at the start of a conversation.

**Incremental updates are fast.** After the first full build, subsequent runs detect changes via content hash and file modification time. Only changed files are reparsed. A no-changes rebuild on a 300-file project takes ~130ms.

### What Gets Stored

```
.nexus/
  index.db          ← SQLite database (add .nexus/ to .gitignore)
```

The database contains:
- **Files table** — path, language, content hash, index timestamp
- **Symbols table** — name, kind (function/class/type/...), location, signature, docstring, scope
- **Module edges** — imports, exports, re-exports with source module and flags
- **Occurrences** — every identifier usage with file, line, column, and context
- **Index runs** — history of build operations for diagnostics

### Invalidation

Nexus automatically triggers a full rebuild when:
- The schema version changes (after a Nexus update)
- The extractor version changes (parser logic improved)
- The `.nexus.json` config changes
- The project root directory changes

Otherwise, incremental builds handle the rest.

## Claude Code Setup

### Global (all projects)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "nexus": {
      "command": "nexus",
      "args": ["serve"]
    }
  }
}
```

### Per-project

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "nexus": {
      "command": "nexus",
      "args": ["serve"]
    }
  }
}
```

The MCP server indexes your project on startup, then exposes these tools:

| Tool | What it does | Example |
|------|-------------|---------|
| `nexus_find` | Find where a symbol is defined | `nexus_find("useState")` |
| `nexus_refs` | Find all occurrences of an identifier | `nexus_refs("activeProjectId")` → 102 hits |
| `nexus_search` | Fuzzy search across names, paths, docs | `nexus_search("drag drop kanban")` |
| `nexus_exports` | List what a file exports | `nexus_exports("src/utils.ts")` |
| `nexus_imports` | List what a file imports | `nexus_imports("src/App.tsx")` |
| `nexus_importers` | Find all files importing from a module | `nexus_importers("react")` |
| `nexus_symbols` | List all symbols in a file | `nexus_symbols("src/App.tsx")` |
| `nexus_tree` | Directory listing with symbol counts | `nexus_tree("src/components")` |
| `nexus_stats` | Index health and language stats | `nexus_stats()` |

### Teaching your assistant to use Nexus

Add this to your project's `CLAUDE.md` (or equivalent):

```markdown
## Nexus — Codebase Index (MCP)

Use Nexus MCP tools (`nexus_search`, `nexus_find`, `nexus_refs`) BEFORE
Grep or Glob for code symbol lookups. Nexus is faster and returns structured
results with file paths, line numbers, and context.

When Grep is still appropriate: raw string literals, CSS values, regex
patterns, or content in non-code files (markdown, JSON, config).
```

## Supported Languages

| Language | Extensions | Symbols | Imports/Exports | References | Docstrings | Signatures |
|----------|-----------|---------|-----------------|------------|------------|------------|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | Yes | Yes | Yes | Yes | Yes |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | Yes | Yes | Yes | Yes | Yes |
| Python | `.py` | Yes | Yes | Yes | Yes | Yes |
| Go | `.go` | Yes | Yes | Yes | Yes | Yes |
| Rust | `.rs` | Yes | Yes | Yes | Yes | Yes |
| Java | `.java` | Yes | Yes | Yes | Yes | Yes |
| C# | `.cs` | Yes | Yes | Yes | Yes | Yes |

More languages can be added via the adapter system. Each adapter is a self-contained module that maps tree-sitter AST nodes to Nexus symbol kinds.

## Configuration

Optional `.nexus.json` in your project root:

```json
{
  "exclude": ["vendor", "generated", "*.test.ts"],
  "maxFileSize": 1048576,
  "minifiedLineLength": 500,
  "languages": {
    "custom-lang": {
      "extensions": [".custom"]
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `exclude` | `[]` | Additional glob patterns to ignore (on top of `.gitignore`) |
| `maxFileSize` | `1048576` (1MB) | Skip files larger than this |
| `minifiedLineLength` | `500` | Skip files with lines longer than this (minified code) |
| `languages` | `{}` | Map additional extensions to language names |

## CLI Reference

```
nexus build              Build or update the index (incremental)
nexus rebuild            Force a full index rebuild
nexus find <name>        Find where a symbol is defined
  -k, --kind <kind>      Filter by kind (function, class, type, hook, etc.)
nexus refs <name>        Find all occurrences of an identifier
nexus search <query>     Fuzzy search across symbols
  -l, --limit <n>        Max results (default: 20)
nexus exports <file>     List what a file exports
nexus imports <file>     List what a file imports
nexus importers <source> Find all files importing from a source module
nexus symbols <file>     List all symbols in a file
  -k, --kind <kind>      Filter by kind
nexus tree [path]        List files under a path with export summaries
nexus stats              Show index summary and health
nexus repair             Check integrity, rebuild if corrupt
nexus serve              Start MCP server (stdio transport)
```

## Architecture

```
nexus/
  src/
    analysis/
      languages/       ← Language adapters (one per language)
        typescript.ts      Extracts from TS/JS AST
        python.ts          Extracts from Python AST
        go.ts, rust.ts, java.ts, csharp.ts
        registry.ts        Adapter registration system
      parser.ts          Tree-sitter grammar loading
      extractor.ts       Orchestrates parse → extract per file
    db/
      schema.ts          SQLite schema + version constants
      store.ts           All database read/write operations
      integrity.ts       Corruption detection + repair
    index/
      orchestrator.ts    Two-phase indexing (scan+parse → atomic publish)
      state.ts           Concurrency lock (prevents parallel rebuilds)
    query/
      engine.ts          All query operations (find, refs, search, etc.)
      ranking.ts         Fuzzy matching + relevance scoring
    workspace/
      scanner.ts         File discovery + language detection
      changes.ts         Change detection (hash + mtime)
      detector.ts        Project root detection
      ignores.ts         .gitignore + custom exclude handling
    transports/
      cli.ts             CLI interface (commander)
      mcp.ts             MCP server (stdio transport)
```

## License

MIT
