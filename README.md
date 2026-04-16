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

Nexus is distributed three ways. Pick whichever fits your workflow:

```bash
# A. From npm (once published)
npm install -g nexus-index

# B. Direct from GitHub (no npm publish needed)
npm install -g github:ShuromiU/Nexus

# C. From a local clone (when developing Nexus itself)
git clone https://github.com/ShuromiU/Nexus.git
cd Nexus && npm install && npm run build && npm install -g .
```

> **Requires Node.js 18+** and native build tools (tree-sitter uses C bindings):
> - **macOS:** `xcode-select --install`
> - **Linux:** `sudo apt install build-essential python3`
> - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++")

Verify it works:

```bash
nexus --version
```

### Updating Nexus across machines

When you change Nexus and want every project on every machine to pick up the new tools:

| Distribution | Update flow |
|--------------|-------------|
| **npm publish** | Bump `version` in `package.json`, run `npm publish`, then on each machine `npm i -g nexus-index@latest`. |
| **GitHub install** | `git push` from the dev machine, then on each consuming machine `npm i -g github:ShuromiU/Nexus` again — npm re-fetches `HEAD`. |
| **Local clone** | `git pull && npm run build && npm install -g .` on each machine. |

Already-running MCP servers won't pick up the new code until they restart — quit and reopen Claude Code (or run `nexus reindex` via MCP if you only need a fresh index, not new tool definitions).

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

A full Nexus setup has three layers:

1. **MCP server** — exposes the tools to Claude Code
2. **PreToolUse hook** — denies Grep/Explore on code, forcing Nexus
3. **SessionStart hook** — keeps the index fresh on session start (optional)

You can ship just (1) and Claude will *be able* to use Nexus. You need (2) to make it *actually use* Nexus instead of falling back to Grep.

### 1. MCP server registration

**Global** — `~/.claude/settings.json`:

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

**Per-project** — `.mcp.json` in the project root (overrides global):

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

The MCP server runs `nexus build` on startup and re-checks freshness every 30 seconds.

### 2. PreToolUse hook — force Nexus before Grep

The repo ships a canonical hook at `hooks/nexus-first.sh` that:
- denies `Grep` on code files (markdown/json/config still allowed)
- denies `Explore` subagents whose prompt doesn't reference any `nexus_*` tool
- denies generic `Agent` spawns whose description and prompt don't reference Nexus

**Install:**

```bash
# 1. Copy the hook (and make it executable)
mkdir -p ~/.claude/hooks
cp hooks/nexus-first.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/nexus-first.sh

# 2. Make sure jq is on PATH (the hook uses jq to parse stdin)
#    macOS:   brew install jq
#    Linux:   sudo apt install jq
#    Windows: choco install jq   (or scoop install jq)
```

**Wire it up** in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Grep|Glob|Agent",
        "hooks": [
          { "type": "command",
            "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-first.sh'" }
        ]
      }
    ]
  }
}
```

**Disable temporarily:** `NEXUS_FIRST_DISABLED=1` in your shell.

When you add a new Nexus tool, update the `NEXUS_TOOLS_REGEX` constant inside `nexus-first.sh` — otherwise the hook will block agents that mention only the new tool name.

### 3. SessionStart hook — auto-build on session start (optional)

The MCP server already reindexes on startup, but if you want the project's index ready before the first MCP call, ship the included `hooks/session-start-build.sh`:

```bash
cp hooks/session-start-build.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/session-start-build.sh
```

In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command",
            "command": "bash ~/.claude/hooks/session-start-build.sh" }
        ]
      }
    ]
  }
}
```

The script reads `$CLAUDE_PROJECT_DIR` (set by Claude Code) and falls back to `$PWD`.

### MCP tools

Every tool accepts an optional `compact: true` flag that returns a minimal-key envelope (~50% smaller payload).

