import { llmComplete } from './llm.js';
import type { MemoryType } from '../graph/schema.js';

export interface ExtractedSignal {
  content: string;
  type: MemoryType;
  importance: number;
  tags: string[];
}

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference', 'episodic', 'semantic'];

/**
 * Distill a transcript into clean, self-contained memories using the
 * consolidation LLM: referents resolved, conversational boilerplate stripped,
 * each a standalone fact rather than a raw sentence fragment. This is the
 * quality upgrade over regex extraction — "don't do that" becomes "Avoid X
 * because Y" with the subject spelled out.
 *
 * Returns null when no LLM is configured or the response can't be parsed, so
 * callers fall back to extractSignals (the regex path). `complete` is injectable
 * for testing.
 */
export async function distillSignals(
  transcript: string,
  complete: (prompt: string, system?: string) => Promise<string | null> = llmComplete,
): Promise<ExtractedSignal[] | null> {
  if (!transcript.trim()) return [];
  const resp = await complete(
    `From the conversation below, extract the durable facts worth remembering long-term — decisions, ` +
      `preferences, corrections, project facts, concepts. Write each as ONE self-contained sentence a ` +
      `stranger could understand with no other context: resolve pronouns ("that", "it") to their subject, ` +
      `drop conversational filler ("remember that", "we decided"), and state the fact plainly. Skip small talk ` +
      `and anything transient.\n\n` +
      `Reply with ONLY a JSON array; each item: {"content": string, "type": one of ${JSON.stringify(MEMORY_TYPES)}, ` +
      `"importance": number 0..1, "tags": string[]}. Empty array if nothing is worth keeping.\n\n` +
      `Conversation:\n${transcript}`,
    'You distill conversations into a knowledge base of clear, self-contained memories. Output only valid JSON.',
  );
  if (!resp) return null;

  // Tolerate models that wrap JSON in prose or code fences.
  const start = resp.indexOf('[');
  const end = resp.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resp.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const signals: ExtractedSignal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (content.length < MIN_CONTENT_LENGTH) continue;
    const type = MEMORY_TYPES.includes(o.type as MemoryType) ? (o.type as MemoryType) : 'project';
    const importance = typeof o.importance === 'number' && o.importance >= 0 && o.importance <= 1 ? o.importance : 0.6;
    const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 5) : [];
    signals.push({ content, type, importance, tags });
  }
  return signals;
}

interface Pattern {
  regex: RegExp;
  type: MemoryType;
  importance: number;
  tags: string[];
}

const PATTERNS: Pattern[] = [
  // Explicit corrections / negative feedback
  {
    regex: /(?:no[,.]?\s*(?:actually|instead|wait)|don'?t\s+(?:do|use|add|create|write|make)\s+(?:that|this|\w+)|stop\s+doing|avoid\s+(?:doing|using|adding)|never\s+(?:do|use|add|write))\s+[^\n.!?]{10,100}/gi,
    type: 'feedback', importance: 0.85, tags: ['correction'],
  },
  // User preferences (stated directly)
  {
    regex: /I\s+(?:prefer|always|hate|dislike|want(?:\s+you)?\s+to|need(?:\s+you)?\s+to|like\s+(?:to|when|it\s+when))\s+[^\n.!?]{10,100}/gi,
    type: 'user', importance: 0.75, tags: ['preference'],
  },
  // Make sure / always remember / remember that
  {
    regex: /(?:make\s+sure\s+(?:to\s+)?always?|(?:always?|remember)\s+(?:use|check|ensure|include|add|keep)\s+|remember\s+that)\s*[^\n.!?]{10,100}/gi,
    type: 'feedback', importance: 0.75, tags: ['rule'],
  },
  // Decisions and plans
  {
    regex: /(?:we(?:'ve)?\s+decided|going\s+forward|the\s+plan\s+is|let'?s\s+(?:use|go\s+with|keep|make)\s+|we(?:'re|'ll|\s+(?:are|will))\s+(?:going\s+to|using|keeping))\s*[^\n.!?]{10,100}/gi,
    type: 'project', importance: 0.8, tags: ['decision'],
  },
  // Project / repo facts
  {
    regex: /(?:this\s+(?:project|repo|codebase|app|package)\s+(?:uses?|is|has|requires?|runs?)|the\s+(?:pattern|convention|approach)\s+(?:here|in\s+this\s+(?:project|repo))\s+is)\s*[^\n.!?]{10,100}/gi,
    type: 'project', importance: 0.7, tags: ['fact'],
  },
];

const MIN_CONTENT_LENGTH = 15;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function extractSignals(transcript: string): ExtractedSignal[] {
  const seen = new Set<string>();
  const signals: ExtractedSignal[] = [];

  for (const { regex, type, importance, tags } of PATTERNS) {
    for (const match of transcript.matchAll(regex)) {
      const raw = match[0].trim();
      if (raw.length < MIN_CONTENT_LENGTH) continue;
      const key = normalize(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      // Capitalize first letter for readability
      const content = raw.charAt(0).toUpperCase() + raw.slice(1);
      signals.push({ content, type, importance, tags: [...tags] });
    }
  }

  return signals;
}
