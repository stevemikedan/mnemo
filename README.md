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

## MCP tools

Read / search:
- `recall` — hybrid search (BM25 + optional vector), scope/type/tag/state/importance filters
- `get_memory` — retrieve by ID with graph neighborhood
- `list_memories` — filtered list (exact scope)
- `list_scopes` — discover the exact scope strings in the store
- `get_status` — stats
- `get_dream_log` — recent consolidation runs

Write:
- `remember` — store a memory
- `update` — edit content/type/scope/state/importance/tags
- `forget` — expire a memory (soft delete)
- `delete_memory` — permanently delete a memory + its edges
- `link` / `unlink` — add / remove graph relationships

Consolidation:
- `dream` — NREM dedup + REM linking + decay + reconcile (+ embedding encode)
- `consolidate_session` — extract memories from a transcript

## Embeddings (optional)

Hybrid semantic recall turns on when an embedding provider is set in
`~/.mnemo/config.json`, then a `dream` encodes memories. Providers: `local`
(built-in hashing, no deps), `astermind` (on-device TF-IDF, no deps), `ollama`,
or `openai` (also works with Gemini's OpenAI-compatible endpoint). Restart the
server after changing config.

## Skills

Install skills by copying `packages/skills/*/SKILL.md` to `~/.claude/skills/{name}/SKILL.md`.
