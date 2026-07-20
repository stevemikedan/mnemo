import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

export interface ConflictExpansion {
  /** The input memories, possibly extended with contradiction partners. */
  memories: Memory[];
  /** Index pairs into `memories` (ascending) that contradict each other. */
  conflicts: [number, number][];
}

/**
 * Surface the contradictions reconcile has already found: for each retrieved
 * memory, follow its `contradicts` edges (either direction) and return the
 * conflicting index pairs — pulling a partner into the set when retrieval
 * missed it, so the answering LLM sees BOTH sides of a known conflict instead
 * of confidently citing whichever happened to rank higher.
 *
 * Partners are only added when same-scope or global (reconcile only creates
 * same-scope edges; a manual cross-project edge must not bleed another
 * project's memory into this context), never when expired/archived or
 * superseded, and at most `maxAdded` in total to keep the context bounded.
 */
export function expandConflicts(
  store: MemoryStore,
  graph: GraphStore,
  memories: Memory[],
  maxAdded = 2,
): ConflictExpansion {
  const out = [...memories];
  const idx = new Map(out.map((m, i) => [m.id, i]));
  const conflicts: [number, number][] = [];
  const seen = new Set<string>();
  let added = 0;

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    for (const n of graph.getNeighbors(m.id)) {
      if (n.type !== 'contradicts') continue;
      let j = idx.get(n.id);
      if (j === undefined) {
        if (added >= maxAdded) continue;
        const partner = store.get(n.id);
        if (!partner) continue;
        if (partner.state !== 'active' && partner.state !== 'dormant') continue;
        if (partner.superseded_by) continue;
        if (partner.scope !== m.scope && partner.scope !== 'global') continue;
        j = out.length;
        out.push(partner);
        idx.set(partner.id, j);
        added++;
      }
      const [lo, hi] = i < j ? [i, j] : [j, i];
      const key = `${lo}:${hi}`;
      if (!seen.has(key)) {
        seen.add(key);
        conflicts.push([lo, hi]);
      }
    }
  }

  return { memories: out, conflicts };
}
