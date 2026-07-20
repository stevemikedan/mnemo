import { describe, it, expect } from 'vitest';
import { answerFromMemories, condenseQuery } from '../src/rag/answer.js';
import type { ChatMessage } from '../src/rag/answer.js';

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

  it('calls out known conflicts in the grounding context', async () => {
    let seen = '';
    const complete = async (p: string) => { seen = p; return 'They disagree [1][2].'; };
    await answerFromMemories('timeout?', [mem('timeout is 30s'), mem('timeout is 5s')], complete, [[0, 1]]);
    expect(seen).toContain('[1] contradicts [2]');
    expect(seen).toContain('present both sides');
  });
});

describe('condenseQuery', () => {
  const thread = (...contents: string[]): ChatMessage[] =>
    contents.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content }));

  it('passes the first user turn through untouched — no LLM call', async () => {
    let called = false;
    const q = await condenseQuery(thread('how do we deploy?'), async () => { called = true; return 'x'; });
    expect(q).toBe('how do we deploy?');
    expect(called).toBe(false);
  });

  it('rewrites a follow-up using the conversation', async () => {
    let seen = '';
    const complete = async (p: string) => { seen = p; return 'github actions deployment pipeline details'; };
    const q = await condenseQuery(thread('how do we deploy?', 'Via GitHub Actions [1].', 'tell me more about that'), complete);
    expect(q).toBe('github actions deployment pipeline details');
    expect(seen).toContain('tell me more about that');
    expect(seen).toContain('Via GitHub Actions');
  });

  it('falls back to the raw message when the LLM is unavailable or rambles', async () => {
    const msgs = thread('how do we deploy?', 'Via GitHub Actions [1].', 'why though?');
    expect(await condenseQuery(msgs, async () => null)).toBe('why though?');
    expect(await condenseQuery(msgs, async () => 'a rambling\nmultiline\nnon-query')).toBe('why though?');
    expect(await condenseQuery(msgs, async () => 'x'.repeat(400))).toBe('why though?');
  });

  it('strips wrapping quotes from the rewrite', async () => {
    const msgs = thread('deploy?', 'GitHub Actions.', 'more');
    expect(await condenseQuery(msgs, async () => '"github actions deployment"')).toBe('github actions deployment');
  });
});
