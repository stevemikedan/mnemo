// Presentation helpers — turn raw memory fields into something a demo audience
// (not just an engineer) can read at a glance.

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'semantic';

/** Human labels for the terse type codes. */
export const TYPE_LABEL: Record<string, string> = {
  project: 'Decision',
  user: 'Preference',
  feedback: 'Correction',
  reference: 'Reference',
  episodic: 'Event',
  semantic: 'Concept',
};

/** One-line tooltips explaining each type. */
export const TYPE_HINT: Record<string, string> = {
  project: 'A decision, tech choice, or constraint for a project',
  user: 'A preference or working-style note about you',
  feedback: 'A correction or course-change to avoid repeating a mistake',
  reference: 'A pointer — file path, API endpoint, code location',
  episodic: 'Something that happened, in a session or over time',
  semantic: 'A concept, pattern, or piece of domain knowledge',
};

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

/** 'Global', or the project folder name — never a raw path. */
export function scopeName(scope: string): string {
  if (!scope || scope === 'global') return 'Global';
  const s = scope.startsWith('project:') ? scope.slice(8) : scope;
  const base = s.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || s;
}

/** Plain word for a 0..1 confidence — no decimals in front of a viewer. */
export function confidenceWord(c: number): string {
  if (c >= 0.75) return 'strong';
  if (c >= 0.5) return 'steady';
  if (c >= 0.25) return 'fading';
  return 'faint';
}

/** Five dots, filled proportionally to confidence. */
export function confidenceDots(c: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, c)) * 5);
  return '●'.repeat(filled) + '○'.repeat(5 - filled);
}

/**
 * Split a consolidation-merged memory into its primary text and the notes it
 * absorbed. NREM stores merges as `A\n  [Also: B]` — raw in a card that reads
 * like a bug. Callers show `text` and render `merged` as a tidy affordance.
 */
export function cleanContent(content: string): { text: string; merged: string[] } {
  const idx = content.indexOf('\n  [Also:');
  if (idx < 0) return { text: content, merged: [] };
  const text = content.slice(0, idx).trim();
  const merged = [...content.matchAll(/\[Also:\s*([\s\S]*?)\]/g)].map(m => m[1].trim());
  return { text, merged };
}
