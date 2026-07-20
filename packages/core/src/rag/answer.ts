import { llmComplete, llmChat } from '../consolidation/llm.js';
import type { ChatMessage } from '../consolidation/llm.js';
import type { Memory } from '../graph/schema.js';

export type { ChatMessage };
export type Completer = (prompt: string, system?: string) => Promise<string | null>;
export type Chatter = (messages: ChatMessage[], system?: string) => Promise<string | null>;

/** Numbered memory context, with known contradictions called out so the LLM
 * presents both sides instead of silently picking one. */
function memoryContext(memories: Pick<Memory, 'content' | 'type'>[], conflicts: [number, number][]): string {
  let ctx = memories.map((m, i) => `[${i + 1}] (${m.type}) ${m.content}`).join('\n');
  if (conflicts.length > 0) {
    ctx += '\n\nKNOWN CONFLICTS: ' + conflicts.map(([a, b]) => `[${a + 1}] contradicts [${b + 1}]`).join('; ') +
      '. When your answer touches a conflict, present both sides and say they disagree — never silently pick one.';
  }
  return ctx;
}

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
  conflicts: [number, number][] = [],
): Promise<string | null> {
  if (!query.trim() || memories.length === 0) return null;
  const context = memoryContext(memories, conflicts);
  return complete(
    `Question: ${query}\n\nStored memories:\n${context}\n\n` +
      `Answer the question in 1–3 sentences using ONLY the memories above, citing them like [1]. ` +
      `If they do not contain the answer, reply exactly: "No stored memory answers that."`,
    "You answer questions strictly from an AI agent's stored memories. Be concise and never invent facts beyond the memories provided.",
  );
}

/**
 * Rewrite the latest user message into a standalone retrieval query using the
 * conversation for context — follow-ups like "tell me more about that" retrieve
 * nothing on their own because the pronoun's referent lives in earlier turns.
 *
 * Falls back to the raw latest message whenever rewriting can't help or might
 * hurt: first user turn (already standalone), no LLM configured, or the LLM
 * returns something empty/rambling. Retrieval quality can only degrade to
 * exactly today's behavior.
 */
export async function condenseQuery(
  messages: ChatMessage[],
  complete: Completer = llmComplete,
): Promise<string> {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  if (!lastUser.trim()) return lastUser;
  if (messages.filter(m => m.role === 'user').length <= 1) return lastUser;

  // Last few turns are enough to resolve a reference; a long tail just dilutes.
  const transcript = messages.slice(-8).map(m => `${m.role}: ${m.content}`).join('\n');
  const rewritten = await complete(
    `Conversation:\n${transcript}\n\n` +
      `Rewrite the user's LATEST message as one short, standalone search query that names its subject explicitly ` +
      `(resolve "that", "it", "the second one", etc. from the conversation). Reply with the query only.`,
    'You rewrite chat follow-ups into standalone search queries for memory retrieval. Output only the query — no quotes, no explanation.',
  );
  const q = rewritten?.trim().replace(/^["']|["']$/g, '');
  if (!q || q.length > 300 || q.includes('\n')) return lastUser;
  return q;
}

/**
 * Multi-turn chat grounded in the supplied memories. The full message history
 * is passed to the LLM each turn; the memory context is injected as the system
 * prompt so every reply is grounded. Returns null when no LLM is configured.
 */
export async function chatWithMemories(
  messages: ChatMessage[],
  memories: Pick<Memory, 'content' | 'type'>[],
  chat: Chatter = llmChat,
  conflicts: [number, number][] = [],
): Promise<string | null> {
  if (messages.length === 0) return null;
  const context = memories.length > 0
    ? memoryContext(memories, conflicts)
    : '(no relevant memories found)';
  const system =
    `You are a memory assistant. Answer based ONLY on the stored memories below — ` +
    `never invent facts. Cite memories inline as [1], [2], etc. ` +
    `If the memories don't address the question, say so plainly.\n\n` +
    `STORED MEMORIES:\n${context}`;
  return chat(messages, system);
}
