import { readConfig } from './config.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory, MemoryState } from '../graph/schema.js';

export interface DecayOptions {
  /** Exact scope to decay, e.g. 'project:/path' or 'global'. */
  scope?: string;
  /** Working directory — decays global + ancestor project scopes. */
  cwd?: string;
  /** Override "now" (ms since epoch) for deterministic testing. */
  now?: number;
}

export interface DecayStats {
  scanned: number;
  toDormant: number;
  toArchived: number;
  expired: number;
  reactivated: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  halfLifeDays: 30,
  dormantThreshold: 0.5,
  archiveThreshold: 0.2,
  expireThreshold: 0.05,
  protectImportance: 0.9,
};

/**
 * Ebbinghaus-style retention for a memory given the time since it was last
 * touched. Stability (the decay time-constant) grows with importance and with
 * how often the memory has been accessed, so important, frequently-recalled
 * memories fade slowly and one-off notes fade fast.
 *
 * retention = exp(-ageDays / stability),  stability = halfLife * (0.5 + importance) * (1 + ln(1 + access_count))
 */
export function retentionOf(mem: Memory, nowMs: number, halfLifeDays = DEFAULTS.halfLifeDays): number {
  const ref = mem.last_accessed ?? mem.created_at;
  const ageDays = Math.max(0, (nowMs - Date.parse(ref)) / DAY_MS);
  const stability = halfLifeDays * (0.5 + mem.importance) * (1 + Math.log1p(mem.access_count));
  if (stability <= 0) return 0;
  return Math.exp(-ageDays / stability);
}

/**
 * Decay/lifecycle maintenance pass. Recomputes each non-expired memory's
 * confidence from its retention and transitions its state along
 * active → dormant → archived → expired (and back up on reinforcement).
 * Idempotent for a fixed clock: rerunning without new accesses is a no-op.
 */
export function runDecay(store: MemoryStore, opts: DecayOptions = {}): DecayStats {
  const stats: DecayStats = { scanned: 0, toDormant: 0, toArchived: 0, expired: 0, reactivated: 0 };

  const cfg = readConfig().decay ?? {};
  if (cfg.enabled === false) return stats;

  const halfLifeDays = cfg.halfLifeDays ?? DEFAULTS.halfLifeDays;
  const dormantThreshold = cfg.dormantThreshold ?? DEFAULTS.dormantThreshold;
  const archiveThreshold = cfg.archiveThreshold ?? DEFAULTS.archiveThreshold;
  const expireThreshold = cfg.expireThreshold ?? DEFAULTS.expireThreshold;
  const protectImportance = cfg.protectImportance ?? DEFAULTS.protectImportance;

  const nowMs = opts.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const memories = store.query({
    scope: opts.scope,
    cwd: opts.cwd,
    states: ['active', 'dormant', 'archived'],
  });

  const rank: Record<MemoryState, number> = { active: 0, dormant: 1, archived: 2, expired: 3 };

  for (const mem of memories) {
    stats.scanned++;
    const retention = retentionOf(mem, nowMs, halfLifeDays);

    // Pinned memories never fall below active, but their confidence still tracks retention.
    let nextState: MemoryState;
    if (mem.importance >= protectImportance) {
      nextState = 'active';
    } else if (retention >= dormantThreshold) {
      nextState = 'active';
    } else if (retention >= archiveThreshold) {
      nextState = 'dormant';
    } else if (retention >= expireThreshold) {
      nextState = 'archived';
    } else {
      nextState = 'expired';
    }

    const confidence = Math.max(0, Math.min(1, retention));
    const stateChanged = nextState !== mem.state;
    const confidenceChanged = Math.abs(confidence - mem.confidence) > 0.001;

    if (stateChanged || confidenceChanged) {
      store.update(mem.id, { state: nextState, confidence });
    }

    if (stateChanged) {
      if (rank[nextState] > rank[mem.state]) {
        if (nextState === 'dormant') stats.toDormant++;
        else if (nextState === 'archived') stats.toArchived++;
        else if (nextState === 'expired') stats.expired++;
      } else {
        // Retention rose above a threshold (e.g. after a recent access) — promote back up.
        stats.reactivated++;
      }
    }
  }

  // Mark that a consolidation/decay pass touched these memories.
  if (memories.length > 0) {
    const ids = memories.map(m => m.id);
    const placeholders = ids.map(() => '?').join(',');
    store.db.prepare(`UPDATE memories SET last_consolidated = ? WHERE id IN (${placeholders})`).run(nowIso, ...ids);
  }

  return stats;
}
