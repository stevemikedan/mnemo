import { readConfig } from '../consolidation/config.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory } from '../graph/schema.js';

/**
 * Provider-agnostic text embedding. Mirrors llm.ts: config-driven with graceful
 * degradation — when no provider is configured (the default), embedText returns
 * null and retrieval falls back to pure BM25 with zero behavioral change.
 *
 * Built-in providers are HTTP-only (no bundled dependency):
 *  - 'openai': any OpenAI-compatible POST {baseUrl}/embeddings endpoint
 *  - 'ollama': a local Ollama server's POST {baseUrl}/api/embed
 * A local in-process provider (e.g. AsterMind-ELM) can be added later without
 * touching callers.
 */

const EMBED_TIMEOUT_MS = 10_000;

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
    if (provider === 'openai') return await openaiEmbed(texts, cfg);
    if (provider === 'ollama') return await ollamaEmbed(texts, cfg);
  } catch {
    return null;
  }
  return null;
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
