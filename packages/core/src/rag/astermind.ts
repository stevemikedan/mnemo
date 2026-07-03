import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { TFIDFVectorizer } from '@astermind/astermind-elm';
import { encodeVector } from './embedding.js';
import { silenced } from '../ml/persist.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory } from '../graph/schema.js';

/**
 * AsterMind-ELM embedding provider — corpus-adapted TF-IDF vectors (with the
 * library's stemming + n-grams) fitted on the whole memory store.
 *
 * Consistency: query-time and index-time vectors must come from a vectorizer
 * fitted on the *same* corpus. So dream() fits on all memories, writes every
 * memory's vector, and persists a corpus snapshot to ~/.mnemo/astermind-model.json.
 * Query-time rebuilds the identical vectorizer from that snapshot (no DB needed),
 * so it stays comparable with the stored vectors until the next dream refits.
 * If the corpus has drifted since the last dream, dimensions differ and cosine
 * (which returns 0 on dimension mismatch) simply degrades those pairs to BM25.
 */

const DEFAULT_MAX_VOCAB = 1024;

function modelPath(): string {
  return join(homedir(), '.mnemo', 'astermind-model.json');
}

interface PersistedModel {
  maxVocab: number;
  docs: string[];
}


let cache: { key: string; vec: TFIDFVectorizer } | null = null;

function buildVectorizer(model: PersistedModel): TFIDFVectorizer {
  const key = `${model.maxVocab}:${model.docs.length}:${model.docs.reduce((n, d) => n + d.length, 0)}`;
  if (cache && cache.key === key) return cache.vec;
  const vec = silenced(() => new TFIDFVectorizer(model.docs, model.maxVocab));
  cache = { key, vec };
  return vec;
}

/** Query-time embedding: reads the persisted corpus snapshot. Null if not fitted yet. */
export function astermindEmbed(texts: string[]): number[][] | null {
  const path = modelPath();
  if (!existsSync(path)) return null;
  let model: PersistedModel;
  try {
    model = JSON.parse(readFileSync(path, 'utf-8')) as PersistedModel;
  } catch {
    return null;
  }
  if (!model.docs?.length) return null;
  const vec = buildVectorizer(model);
  return silenced(() => texts.map(t => TFIDFVectorizer.l2normalize(vec.vectorize(t))));
}

/**
 * Fit the TF-IDF vectorizer on the entire store, write every non-expired
 * memory's embedding, and persist the corpus snapshot. Returns the count
 * embedded. Called from dream() when the provider is 'astermind'.
 */
export function fitAndEncodeCorpus(store: MemoryStore, maxVocab = DEFAULT_MAX_VOCAB): number {
  const corpus = store.query({ states: ['active', 'dormant', 'archived'] });
  if (corpus.length === 0) return 0;

  const docs = corpus.map((m: Memory) => m.content);
  const vec = silenced(() => new TFIDFVectorizer(docs, maxVocab));

  let embedded = 0;
  for (const mem of corpus) {
    const vector = silenced(() => TFIDFVectorizer.l2normalize(vec.vectorize(mem.content)));
    store.setEmbedding(mem.id, encodeVector(vector));
    embedded++;
  }

  const dir = join(homedir(), '.mnemo');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const model: PersistedModel = { maxVocab, docs };
  writeFileSync(modelPath(), JSON.stringify(model));
  cache = null; // force rebuild against the new snapshot on next query

  return embedded;
}
