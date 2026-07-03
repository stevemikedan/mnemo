import { describe, it, expect } from 'vitest';
import { answerFromMemories } from '../src/rag/answer.js';

const mem = (content: string, type = 'project') => ({ content, type: type as any });

describe('answerFromMemories', () => {
  it('returns null with no memories or an empty query', async () => {
    expect(await answerFromMemories('q', [], async () => 'x')).toBeNull();
    expect(await answerFromMemories('   ', [mem('m')], async () => 'x')).toBeNull();
  });

  it('grounds the prompt in the question + memories and returns the completion', async () => {
    let seen = '';
    const complete = async (p: string) => { seen = p; return 'It uses pnpm. [1]'; };
    const ans = await answerFromMemories('what package manager?', [mem('the project uses pnpm')], complete);
    expect(ans).toBe('It uses pnpm. [1]');
    expect(seen).toContain('what package manager?');
    expect(seen).toContain('the project uses pnpm');
  });

  it('returns null when no LLM is configured (completer returns null)', async () => {
    expect(await answerFromMemories('q', [mem('m')], async () => null)).toBeNull();
  });
});
