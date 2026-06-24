---
name: dream
description: Run mnemo memory consolidation — dedup, cross-link, and promote memories
---

Trigger a full consolidation pass on the memory store using the mnemo `dream` MCP tool.

## What it does

1. **NREM** — finds near-duplicate memories and merges them (via LLM adjudication or word-overlap heuristics)
2. **REM** — adds `relates-to` edges between thematically similar memories; promotes high-importance session memories to project scope (TiMem)

## When to call

- After a long work session to clean up extracted memories
- When the user says "dream", "consolidate memories", "clean up memories"
- Periodically during long autonomous loops (every ~10 tasks)

## How to call

```
dream(
  scope?: "project:/abs/path",  // omit to consolidate all active memories
  cwd?: "/current/working/dir"  // for TiMem promotions
)
```

## After calling

Report the stats back to the user:
- Merged: how many duplicates were collapsed
- Cross-links added: new `relates-to` edges
- Duration: how long it took

If `merged > 0`, note that the memory store is now more compact. If `linked > 0`, mention that related memories are now connected for better recall.
