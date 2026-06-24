---
name: recall
description: Search mnemo memories — retrieve relevant stored knowledge
---

Search memories using the mnemo `recall` MCP tool.

## How to use

Call the `recall` MCP tool with:
- `query` (required): the search query (BM25 keyword search)
- `cwd` (optional): current working directory for scope resolution
- `types` (optional): filter by memory type
- `limit` (optional): max results (default 10)
- `include_related` (optional): include graph-connected memories

## When to use

- Before starting a task: "What do I know about X?"
- When the user references something that might be stored: check memories first
- When you need to recall a preference, decision, or pattern from a prior session

## Tips

- Be specific in the query: "typescript linting rules" not just "code style"
- Use `include_related: true` when context about related memories would help
- Project-specific memories are automatically included when `cwd` matches the project path
