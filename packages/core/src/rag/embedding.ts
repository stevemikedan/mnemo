import { readConfig } from '../consolidation/config.js';
import { astermindEmbed, fitAndEncodeCorpus } from './astermind.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory } from '../graph/schema.js';

/**
 * Provider-agnostic text embedding. Mirrors llm.ts: config-driven with graceful
 * degradation — when no provider is configured (the default), embedText returns
 * null and retrieval falls back to pure BM25 with zero behavioral change.
 *
 * Built-in providers (no bundled dependency):
 *  - 'local':  in-process feature-hashing embedder — no model download, no key
 *  - 'openai': any OpenAI-compatible POST {baseUrl}/embeddings endpoint
 *  - 'ollama': a local Ollama server's POST {baseUrl}/api/embed
 * Further local providers (e.g. AsterMind-ELM) can be added without touching
 * callers.
 */

// Generous because a local provider (Ollama) cold-loads the model into memory
// on the first call — measured ~45s for nomic-embed-text; warm calls are <1s.
const EMBED_TIMEOUT_MS = 90_000;

export function isEmbeddingConfigured(): boolean {
  const provider = readConfig().embeddings?.provider;
  return !!provider && provider !== 'none';
}

/** Embed a batch of texts. Returns one vector per input, or null on no-provider/failure. */
export async function embedText(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const cfg = readConfig().embeddings ?? {};
  const provider = cfg.provider ?? 'none';
  if (provider === 'none') return null;

  try {
    if (provider === 'local') return localEmbed(texts, cfg.dimensions ?? LOCAL_DIM);
    if (provider === 'astermind') return astermindEmbed(texts);
    if (provider === 'openai') return await openaiEmbed(texts, cfg);
    if (provider === 'ollama') return await ollamaEmbed(texts, cfg);
  } catch {
    return null;
  }
  return null;
}

/**
 * Encode memories during consolidation. Most providers embed only the
 * un-embedded memories (embedMemories); the 'astermind' provider instead
 * refits its TF-IDF vectorizer on the whole store and re-embeds everything so
 * all vectors share one vocabulary. No-op when unconfigured.
 */
export async function encodeForDream(store: MemoryStore, memories: Memory[]): Promise<number> {
  const cfg = readConfig().embeddings ?? {};
  const provider = cfg.provider ?? 'none';
  if (provider === 'none') return 0;
  if (provider === 'astermind') return fitAndEncodeCorpus(store, cfg.dimensions);
  return embedMemories(store, memories);
}

export interface ReindexResult {
  provider: string;
  /** Vectors cleared before re-encoding. */
  cleared: number;
  /** Vectors written by the re-encode. */
  embedded: number;
}

/**
 * Clear every stored embedding and recompute from scratch with the currently
 * configured provider. Use after switching providers (so no stale vectors from
 * the old space linger) or to backfill memories created before embeddings were
 * enabled. No-op — and importantly, does NOT clear — when no provider is set,
 * so a misconfigured call can't wipe your vectors.
 */
export async function reindexEmbeddings(store: MemoryStore): Promise<ReindexResult> {
  const provider = readConfig().embeddings?.provider ?? 'none';
  if (!isEmbeddingConfigured()) {
    return { provider: 'none', cleared: 0, embedded: 0 };
  }
  const cleared = store.db.prepare('UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL').run().changes;
  const memories = store.query({ states: ['active', 'dormant', 'archived'] });
  const embedded = await encodeForDream(store, memories);
  return { provider, cleared, embedded };
}

// --- Built-in 'local' provider: dependency-free feature-hashing embedder ---

const LOCAL_DIM = 256;

/** FNV-1a 32-bit hash of a string. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * On-device, deterministic embedding via signed feature hashing over unigrams
 * and bigrams with TF weighting, L2-normalized. No model download, no training,
 * no dependency. Captures lexical/fuzzy overlap (shared terms and phrases) — a
 * step up from BM25 for paraphrase-ish matching, though not transformer-grade.
 */
export function localEmbed(texts: string[], dim: number): number[][] {
  // Crude stemmer: fold common plural/gerund endings so 'containers'/'container'
  // and 'deploying'/'deploy' collide. Not linguistically correct, just enough to
  // recover the most frequent morphological variants.
  const stem = (t: string): string => {
    if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
    if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
    return t;
  };
  return texts.map(text => {
    const vec = new Float64Array(dim);
    const tokens = (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).map(stem);
    const add = (term: string) => {
      const h = fnv1a(term);
      const sign = (fnv1a('sign:' + term) & 1) === 0 ? 1 : -1;
      vec[h % dim] += sign;
    };
    for (let i = 0; i < tokens.length; i++) {
      add(tokens[i]);
      if (i + 1 < tokens.length) add(tokens[i] + ' ' + tokens[i + 1]); // bigram
    }
    let mag = 0;
    for (let i = 0; i < dim; i++) mag += vec[i] * vec[i];
    mag = Math.sqrt(mag);
    const out = new Array<number>(dim);
    for (let i = 0; i < dim; i++) out[i] = mag > 0 ? vec[i] / mag : 0;
    return out;
  });
}

async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openaiEmbed(texts: string[], cfg: NonNullable<ReturnType<typeof readConfig>['embeddings']>): Promise<number[][] | null> {
  const baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.model ?? 'text-embedding-3-small';
  const apiKey = cfg.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
  const res = await withTimeout(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { data?: { embedding: number[]; index: number }[] };
  if (!data.data) return null;
  // Preserve input order.
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

async function ollamaEmbed(texts: string[], cfg: NonNullable<ReturnType<typeof readConfig>['embeddings']>): Promise<number[][] | null> {
  const baseUrl = (cfg.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  const model = cfg.model ?? 'nomic-embed-text';
  const res = await withTimeout(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { embeddings?: number[][] };
  return data.embeddings ?? null;
}

// --- Vector (de)serialization for the SQLite BLOB column ---

export function encodeVector(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

export function decodeVector(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity. Returns 0 for mismatched dimensions (e.g. after a model change). */
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, aMag = 0, bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

/**
 * Embed any of the given memories that lack a stored embedding and persist the
 * vectors. No-op (returns 0) when embeddings are unconfigured. Intended to run
 * during consolidation ("encode during sleep").
 */
export async function embedMemories(store: MemoryStore, memories: Memory[]): Promise<number> {
  if (!isEmbeddingConfigured()) return 0;
  const pending = memories.filter(m => m.embedding == null);
  if (pending.length === 0) return 0;

  let embedded = 0;
  const BATCH = 64;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = await embedText(batch.map(m => m.content));
    if (!vectors) break; // provider failed — stop, leave the rest for next pass
    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j];
      if (!vec) continue;
      store.setEmbedding(batch[j].id, encodeVector(vec));
      embedded++;
    }
  }
  return embedded;
}
