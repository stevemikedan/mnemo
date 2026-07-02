import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MemoryEdge, EdgeType } from './schema.js';

export class GraphStore {
  constructor(private db: Database.Database) {}

  addEdge(fromId: string, toId: string, type: EdgeType, weight = 1.0): MemoryEdge {
    const edge: MemoryEdge = {
      id: uuidv4(),
      from_id: fromId,
      to_id: toId,
      type,
      weight,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO memory_edges (id, from_id, to_id, type, weight, created_at)
      VALUES (@id, @from_id, @to_id, @type, @weight, @created_at)
    `).run(edge);
    return edge;
  }

  getNeighbors(memoryId: string, depth = 1): { id: string; type: EdgeType; direction: 'out' | 'in' }[] {
    if (depth < 1) return [];
    const outgoing = this.db.prepare(
      "SELECT to_id as id, type, 'out' as direction FROM memory_edges WHERE from_id = ?"
    ).all(memoryId) as { id: string; type: EdgeType; direction: 'out' }[];
    const incoming = this.db.prepare(
      "SELECT from_id as id, type, 'in' as direction FROM memory_edges WHERE to_id = ?"
    ).all(memoryId) as { id: string; type: EdgeType; direction: 'in' }[];
    return [...outgoing, ...incoming];
  }

  getEdges(fromId: string): MemoryEdge[] {
    return this.db.prepare('SELECT * FROM memory_edges WHERE from_id = ?').all(fromId) as MemoryEdge[];
  }
}
