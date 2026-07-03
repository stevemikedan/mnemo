export { MemoryStore } from './graph/store.js';
export { GraphStore } from './graph/graph.js';
export { BM25Index } from './rag/bm25.js';
export { RecallEngine, searchHybrid, fuseRRF } from './rag/recall.js';
export { embedText, embedMemories, isEmbeddingConfigured, cosineSim, reindexEmbeddings } from './rag/embedding.js';
export { answerFromMemories } from './rag/answer.js';
export type { Completer } from './rag/answer.js';
export type { ReindexResult } from './rag/embedding.js';
export { readConfig, reloadConfig } from './consolidation/config.js';
export type { MnemoConfig } from './consolidation/config.js';
export { trainElmClassifier, loadElmClassifier } from './ml/elm-classifier.js';
export type { ElmClassifier, Prediction } from './ml/elm-classifier.js';
export { trainAndValidate } from './ml/trainer.js';
export type { Sample, ValidationReport } from './ml/trainer.js';
export { textFeatures, pairFeatures, TEXT_FEATURE_DIM } from './ml/featurize.js';
export { trainTypeClassifier, suggestType } from './ml/type-classifier.js';
export { resolveScope, isScopeVisible, normalizeScope } from './access.js';
export { extractSignals } from './consolidation/session.js';
export { runNREM } from './consolidation/nrem.js';
export { runREM } from './consolidation/rem.js';
export { runDecay, retentionOf } from './consolidation/decay.js';
export { runReconcile } from './consolidation/reconcile.js';
export { dream, consolidateSession, getDreamLog } from './consolidation/dream.js';
export type {
  Memory,
  MemoryEdge,
  ConsolidationLog,
  MemoryType,
  MemoryState,
  EdgeType,
} from './graph/schema.js';
export type { CreateMemoryOptions, QueryOptions } from './graph/store.js';
export type { RecallOptions, RecallResult } from './rag/recall.js';
export type { ExtractedSignal } from './consolidation/session.js';
export type { NREMStats } from './consolidation/nrem.js';
export type { REMStats } from './consolidation/rem.js';
export type { DecayStats, DecayOptions } from './consolidation/decay.js';
export type { ReconcileStats, Verdict, Adjudicator } from './consolidation/reconcile.js';
export type { DreamOptions, DreamStats, ConsolidateSessionResult } from './consolidation/dream.js';
