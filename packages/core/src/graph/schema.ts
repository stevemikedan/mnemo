export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    content       TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'project',
    scope         TEXT NOT NULL DEFAULT 'global',
    state         TEXT NOT NULL DEFAULT 'active',
    importance    REAL NOT NULL DEFAULT 0.5,
    confidence    REAL NOT NULL DEFAULT 1.0,
    access_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_accessed TEXT,
    last_consolidated TEXT,
    embedding     BLOB,
    tags          TEXT NOT NULL DEFAULT '[]',
    source        TEXT NOT NULL DEFAULT 'user',
    metadata      TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS memory_edges (
    id         TEXT PRIMARY KEY,
    from_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    to_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consolidation_log (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL,
    phase       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    stats       TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
  CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
  CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);
`;

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'semantic';
export type MemoryState = 'active' | 'dormant' | 'archived' | 'expired';
export type EdgeType = 'relates-to' | 'contradicts' | 'supersedes' | 'derived-from' | 'co-occurred';

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  scope: string;
  state: MemoryState;
  importance: number;
  confidence: number;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
  last_consolidated: string | null;
  embedding: Buffer | null;
  tags: string[];
  source: string;
  metadata: Record<string, unknown>;
}

export interface MemoryEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: EdgeType;
  weight: number;
  created_at: string;
}

export interface ConsolidationLog {
  id: string;
  scope: string;
  phase: string;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, number>;
}
