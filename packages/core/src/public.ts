export { MemoryStore } from './graph/store.js';
export { GraphStore } from './graph/graph.js';
export { BM25Index } from './rag/bm25.js';
export { RecallEngine } from './rag/recall.js';
export { resolveScope, isScopeVisible } from './access.js';
export { extractSignals } from './consolidation/session.js';
export { runNREM } from './consolidation/nrem.js';
export { runREM } from './consolidation/rem.js';
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
export type { DreamOptions, DreamStats, ConsolidateSessionResult } from './consolidation/dream.js';
