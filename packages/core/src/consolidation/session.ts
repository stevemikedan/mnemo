import type { MemoryType } from '../graph/schema.js';

export interface ExtractedSignal {
  content: string;
  type: MemoryType;
  importance: number;
  tags: string[];
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
