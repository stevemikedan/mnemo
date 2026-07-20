import { modelPath, loadJSON, saveJSON } from './persist.js';
import { trainAndValidate, type ValidationReport } from './trainer.js';
import { loadElmClassifier, type ElmClassifier } from './elm-classifier.js';
import { readConfig } from '../consolidation/config.js';
import { BM25Index } from '../rag/bm25.js';
import { embedText, cosineSim, decodeVector } from '../rag/embedding.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory } from '../graph/schema.js';

/**
 * Learned recall reranker — the AsterMind "RAG retrieval" idea applied to chat:
 * an ELM learns which retrieved memories actually get USED (recall_feedback,
 * fed by the record_use tool and chat citation parsing) and reorders the fused
 * ranking accordingly. Generation stays with the LLM; this model decides what
 * content the answer is grounded in.
 *
 * Blend, not replace: final score = fused score × (0.5 + P(used)), so an
 * untrained or unconfident model can at most halve/1.5× a score, never invert
 * a strong lexical+semantic consensus.
 */

const MODEL_FILE = 'elm-reranker.json';
const LABELS = ['used', 'skipped'] as const;
type Label = (typeof LABELS)[number];

/** Candidates considered per feedback query when mining negatives. */
const TRAIN_POOL = 20;
/** Cap on negatives kept per query — bounds class imbalance. */
const NEG_PER_QUERY = 8;

export const RERANK_FEATURE_DIM = 10;

const DAY = 86_400_000;

/** A memory's incident edges, split by what they say about it. Eight
 * relates-to edges and eight contradicts edges are opposite signals — a
 * type-blind count would score them identically. */
export interface EdgeDegree {
  /** Corroborating connections: relates-to / derived-from / co-occurred (either
   * direction), plus outgoing supersedes (this memory overrode another). */
  support: number;
  /** Disputed connections: contradicts (either direction), plus incoming
   * supersedes (something overrode this memory). */
  conflict: number;
}

/** Per-memory edge degrees split into support vs conflict — the reranker's
 * graph-centrality signal. A well-connected hub is often more relevant than an
 * orphan, but only when its connections corroborate rather than dispute it. */
export function edgeDegrees(store: MemoryStore): Map<string, EdgeDegree> {
  const rows = store.db.prepare(
    `SELECT memory_id, SUM(conflict) AS conflict, SUM(1 - conflict) AS support FROM (
       SELECT from_id AS memory_id,
              CASE WHEN type = 'contradicts' THEN 1 ELSE 0 END AS conflict
         FROM memory_edges
       UNION ALL
       SELECT to_id AS memory_id,
              CASE WHEN type IN ('contradicts', 'supersedes') THEN 1 ELSE 0 END AS conflict
         FROM memory_edges
     ) GROUP BY memory_id`,
  ).all() as { memory_id: string; conflict: number; support: number }[];
  return new Map(rows.map(r => [r.memory_id, { support: r.support, conflict: r.conflict }]));
}

/** Feature vector for one (query, candidate) pair. `bm25`/`cosine` are the raw
 * per-query scores that fuseRRF already exposes on SearchResult; `degree` is
 * the memory's split edge count (absent when the degree map is unavailable). */
export function rerankFeatures(m: Memory, bm25: number, cosine: number, nowMs: number, degree?: EdgeDegree): number[] {
  const created = Date.parse(m.created_at);
  const accessed = m.last_accessed ? Date.parse(m.last_accessed) : created;
  return [
    bm25 / (bm25 + 1), // squash unbounded BM25 to 0..1
    cosine,
    m.importance,
    Math.min(1, (nowMs - created) / DAY / 365),
    Math.min(1, (nowMs - accessed) / DAY / 365),
    Math.min(1, Math.log1p(m.access_count) / 6),
    m.state === 'active' ? 1 : 0,
    Math.min(1, (degree?.support ?? 0) / 10), // saturates at ~10 corroborating edges
    Math.min(1, (degree?.conflict ?? 0) / 5), // conflicts are rarer — saturate sooner
    m.confidence, // reconcile lowers this on contradiction; 1.0 when unchallenged
  ];
}

interface PersistedRerankerModel {
  json: string;
  report: ValidationReport<Label>;
}

let cache: { key: string; clf: ElmClassifier<Label> | null } | null = null;

/** Parse a decision-time feature snapshot; null unless it's a finite number[]
 * of the current feature dimension (schema-evolution safe). */
