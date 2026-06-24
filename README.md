# mnemo

Vendor-agnostic AI agent memory — MCP server backed by knowledge graph + RAG.

## Quick start

```sh
pnpm install
pnpm build
claude mcp add mnemo -- node packages/mcp-server/dist/index.js
```

## Storage

Memories are stored in `~/.mnemo/memory.db` (SQLite). Scoped by project path.

## Phase 1 tools (available now)

- `remember` — store a memory
- `recall` — search memories (BM25)
- `get_memory` — retrieve by ID with graph context
- `list_memories` — filtered list
- `get_status` — stats
- `forget` — expire a memory
- `link` — create graph relationships

## Skills

Install skills by copying `packages/skills/*/SKILL.md` to `~/.claude/skills/{name}/SKILL.md`.
