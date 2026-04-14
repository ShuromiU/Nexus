# Nexus

## Working Rules

- Use Nexus MCP tools for code search and structure lookup before `rg`, `grep`, or full-file reads.
- Prefer `nexus_outline` for file structure, `nexus_source` for single symbols, `nexus_slice` for symbol-plus-dependencies, and `nexus_deps` for import trees.
- Treat raw shell/code search as fallback, not first choice.
- Keep MCP tools and CLI behavior aligned when adding or changing query capabilities.

## Repo Priorities

- Preserve the two-phase indexing model and short publish lock window.
- Keep schema changes intentional: version bumps in `src/db/schema.ts` trigger rebuilds.
- Maintain strict TypeScript typing and prepared-statement SQL patterns.

## Verification

- Run `npm run build`.
- Run `npm run test`.
- Run `npm run lint`.