function parseSnapshot(s: string | null): number[] | null {
  if (!s) return null;
  try {
    const x = JSON.parse(s);
    return Array.isArray(x) && x.length === RERANK_FEATURE_DIM
      && x.every(v => typeof v === 'number' && Number.isFinite(v)) ? x : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild training pairs from recall_feedback and train the reranker. Rows
 * carrying a decision-time feature snapshot train on it directly — the values
 * the model will see at recall time, not values recomputed from a store whose
 * importance/access/degree have since drifted. Legacy rows (and record_use
 * rows, which have no retrieval context) fall back to re-retrieving over the
 * current store (BM25 + stored-embedding cosine) and recomputing features.
 * Persists only when it beats the majority baseline on a held-out split.
 * Intended to run during dream().
 */
export async function trainReranker(store: MemoryStore): Promise<ValidationReport<Label>> {
  const rows = store.db.prepare(
    `SELECT query, memory_id, used, features FROM recall_feedback ORDER BY created_at`,
  ).all() as { query: string; memory_id: string; used: number; features: string | null }[];

  // Resolve one label + best snapshot per (query, memory) pair. A memory both
  // cited and uncited for the same query (across turns) counts as used — one
  // citation proves relevance. Later snapshots win (rows are in time order).
  interface Resolved { used: boolean; snap: number[] | null }
  const byQuery = new Map<string, Map<string, Resolved>>();
  for (const r of rows) {
    let q = byQuery.get(r.query);
    if (!q) byQuery.set(r.query, (q = new Map()));
    const cur = q.get(r.memory_id) ?? { used: false, snap: null };
    cur.used = cur.used || !!r.used;
    const snap = parseSnapshot(r.features);
    if (snap) cur.snap = snap;
    q.set(r.memory_id, cur);
  }

  const candidates = store.query({ states: ['active', 'dormant'] });
  const index = new BM25Index();
  index.build(candidates);
  const nowMs = Date.now();
  const degrees = edgeDegrees(store);

  const samples: { x: number[]; y: Label }[] = [];
  for (const [query, pairs] of byQuery) {
    // Snapshot pairs train directly; the rest need recompute via re-retrieval.
    const recompute = new Map<string, Resolved>();
    let anyUsed = false;
    for (const [id, p] of pairs) {
      anyUsed = anyUsed || p.used;
      if (p.snap) samples.push({ x: p.snap, y: p.used ? 'used' : 'skipped' });
      else recompute.set(id, p);
    }
    // Positives anchor a query (zero-citation answers are never logged); no
    // recompute work when every labeled pair carried a snapshot.
    if (!anyUsed || recompute.size === 0) continue;

    const bm25 = index.search(query, TRAIN_POOL);
    const bm25Score = new Map(bm25.map(r => [r.memory.id, r.score]));
    const queryVec = (await embedText([query]))?.[0] ?? null;
    const hasExplicitNeg = [...pairs.values()].some(p => !p.used);

    // Pool = BM25 top hits plus any labeled-but-unsnapshotted memory that BM25
    // missed but a stored vector can still score — mirrors hybrid retrieval.
    const pool = new Map<string, Memory>(bm25.map(r => [r.memory.id, r.memory]));
    for (const c of candidates) {
      if (recompute.has(c.id) && !pool.has(c.id)) pool.set(c.id, c);
    }

    let negatives = 0;
    for (const m of pool.values()) {
      if (pairs.has(m.id) && !recompute.has(m.id)) continue; // already sampled from its snapshot
      const labeled = recompute.get(m.id);
      const positive = labeled?.used ?? false;
      if (!positive && hasExplicitNeg) {
        // This query has logged impressions (shown-but-uncited) — those are the
        // only trustworthy negatives; don't dilute them with mined guesses.
        if (!labeled || labeled.used) continue;
      } else if (!positive && negatives >= NEG_PER_QUERY) {
        continue;
      }
      const cos = queryVec && m.embedding != null
        ? cosineSim(queryVec, decodeVector(m.embedding as Buffer))
        : 0;
      const b = bm25Score.get(m.id) ?? 0;
      if (!positive && b === 0 && cos === 0 && !labeled) continue; // never retrieved — not a real negative
      samples.push({ x: rerankFeatures(m, b, cos, nowMs, degrees.get(m.id)), y: positive ? 'used' : 'skipped' });
      if (!positive) negatives++;
    }
  }

  const { model, report } = trainAndValidate([...LABELS], samples, {
    seed: 1, minSamples: 40, minPerClass: 10, minEdge: 0.05, hiddenUnits: 32,
  });
  if (model) {
    saveJSON(modelPath(MODEL_FILE), { json: model.toJSON(), report } satisfies PersistedRerankerModel);
    cache = null;
  }
  return report;
}

function loadModel(): ElmClassifier<Label> | null {
  const persisted = loadJSON<PersistedRerankerModel>(modelPath(MODEL_FILE));
  const key = persisted?.json ?? '';
  if (cache && cache.key === key) return cache.clf;
  const clf = persisted?.json ? loadElmClassifier<Label>(persisted.json) : null;
  cache = { key, clf };
  return clf;
}

export interface Rankable {
  memory: Memory;
  score: number;
  bm25?: number;
  cosine?: number;
}

/**
 * Rerank fused results by blending in the learned P(used). No-op (returns the
 * input array unchanged) when ml.rerank.enabled is off or no validated model
 * exists — recall behavior is byte-identical to today until both are true.
 * `opts.force` bypasses the config gate (used by the eval harness to measure a
 * model before enabling it).
 */
export function applyReranker<T extends Rankable>(results: T[], opts: { force?: boolean; degrees?: Map<string, EdgeDegree> } = {}): T[] {
  if (!opts.force && !readConfig().ml?.rerank?.enabled) return results;
  const clf = loadModel();
  if (!clf) return results;

  const nowMs = Date.now();
  const degrees = opts.degrees;
  return results
    .map(r => {
      const x = rerankFeatures(r.memory, r.bm25 ?? 0, r.cosine ?? 0, nowMs, degrees?.get(r.memory.id));
      const p = clf.predict(x);
      const pUsed = p ? p.proba.used ?? 0 : 0.5;
      return { ...r, score: r.score * (0.5 + pUsed) };
    })
    .sort((a, b) => b.score - a.score);
}
