import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SCHEMA_SQL, type Memory, type MemoryEdge, type MemoryType, type MemoryState, type EdgeType } from './schema.js';
import { isScopeVisible } from '../access.js';
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
  }

  create(opts: CreateMemoryOptions): Memory {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: uuidv4(),
      content: opts.content,
      type: opts.type ?? 'project',
      scope: opts.scope ?? 'global',
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
    };

    this.db.prepare(`
      INSERT INTO memories (id, content, type, scope, state, importance, confidence,
        access_count, created_at, last_accessed, last_consolidated, embedding, tags, source, metadata)
      VALUES (@id, @content, @type, @scope, @state, @importance, @confidence,
        @access_count, @created_at, @last_accessed, @last_consolidated, @embedding, @tags, @source, @metadata)
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

  update(id: string, patch: Partial<Pick<Memory, 'content' | 'type' | 'scope' | 'state' | 'importance' | 'confidence' | 'tags' | 'metadata'>>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.content !== undefined) { sets.push('content = @content'); params.content = patch.content; }
    if (patch.type !== undefined) { sets.push('type = @type'); params.type = patch.type; }
    if (patch.scope !== undefined) { sets.push('scope = @scope'); params.scope = patch.scope; }
    if (patch.state !== undefined) { sets.push('state = @state'); params.state = patch.state; }
    if (patch.importance !== undefined) { sets.push('importance = @importance'); params.importance = patch.importance; }
    if (patch.confidence !== undefined) { sets.push('confidence = @confidence'); params.confidence = patch.confidence; }
    if (patch.tags !== undefined) { sets.push('tags = @tags'); params.tags = JSON.stringify(patch.tags); }
    if (patch.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = JSON.stringify(patch.metadata); }
    if (sets.length === 0) return false;
    const result = this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return result.changes > 0;
  }

  /** Permanently delete a memory (and its edges via ON DELETE CASCADE). */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
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
      memories = memories.filter(m => m.scope === opts.scope);
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
