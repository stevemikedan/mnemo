import { readConfig } from './config.js';

type Provider = 'anthropic' | 'openai' | 'ollama' | 'none';

function resolveProvider(): Provider {
  const config = readConfig();
  if (config.consolidation?.provider) return config.consolidation.provider;
  if (process.env['ANTHROPIC_API_KEY']) return 'anthropic';
  return 'none';
}

function resolveApiKey(): string | null {
  const config = readConfig();
  const raw = config.consolidation?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? null;
  if (!raw) return null;
  return raw.replace('${ANTHROPIC_API_KEY}', process.env['ANTHROPIC_API_KEY'] ?? '');
}

export async function llmComplete(prompt: string, system?: string): Promise<string | null> {
  const provider = resolveProvider();
  if (provider === 'none') return null;
  if (provider === 'anthropic') return anthropicComplete(prompt, system);
  return null;
}

async function anthropicComplete(prompt: string, system: string | undefined): Promise<string | null> {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;

  const config = readConfig();
  const model = config.consolidation?.model ?? 'claude-haiku-4-5-20251001';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system: system ?? 'You are a memory consolidation assistant. Be concise.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json() as { content?: { text: string }[] };
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}