#### Discovery
| Tool | What it does | Example |
|------|--------------|---------|
| `nexus_find` | Find where a symbol is defined | `nexus_find("useState")` |
| `nexus_refs` | Find all occurrences of an identifier | `nexus_refs("activeProjectId")` |
| `nexus_search` | Fuzzy search across names + paths | `nexus_search("drag drop kanban")` |
| `nexus_grep` | Regex over indexed file contents | `nexus_grep("TODO|FIXME")` |
| `nexus_exports` | What a file exports | `nexus_exports("src/utils.ts")` |
| `nexus_imports` | What a file imports | `nexus_imports("src/App.tsx")` |
| `nexus_importers` | Inverse: who imports this module | `nexus_importers("react")` |
| `nexus_symbols` | All symbols in a file | `nexus_symbols("src/App.tsx")` |
| `nexus_tree` | Directory listing with symbol counts | `nexus_tree("src/components")` |
| `nexus_stats` | Index health + per-language stats | `nexus_stats()` |
| `nexus_reindex` | Trigger an incremental reindex | `nexus_reindex()` |

#### High-savings — collapse multi-call workflows
| Tool | What it does | Replaces |
|------|--------------|----------|
| `nexus_outline(file)` | Nested symbol tree + imports + exports for a file (or array of files) | Reading a file just to see its structure (~98% savings) |
| `nexus_source(name, file?)` | Just one symbol's source lines | Reading the whole file for one function |
| `nexus_slice(name, file?, limit?)` | A symbol + the source of symbols it references | "Find function then read each helper it calls" |
| `nexus_deps(file, direction?, depth?)` | Transitive import or importer tree | N chained `imports`/`importers` calls |

#### New token-savers
| Tool | What it does | Use case |
|------|--------------|----------|
| `nexus_callers(name, file?, depth?)` | Inverse of `slice`: who calls this, with snippets | "What breaks if I change X?" |
| `nexus_pack(query, budget_tokens?)` | Token-budget-aware bundle (outlines + sources up to N tokens) | "Give me just enough context to answer X within 4K tokens" |
| `nexus_changed(ref?)` | Files changed since `ref` (default `HEAD~1`) + their outlines | PR review without reading the diff |
| `nexus_diff_outline(ref_a, ref_b?)` | Semantic diff: added/removed/modified symbols between refs | Code review in one call |
| `nexus_signatures(names[])` | Batch signature + doc summary, no body | "Tell me the shape of these 10 functions" |
| `nexus_definition_at(file, line, col?)` | LSP-style go-to-definition | Click-to-definition while reading code |
| `nexus_unused_exports(path?)` | Exports with no importers and no external occurrences | Dead-code finder during refactor |
| `nexus_kind_index(kind, path?)` | Every symbol of one kind in a subtree | "Show me every React component in src/ui" |
| `nexus_doc(name)` | Just the docstring(s) | Avoid reading source bodies for the comment block |
| `nexus_batch(calls[])` | Multiple sub-tool calls in one MCP roundtrip | Saves protocol overhead for known sequences |

### Teaching your assistant to use Nexus

Add to your project's `CLAUDE.md`:

```markdown
## Nexus — Codebase Index (MCP)

Always prefer Nexus MCP tools over Grep/Glob/Read for code lookups.
Start with `nexus_outline` for structure, `nexus_search`/`nexus_find` for
discovery, `nexus_slice`/`nexus_callers`/`nexus_deps` for relationships,
and `nexus_source`/`nexus_pack` for actual code.

Pass `compact: true` to halve the payload.

Use Grep only for raw string literals, CSS values, comments, or content in
non-code files (markdown, JSON, config).
```

## Codex Setup

Codex can use Nexus as a global MCP server and can be taught the same "Nexus first" habit through `AGENTS.md`.

### Global MCP

Add Nexus to `~/.codex/config.toml`:

```toml
[mcp_servers.nexus]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\Claude Code\\Nexus\\dist\\transports\\cli.js", "serve"]
```

### Global Instructions

Create `~/.codex/AGENTS.md` with guidance like:

