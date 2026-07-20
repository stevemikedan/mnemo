# mnemo

Vendor-agnostic AI agent memory — MCP server backed by knowledge graph + RAG, with on-device ML that learns from use.

## Quick start

```sh
pnpm install
pnpm build
claude mcp add mnemo -- node packages/mcp-server/dist/index.js
```

## Storage

Memories are stored in `~/.mnemo/memory.db` (SQLite). Scoped by project path.
Destructive consolidation mutations (merges, supersessions) snapshot the
before-state to `dream_audit` for hand recovery.

## MCP tools

Read / search:
- `recall` — hybrid search (BM25 + vector + learned reranker), scope/type/tag/state/importance filters; superseded facts excluded by default
- `ask_memory` — plain-language question → short answer grounded only in stored memories, with sources; known contradictions are presented from both sides
- `get_memory` — retrieve by ID with graph neighborhood
- `list_memories` — filtered list (exact scope)
- `list_scopes` — discover the exact scope strings in the store
- `get_status` — stats
- `get_dream_log` — recent consolidation runs

Write:
- `remember` — store a memory (ELM type suggestion + KNN tag suggestion + near-duplicate warning when enabled)
- `record_use` — mark a recalled memory as actually used (trains the reranker)
- `update` — edit content/type/scope/state/importance/tags
- `forget` — expire a memory (soft delete)
- `delete_memory` — permanently delete a memory + its edges
- `link` / `unlink` — add / remove graph relationships

Consolidation:
- `dream` — encode embeddings, train the ML models, NREM dedup + REM linking + decay + reconcile
- `consolidate_session` — extract memories from a transcript
- `reindex_embeddings` — clear and recompute all vectors with the current provider

## Web dashboard

`pnpm dashboard` serves a local UI: memory workspace, graph view, multi-turn RAG
chat (follow-up queries are LLM-rewritten before retrieval; answers cite sources
and surface known contradictions; citations feed the reranker), an On-device
learning panel showing each ML model's status, and a retrieval eval
(BM25 vs hybrid vs reranked on your real feedback data).

## Embeddings (optional)

Hybrid semantic recall turns on when an embedding provider is set in
`~/.mnemo/config.json`, then a `dream` encodes memories. Providers: `local`
(built-in hashing, no deps), `astermind` (on-device TF-IDF, no deps), `ollama`,
or `openai` (also works with Gemini's OpenAI-compatible endpoint). Config edits
apply within ~2s — no restart needed.

## On-device ML (optional)

Four AsterMind-ELM models train during every `dream`, each persisted only when
it beats a majority-class baseline on held-out data (until then, zero behavior
change):

- **Type classifier** (`ml.typeSuggest`) — suggests a memory type on `remember`
- **Consolidation pre-screeners** (`ml.prescreen`) — trained on logged LLM
  verdicts; confidently-negative pairs skip the LLM call. Never short-circuits
  merges/supersessions — only SKIP/NONE
- **Recall reranker** (`ml.rerank`) — trained on `recall_feedback` (chat
  citations + `record_use`); blends P(used) into ranking as `score × (0.5 + P)`

Plus `ml.tagSuggest` (KNN tag votes) and `ml.dedup` (write-time near-duplicate
warning). Inspect via `GET /api/ml-status` and `POST /api/eval` on the dashboard
server, or the dream log's `prescreen_*` / `rerank_*` stats.

## Consolidation LLM (optional)

`consolidation.provider` powers NREM merge adjudication, session extraction, and
chat/ask synthesis. `reconcileProvider`/`reconcileModel` optionally route the
nuanced reconcile phase (supersession/contradiction) and chat to a stronger
model — e.g. fast local `ollama/llama3.2:3b` for dedup, `claude-cli/sonnet` for
reconcile. Providers: `claude-cli` (reuses your Claude Code login), `anthropic`,
`openai`-compatible, `ollama`.

`consolidation.fallback` is an ordered chain tried when the primary (or
reconcile) provider returns null — so you can run an aggressive primary safely:
strong model up front, local model as a net, and the built-in heuristic as the
final floor. Which model actually produced each verdict is recorded in
`adjudication_log.model` (so `ml.prescreen.excludeModels` filtering stays
honest), and per-dream fallback counts surface in the dream log and
`/api/ml-status`. No `fallback` = single-provider behavior, unchanged.

## Docs

- `packages/web/public/mnemo-scroll.html` — architecture deep dive (served at `/mnemo-scroll.html`)
- `packages/web/public/astermind-scroll.html` — the ML integration deep dive (served at `/astermind-scroll.html`)

## Skills

Install skills by copying `packages/skills/*/SKILL.md` to `~/.claude/skills/{name}/SKILL.md`.
