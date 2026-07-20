import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SCHEMA_SQL, type Memory, type MemoryEdge, type MemoryType, type MemoryState, type EdgeType } from './schema.js';
import { isScopeVisible, normalizeScope } from '../access.js';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { join } from 'path';

export interface CreateMemoryOptions {
  content: string;
  type?: MemoryType;
  scope?: string;
  tags?: string[];
  importance?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  scope?: string;
  cwd?: string;
  types?: MemoryType[];
  states?: MemoryState[];
  tags?: string[];
  limit?: number;
}

function defaultDbPath(): string {
  const dir = join(homedir(), '.mnemo');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'memory.db');
}

function deserialize(row: Record<string, unknown>): Memory {
  return {
    ...row,
    tags: JSON.parse(row.tags as string),
    metadata: JSON.parse(row.metadata as string),
  } as Memory;
}

export class MemoryStore {
  readonly db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? defaultDbPath());
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  /** Additive migrations for DBs created before a column existed (CREATE TABLE
   * IF NOT EXISTS skips them). Each is idempotent — checked against PRAGMA
   * table_info before altering. */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(adjudication_log)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'model')) {
      this.db.exec('ALTER TABLE adjudication_log ADD COLUMN model TEXT');
    }

    // Promote the legacy metadata.superseded_by pointer to a first-class indexed
    // column. Backfill from metadata, then strip it there so there's one source
    // of truth (idempotent — only runs on DBs created before the column existed).
    const memCols = this.db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    if (!memCols.some(c => c.name === 'superseded_by')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT');
      this.db.exec("UPDATE memories SET superseded_by = json_extract(metadata, '$.superseded_by') WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL");
      this.db.exec("UPDATE memories SET metadata = json_remove(metadata, '$.superseded_by') WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL");
    }
    // Index created here (not in SCHEMA_SQL) so it never references the column
    // before the migration above adds it on a pre-existing DB. Idempotent.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)');

    // dream_audit gained grouping + reversal tracking after its first release.
    const auditCols = this.db.prepare('PRAGMA table_info(dream_audit)').all() as { name: string }[];
    if (auditCols.length && !auditCols.some(c => c.name === 'mutation_id')) {
      this.db.exec('ALTER TABLE dream_audit ADD COLUMN mutation_id TEXT');
    }
    if (auditCols.length && !auditCols.some(c => c.name === 'restored_at')) {
      this.db.exec('ALTER TABLE dream_audit ADD COLUMN restored_at TEXT');
    }
  }

  create(opts: CreateMemoryOptions): Memory {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: uuidv4(),
      content: opts.content,
      type: opts.type ?? 'project',
      scope: normalizeScope(opts.scope ?? 'global'),
      state: 'active',
      importance: opts.importance ?? 0.5,
      confidence: 1.0,
      access_count: 0,
      created_at: now,
      last_accessed: null,
      last_consolidated: null,
      embedding: null,
      tags: opts.tags ?? [],
      source: opts.source ?? 'user',
      metadata: opts.metadata ?? {},
      superseded_by: null,
    };

    this.db.prepare(`
      INSERT INTO memories (id, content, type, scope, state, importance, confidence,
        access_count, created_at, last_accessed, last_consolidated, embedding, tags, source, metadata, superseded_by)
      VALUES (@id, @content, @type, @scope, @state, @importance, @confidence,
        @access_count, @created_at, @last_accessed, @last_consolidated, @embedding, @tags, @source, @metadata, @superseded_by)
    `).run({
      ...memory,
      tags: JSON.stringify(memory.tags),
      metadata: JSON.stringify(memory.metadata),
    });

    return memory;
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return deserialize(row);
  }

  /**
   * Record a retrieval: bump access_count and last_accessed without the extra
   * SELECT that get() does. This is the reinforcement signal the decay pass
   * reads — recalling a memory strengthens it (spaced repetition).
   */
  recordAccess(id: string): void {
    this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /** Persist a precomputed embedding vector (BLOB) for a memory. */
  setEmbedding(id: string, embedding: Buffer): void {
    this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(embedding, id);
  }

  update(id: string, patch: Partial<Pick<Memory, 'content' | 'type' | 'scope' | 'state' | 'importance' | 'confidence' | 'tags' | 'metadata' | 'superseded_by'>>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.content !== undefined) { sets.push('content = @content'); params.content = patch.content; }
    if (patch.type !== undefined) { sets.push('type = @type'); params.type = patch.type; }
    if (patch.scope !== undefined) { sets.push('scope = @scope'); params.scope = normalizeScope(patch.scope); }
    if (patch.state !== undefined) { sets.push('state = @state'); params.state = patch.state; }
    if (patch.importance !== undefined) { sets.push('importance = @importance'); params.importance = patch.importance; }
    if (patch.confidence !== undefined) { sets.push('confidence = @confidence'); params.confidence = patch.confidence; }
    if (patch.tags !== undefined) { sets.push('tags = @tags'); params.tags = JSON.stringify(patch.tags); }
    if (patch.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = JSON.stringify(patch.metadata); }
    if (patch.superseded_by !== undefined) { sets.push('superseded_by = @superseded_by'); params.superseded_by = patch.superseded_by; }
    if (sets.length === 0) return false;
    const result = this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return result.changes > 0;
  }

  /** Permanently delete a memory (and its edges via ON DELETE CASCADE). */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Record whether a recalled memory was actually used for a query — the
   * reranker's training signal. `used=false` rows are impressions: shown to the
   * answering LLM but not cited, i.e. true retrieval negatives.
   */
  recordFeedback(query: string, memoryId: string, used = true): void {
    this.db.prepare(
      'INSERT INTO recall_feedback (id, query, memory_id, features, used, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
    ).run(uuidv4(), query, memoryId, used ? 1 : 0, new Date().toISOString());
  }

  /**
   * Snapshot a memory's pre-mutation state into dream_audit. Called before the
   * destructive dream mutations (NREM merge content-overwrite/expiry, reconcile
   * supersession demotion) so a wrong LLM verdict can be recovered by hand.
   * The embedding blob is omitted — it's recomputable, and it's bulk.
   */
  auditMutation(phase: string, memory: Memory, note?: string, mutationId?: string): void {
    const { embedding, ...snapshot } = memory;
    this.db.prepare(
      'INSERT INTO dream_audit (id, mutation_id, phase, memory_id, before_state, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(uuidv4(), mutationId ?? uuidv4(), phase, memory.id, JSON.stringify(snapshot), note ?? null, new Date().toISOString());
  }

  /** Distinct scope strings present in the store, sorted. */
  listScopes(): string[] {
    return (this.db.prepare('SELECT DISTINCT scope FROM memories ORDER BY scope ASC').all() as { scope: string }[])
      .map(r => r.scope);
  }

  /**
   * Query memories, filtered by state, scope, type, tags, and limit.
   *
   * Scope handling (mutually exclusive, in priority order):
   *  - `scope` (and not 'all'): exact scope match, e.g. 'global' or
   *    'project:/abs/path'. Use this to filter to a single workspace.
   *  - `cwd`: visibility resolution — returns global memories plus any project
   *    scope that is an ancestor of the cwd. A 'project:'-prefixed value is
   *    accepted and normalized. Use this for "what applies from where I am".
   *  - neither: no scope restriction (all scopes).
   *
   * Scope resolution is done in JS (see access.ts) rather than SQL LIKE to
   * avoid wildcard injection from paths containing '_'/'%' and sibling-prefix
   * false matches ('project:/foo' vs '/foobar').
   */
  query(opts: QueryOptions = {}): Memory[] {
    const states = opts.states ?? ['active', 'dormant'];
    const stateList = states.map(() => '?').join(',');

    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE state IN (${stateList})
      ORDER BY importance DESC, created_at DESC
    `).all(...states) as Record<string, unknown>[];

    let memories = rows.map(deserialize);

    if (opts.scope && opts.scope !== 'all') {
      const target = normalizeScope(opts.scope);
      memories = memories.filter(m => normalizeScope(m.scope) === target);
    } else if (opts.cwd) {
      const cwd = opts.cwd.startsWith('project:') ? opts.cwd.slice(8) : opts.cwd;
      memories = memories.filter(m => isScopeVisible(m.scope, cwd));
    }

    if (opts.types?.length) {
      memories = memories.filter(m => opts.types!.includes(m.type));
    }
    if (opts.tags?.length) {
      memories = memories.filter(m => opts.tags!.some(t => m.tags.includes(t)));
    }
    if (opts.limit) {
      memories = memories.slice(0, opts.limit);
    }
    return memories;
  }

  getStatus(): { total: number; byState: Record<string, number>; byType: Record<string, number>; byScope: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n;
    const byStateRows = this.db.prepare('SELECT state, COUNT(*) as n FROM memories GROUP BY state').all() as { state: string; n: number }[];
    const byTypeRows = this.db.prepare('SELECT type, COUNT(*) as n FROM memories GROUP BY type').all() as { type: string; n: number }[];
    const scopes = (this.db.prepare('SELECT COUNT(DISTINCT scope) as n FROM memories').get() as { n: number }).n;
    return {
      total,
      byState: Object.fromEntries(byStateRows.map(r => [r.state, r.n])),
      byType: Object.fromEntries(byTypeRows.map(r => [r.type, r.n])),
      byScope: scopes,
    };
  }

  close(): void {
    this.db.close();
  }
}
