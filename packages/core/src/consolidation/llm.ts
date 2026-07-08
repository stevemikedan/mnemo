import { spawn } from 'child_process';
import { readConfig } from './config.js';

type Provider = 'anthropic' | 'claude-cli' | 'openai' | 'ollama' | 'none';

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
  if (provider === 'claude-cli') return claudeCliComplete(prompt, system);
  if (provider === 'anthropic') return anthropicComplete(prompt, system);
  if (provider === 'openai' || provider === 'ollama') return openaiCompatComplete(provider, prompt, system);
  return null;
}

const LLM_TIMEOUT_MS = 60_000;

/**
 * Generic OpenAI-compatible chat completion — covers OpenAI, Gemini (via
 * Google's compat endpoint), Groq, Ollama, LM Studio, and anything else that
 * speaks POST {baseUrl}/chat/completions. Returns null on any failure so
 * callers fall back gracefully.
 */
async function openaiCompatComplete(provider: 'openai' | 'ollama', prompt: string, system: string | undefined): Promise<string | null> {
  const cfg = readConfig().consolidation ?? {};
  const baseUrl = (cfg.baseUrl ?? (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const model = cfg.model ?? (provider === 'ollama' ? 'llama3.2' : 'gpt-4o-mini');
  const apiKey = cfg.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'none'; // ollama ignores it, but the header must exist

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [
          { role: 'system', content: system ?? 'You are a memory consolidation assistant. Be concise.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Complete via the local Claude Code CLI in headless mode (`claude -p`),
 * reusing the user's existing login — no API key required. Returns null on any
 * failure so callers fall back gracefully.
 */
function claudeCliComplete(prompt: string, system: string | undefined): Promise<string | null> {
  const model = readConfig().consolidation?.model ?? 'haiku';
  const full = system ? `${system}\n\n${prompt}` : prompt;
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = spawn('claude', ['-p', '--output-format', 'text', '--model', model], {
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: true, // resolve claude.cmd on Windows / claude on unix
      });
      const timer = setTimeout(() => { child.kill(); done(null); }, 120_000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', (code) => { clearTimeout(timer); done(code === 0 && out.trim() ? out.trim() : null); });
      child.stdin.write(full);
      child.stdin.end();
    } catch {
      done(null);
    }
  });
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
