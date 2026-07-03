import { llmComplete } from '../consolidation/llm.js';
import type { Memory } from '../graph/schema.js';

export type Completer = (prompt: string, system?: string) => Promise<string | null>;

/**
 * Synthesize a short plain-language answer to a question, grounded ONLY in the
 * supplied memories (the retrieval step happens upstream). Returns null when no
 * consolidation LLM is configured (callers fall back to showing raw memories)
 * or when there's nothing to answer from.
 *
 * `complete` is injectable for testing; it defaults to the configured LLM.
 */
export async function answerFromMemories(
  query: string,
  memories: Pick<Memory, 'content' | 'type'>[],
  complete: Completer = llmComplete,
): Promise<string | null> {
  if (!query.trim() || memories.length === 0) return null;
  const context = memories.map((m, i) => `[${i + 1}] (${m.type}) ${m.content}`).join('\n');
  return complete(
    `Question: ${query}\n\nStored memories:\n${context}\n\n` +
      `Answer the question in 1–3 sentences using ONLY the memories above, citing them like [1]. ` +
      `If they do not contain the answer, reply exactly: "No stored memory answers that."`,
    "You answer questions strictly from an AI agent's stored memories. Be concise and never invent facts beyond the memories provided.",
  );
}
