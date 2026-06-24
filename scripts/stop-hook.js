#!/usr/bin/env node
/**
 * Claude Code Stop Hook — mnemo session consolidation
 *
 * Reads the session transcript, extracts memory signals, and saves them to ~/.mnemo/memory.db.
 * Configure in Claude Code settings:
 *
 *   "hooks": {
 *     "Stop": [{ "hooks": [{ "type": "command", "command": "node C:/Users/steve/dev/mnemo/scripts/stop-hook.js" }] }]
 *   }
 *
 * Receives hook data as JSON on stdin.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MNEMO_ROOT = join(__dirname, '..');

// Read hook input from stdin
let hookData = {};
try {
  const raw = readFileSync('/dev/stdin', 'utf-8').trim();
  if (raw) hookData = JSON.parse(raw);
} catch { /* non-fatal */ }

const { session_id, transcript_path, cwd: hookCwd } = hookData;

// Extract transcript text
let transcriptText = '';
if (transcript_path && existsSync(transcript_path)) {
  try {
    const lines = readFileSync(transcript_path, 'utf-8').split('\n').filter(Boolean);
    transcriptText = lines
      .map(l => { try { const e = JSON.parse(l); return typeof e.content === 'string' ? e.content : ''; } catch { return ''; } })
      .join('\n');
  } catch { /* non-fatal */ }
}

if (!transcriptText) process.exit(0);

// Import mnemo core from built dist
const coreDist = join(MNEMO_ROOT, 'packages', 'core', 'dist', 'public.js');
if (!existsSync(coreDist)) {
  console.error('mnemo: core not built — run pnpm build in', MNEMO_ROOT);
  process.exit(0);
}

const { MemoryStore, GraphStore, extractSignals, runNREM } = await import(coreDist);

const store = new MemoryStore();
const graph = new GraphStore(store.db);

const projectPath = hookCwd ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
const scope = `project:${projectPath}`;
const sid = session_id ?? `hook-${Date.now()}`;

const signals = extractSignals(transcriptText);
if (signals.length === 0) process.exit(0);

const saved = [];
for (const signal of signals) {
  const mem = store.create({
    content: signal.content,
    type: signal.type,
    scope,
    tags: signal.tags,
    importance: signal.importance,
    source: `session:${sid}`,
  });
  saved.push(mem.id);
}

// Quick NREM dedup
const existing = store.query({ cwd: projectPath, states: ['active', 'dormant'] });
const newMems = saved.map(id => store.get(id)).filter(Boolean);
await runNREM(store, graph, [...existing.filter(m => !saved.includes(m.id)), ...newMems]);

console.log(`mnemo: extracted ${signals.length} memory signals from session ${sid}`);
store.close();
