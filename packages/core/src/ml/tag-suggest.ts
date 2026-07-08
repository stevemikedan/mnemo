import { textFeatures } from './featurize.js';
import { cosineSim } from '../rag/embedding.js';
import { readConfig } from '../consolidation/config.js';
import type { MemoryStore } from '../graph/store.js';

/**
 * Suggest tags for new content via similarity-weighted KNN vote over existing
 * tagged memories. KNN (not a trained ELM) is deliberate: tag labels are sparse
 * (a handful of examples each), where a trained classifier can't validate; a
 * neighbor vote degrades gracefully instead.
 *
 * Fallback pattern: no tagged memories / no sufficiently-similar neighbors /
 * no tag clearing the vote threshold → [] (caller stores with no tags, exactly
 * as today). Off unless ml.tagSuggest.enabled.
 */
const STOPWORDS = new Set(('the a an to of in on for with and or is are it this that be as at by from was were '
  + 'over under into out up down not no so if then than when where which who whom whose what how why all any '
  + 'can could should would will shall may might must have has had do does did its their our your my his her').split(' '));

/** Strip stopwords before featurizing — unrelated texts otherwise share a ~0.3 cosine floor from function words. */
function contentWords(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(w => !STOPWORDS.has(w)).join(' ');
}

export function suggestTags(store: MemoryStore, content: string): string[] {
  const cfg = readConfig().ml?.tagSuggest;
  if (!cfg?.enabled) return [];
  const minSim = cfg.minSim ?? 0.3;
  const voteThreshold = cfg.voteThreshold ?? 0.5;
  const maxTags = cfg.maxTags ?? 3;
  const k = 6;

  const tagged = store.query({ states: ['active', 'dormant', 'archived'] }).filter(m => m.tags.length > 0);
  if (tagged.length === 0) return [];

  const x = textFeatures(contentWords(content));
  const neighbors = tagged
    .map(m => ({ m, sim: cosineSim(x, textFeatures(contentWords(m.content))) }))
    .filter(n => n.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
  if (neighbors.length === 0) return [];

  const totalSim = neighbors.reduce((s, n) => s + n.sim, 0);
  const votes = new Map<string, number>();
  for (const n of neighbors) {
    for (const tag of n.m.tags) votes.set(tag, (votes.get(tag) ?? 0) + n.sim);
  }

  return [...votes.entries()]
    .map(([tag, v]) => ({ tag, score: v / totalSim }))
    .filter(t => t.score >= voteThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTags)
    .map(t => t.tag);
}
