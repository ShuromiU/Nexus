# Nexus

Codebase index & query tool. One query replaces five searches.

Nexus uses [tree-sitter](https://tree-sitter.github.io/) to parse your codebase into a SQLite index of symbols, imports, exports, and cross-references. Query it via CLI or MCP server (for AI coding assistants like Claude Code).

## Install

```bash
npm install -g nexus-index
```

> **Requires native build tools** (tree-sitter uses C bindings):
> - **macOS:** `xcode-select --install`
> - **Linux:** `sudo apt install build-essential python3`
> - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++")

## Quick Start

```bash
cd your-project

# Build the index
nexus build

# Search for symbols
nexus search "UserProfile"
nexus search "drag drop handler"    # multi-word queries work

# Find a definition
nexus find useState --kind hook

# Find all references
nexus refs activeProjectId

# Who imports from a module?
nexus importers "@dnd-kit/core"
nexus importers react

# Explore structure
nexus tree src/components
nexus exports src/utils/helpers.ts
nexus symbols src/App.tsx

# Full index stats
nexus stats
```

## Claude Code Setup

Add to your global Claude settings (`~/.claude/settings.json`):

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

Or per-project in `.mcp.json`:

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

The MCP server auto-indexes on startup and exposes these tools:

| Tool | Purpose |
|------|---------|
| `nexus_find` | Find where a symbol is defined |
| `nexus_refs` | Find all occurrences of an identifier |
| `nexus_search` | Fuzzy search across symbols, paths, and docs |
| `nexus_exports` | List what a file exports |
| `nexus_imports` | List what a file imports |
| `nexus_importers` | Find all files that import from a source |
| `nexus_symbols` | List all symbols in a file |
| `nexus_tree` | Directory listing with symbol counts |
| `nexus_stats` | Index health and language stats |

## Supported Languages

| Language | Extensions | Definitions | Imports/Exports | References | Docstrings |
|----------|-----------|-------------|-----------------|------------|------------|
| TypeScript/JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mts` `.mjs` | Yes | Yes | Yes | Yes |
| Python | `.py` | Yes | Yes | Yes | Yes |
| Go | `.go` | Yes | Yes | Yes | Yes |
| Rust | `.rs` | Yes | Yes | Yes | Yes |
| Java | `.java` | Yes | Yes | Yes | Yes |
| C# | `.cs` | Yes | Yes | Yes | Yes |

## Configuration

Optional `.nexus.json` in your project root:

```json
{
  "exclude": ["vendor", "generated"],
  "maxFileSize": 1048576,
  "languages": {
    "custom": {
      "extensions": [".tsx"]
    }
  }
}
```

The index is stored in `.nexus/index.db` — add `.nexus/` to your `.gitignore`.

## How It Works

1. **Scan** — walks your project, respects `.gitignore` + custom excludes
2. **Parse** — tree-sitter AST for each file, extracts symbols/imports/exports/references
3. **Store** — SQLite with WAL mode for concurrent reads during reindex
4. **Query** — fuzzy search, cross-reference lookup, module graph traversal

Incremental updates only reparse changed files (detected via content hash + mtime).

## License

MIT
