import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SCHEMA_SQL, type Memory, type MemoryEdge, type MemoryType, type MemoryState, type EdgeType } from './schema.js';
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

  update(id: string, patch: Partial<Pick<Memory, 'content' | 'state' | 'importance' | 'confidence' | 'tags' | 'metadata'>>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.content !== undefined) { sets.push('content = @content'); params.content = patch.content; }
    if (patch.state !== undefined) { sets.push('state = @state'); params.state = patch.state; }
    if (patch.importance !== undefined) { sets.push('importance = @importance'); params.importance = patch.importance; }
    if (patch.confidence !== undefined) { sets.push('confidence = @confidence'); params.confidence = patch.confidence; }
    if (patch.tags !== undefined) { sets.push('tags = @tags'); params.tags = JSON.stringify(patch.tags); }
    if (patch.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = JSON.stringify(patch.metadata); }
    if (sets.length === 0) return false;
    const result = this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return result.changes > 0;
  }

  /** Returns all memories visible from a given CWD + optionally filtered */
  query(opts: QueryOptions = {}): Memory[] {
    const cwd = opts.scope ?? opts.cwd ?? 'global';
    const states = opts.states ?? ['active', 'dormant'];
    const stateList = states.map(() => '?').join(',');

    // Scope resolution: return global + any project scope that is a prefix of cwd
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE state IN (${stateList})
        AND (scope = 'global' OR (scope LIKE 'project:%' AND ? LIKE (SUBSTR(scope, 9) || '%')))
      ORDER BY importance DESC, created_at DESC
    `).all(...states, cwd) as Record<string, unknown>[];

    let memories = rows.map(deserialize);

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
