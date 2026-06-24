---
name: remember
description: Store a memory in mnemo — the persistent agent memory store
---

Store a new memory using the mnemo `remember` MCP tool.

## How to use

Call the `remember` MCP tool with:
- `content` (required): what to remember, written as a clear, standalone statement
- `type` (optional): `user` (preferences), `feedback` (corrections), `project` (decisions), `reference` (pointers), `semantic` (patterns)
- `scope` (optional): `global` (default, cross-project) or `project:{abs_path}` for project-specific
- `tags` (optional): array of topic tags
- `importance` (optional): 0.0–1.0 (default 0.5)

## When to infer scope

If the user says "remember this for this project" → use `scope: project:{cwd}` where cwd is the current working directory.
If the user says "always" or "everywhere" → use `scope: global`.
When unsure → use `global`.

## Examples

"Remember that I prefer tabs over spaces" → type: user, scope: global
"Remember that this project uses pnpm" → type: project, scope: project:{cwd}
"Don't do X again" → type: feedback, scope: global, content: "Do not X"