```markdown
- Use Nexus MCP tools (`nexus_outline`, `nexus_source`, `nexus_slice`, `nexus_deps`, `nexus_find`, `nexus_refs`, `nexus_search`) before `rg`, `grep`, or full-file reads for code lookup.
- Use `rg` only for raw literals, config files, markdown, or content Nexus does not index well.
```

If you want Codex to load existing Claude-style repo docs automatically, add this to `~/.codex/config.toml` too:

```toml
project_doc_fallback_filenames = ["CLAUDE.md", ".claude.local.md"]
project_doc_max_bytes = 65536
```

### Current Codex Limitation

Current Codex docs say `PreToolUse` and `PostToolUse` only emit `Bash`, and Codex hooks are currently disabled on Windows. That means Claude's hook-based "block Grep, force Nexus" behavior does not have exact native parity in Codex on Windows yet. The reliable Codex path today is:

- register Nexus as a global MCP server
- mark the server `required = true` and give it a longer startup timeout in `~/.codex/config.toml`
- on Windows, launch Codex through a small wrapper that runs `nexus build` before starting Codex
- load Codex instructions from `AGENTS.md`
- keep repo-level `AGENTS.md` or `CLAUDE.md` guidance concise and explicit

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
# Index lifecycle
nexus build                         Incremental update of the index
nexus rebuild                       Force a full reparse of every file
nexus repair                        Integrity check, rebuild if corrupt
nexus serve                         Start MCP server (stdio transport)

# Discovery
nexus find <name>                   Find where a symbol is defined
  -k, --kind <kind>                   Filter by kind (function, class, hook, …)
nexus refs <name>                   All occurrences of an identifier
nexus search <query>                Fuzzy search across symbol names
  -l, --limit <n>                     Max results (default 20)
  -p, --path <prefix>                 Path prefix filter
nexus grep <pattern>                Regex over indexed file contents
  -p, --path <prefix>                 Path prefix filter
  --lang <language>                   Language filter
  -l, --limit <n>                     Max results (default 50)
nexus exports <file>                List what a file exports
nexus imports <file>                List what a file imports
nexus importers <source>            Files importing from a source module
nexus symbols <file>                All symbols in a file
  -k, --kind <kind>                   Filter by kind
nexus tree [path]                   Files under a path + export summaries
nexus stats                         Index summary and health

# High-savings
nexus outline <files...>            Structural outline (one or many files)
nexus source <name>                 Just one symbol's source code
  -f, --file <file>                   Disambiguate
nexus slice <name>                  Symbol + the named symbols it references
  -f, --file <file>                   Disambiguate
  -l, --limit <n>                     Max referenced symbols (default 20)
nexus deps <file>                   Transitive imports/importers tree
  -d, --direction <dir>               imports | importers (default imports)
  --depth <n>                         Max depth 1-5 (default 2)

# New token-savers
nexus callers <name>                Functions/classes that call this symbol
  -f, --file <file>                   Disambiguate
  -d, --depth <n>                     Recursion depth 1-3 (default 1)
  -l, --limit <n>                     Max callers per level (default 30)
nexus pack <query>                  Token-budget context bundle
  -b, --budget <n>                    Token budget (default 4000)
  -p, --paths <a,b,c>                 Comma-separated path prefixes
nexus changed                       Files changed since a git ref + outlines
  -r, --ref <ref>                     Compare against (default HEAD~1)
nexus diff-outline <refA> [refB]    Semantic diff between two refs
nexus signatures <names...>         Batch signature lookup, no body
  -f, --file <file>                   Optional file scope
  -k, --kind <kind>                   Optional kind filter
nexus definition-at <file> <line> [col]   LSP-style go-to-definition
nexus unused-exports                Dead-code finder
  -p, --path <prefix>                 Path prefix to scope
  -l, --limit <n>                     Max results (default 100)
nexus kind-index <kind>             All symbols of a kind under a path
  -p, --path <prefix>                 Path prefix
  -l, --limit <n>                     Max results (default 200)
nexus doc <name>                    Just the docstring(s)
  -f, --file <file>                   Disambiguate
```

All new commands accept `--pretty` for indented JSON output.

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
