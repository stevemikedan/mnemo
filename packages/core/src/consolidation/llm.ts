import { spawn } from 'child_process';
import { readConfig } from './config.js';

type Provider = 'anthropic' | 'claude-cli' | 'openai' | 'ollama' | 'none';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

function resolveProvider(): Provider {
  const config = readConfig();
  if (config.consolidation?.provider) return config.consolidation.provider;
  if (process.env['ANTHROPIC_API_KEY']) return 'anthropic';
  return 'none';
}

function resolveReconcileProvider(): Provider {
  const config = readConfig();
  if (config.consolidation?.reconcileProvider) return config.consolidation.reconcileProvider;
  return resolveProvider();
}

function resolveApiKey(): string | null {
  const config = readConfig();
  const raw = config.consolidation?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? null;
  if (!raw) return null;
  return raw.replace('${ANTHROPIC_API_KEY}', process.env['ANTHROPIC_API_KEY'] ?? '');
}

// ── Provider chain + telemetry ────────────────────────────────────────────────

interface ProviderSpec { provider: Exclude<Provider, 'none'>; model?: string; }

/** Default model string for a provider when none is configured — mirrors the
 * per-provider defaults in the completion functions so telemetry matches reality. */
function defaultModel(provider: Provider): string {
  return provider === 'claude-cli' ? 'haiku'
    : provider === 'anthropic' ? 'claude-haiku-4-5-20251001'
    : provider === 'ollama' ? 'llama3.2'
    : provider === 'openai' ? 'gpt-4o-mini'
    : 'none';
}

/** Ordered providers to try for a role: the primary, then the shared fallback
 * chain. 'none' entries are dropped so an unconfigured primary still lets the
 * fallback run. */
function resolveChain(role: 'main' | 'reconcile'): ProviderSpec[] {
  const cfg = readConfig().consolidation ?? {};
  const primaryProvider = role === 'reconcile' ? resolveReconcileProvider() : resolveProvider();
  const primaryModel = role === 'reconcile' ? (cfg.reconcileModel ?? cfg.model) : cfg.model;
  const chain: ProviderSpec[] = [];
  if (primaryProvider !== 'none') chain.push({ provider: primaryProvider, model: primaryModel });
  for (const f of cfg.fallback ?? []) {
    if (f.provider && f.provider !== ('none' as unknown)) chain.push({ provider: f.provider, model: f.model });
  }
  return chain;
}

// Per-run telemetry: which model produced each successful completion, and how
// many calls fell through to a non-primary provider. dream() resets this at the
// start of a run and reads it into the consolidation log.
let _lastModel = 'heuristic';
const _counts = new Map<string, number>();
let _fallbacks = 0;

/** Model string (e.g. 'claude-cli/haiku') of the most recent completion, or
 * 'heuristic' when no provider produced text. Read immediately after an awaited
 * llm* call; dream()'s sequential loop makes this per-verdict accurate. */
export function lastModelUsed(): string { return _lastModel; }

export function resetLlmTelemetry(): void {
  _lastModel = 'heuristic';
  _counts.clear();
  _fallbacks = 0;
}

/** Snapshot of completions this run, keyed by model, plus the fallback count. */
export function getLlmTelemetry(): { byModel: Record<string, number>; fallbacks: number } {
  return { byModel: Object.fromEntries(_counts), fallbacks: _fallbacks };
}

function recordSuccess(spec: ProviderSpec, wasFallback: boolean): void {
  _lastModel = `${spec.provider}/${spec.model ?? defaultModel(spec.provider)}`;
  _counts.set(_lastModel, (_counts.get(_lastModel) ?? 0) + 1);
  if (wasFallback) _fallbacks++;
}

function completeVia(spec: ProviderSpec, prompt: string, system?: string): Promise<string | null> {
  if (spec.provider === 'claude-cli') return claudeCliComplete(prompt, system, spec.model);
  if (spec.provider === 'anthropic') return anthropicComplete(prompt, system, spec.model);
  return openaiCompatComplete(spec.provider, prompt, system, spec.model);
}

function chatVia(spec: ProviderSpec, messages: ChatMessage[], system?: string): Promise<string | null> {
  if (spec.provider === 'claude-cli') return claudeCliChat(messages, system, spec.model);
  if (spec.provider === 'anthropic') return anthropicChat(messages, system, spec.model);
  return openaiCompatChat(spec.provider, messages, system, spec.model);
}

/** Walk the role's chain, returning the first non-null completion and recording
 * which model produced it. Returns null (→ caller's heuristic) when every
 * provider in the chain fails; _lastModel is left as 'heuristic'. */
async function completeChain(role: 'main' | 'reconcile', prompt: string, system?: string): Promise<string | null> {
  const chain = resolveChain(role);
  _lastModel = 'heuristic';
  for (let i = 0; i < chain.length; i++) {
    const text = await completeVia(chain[i], prompt, system);
    if (text != null) { recordSuccess(chain[i], i > 0); return text; }
  }
  return null;
}

async function chatChain(role: 'main' | 'reconcile', messages: ChatMessage[], system?: string): Promise<string | null> {
  const chain = resolveChain(role);
  _lastModel = 'heuristic';
  for (let i = 0; i < chain.length; i++) {
    const text = await chatVia(chain[i], messages, system);
    if (text != null) { recordSuccess(chain[i], i > 0); return text; }
  }
  return null;
}

/**
 * Human/queryable description of the model llmComplete would use right now,
 * e.g. 'ollama/llama3.2:3b' or 'claude-cli/haiku'. Mirrors the per-provider
 * defaults in the completion functions below so the stamp is always what
 * actually ran. 'none' when no provider is active.
 */
export function describeConsolidationModel(): string {
  const provider = resolveProvider();
  if (provider === 'none') return 'none';
  const model = readConfig().consolidation?.model ?? (
    provider === 'claude-cli' ? 'haiku'
    : provider === 'anthropic' ? 'claude-haiku-4-5-20251001'
    : provider === 'ollama' ? 'llama3.2'
    : 'gpt-4o-mini'
  );
  return `${provider}/${model}`;
}

export function describeReconcileModel(): string {
  const provider = resolveReconcileProvider();
  if (provider === 'none') return 'none';
  const cfg = readConfig().consolidation ?? {};
  const model = cfg.reconcileModel ?? cfg.model ?? (
    provider === 'claude-cli' ? 'haiku'
    : provider === 'anthropic' ? 'claude-haiku-4-5-20251001'
    : provider === 'ollama' ? 'llama3.2'
    : 'gpt-4o-mini'
  );
  return `${provider}/${model}`;
}

/** Single completion using the main provider chain (primary → fallback). Returns
 * null when every provider fails, so callers fall back to their own heuristic. */
export async function llmComplete(prompt: string, system?: string): Promise<string | null> {
  return completeChain('main', prompt, system);
}

/** Like llmComplete but leads with the reconcile-specific provider. */
export async function llmReconcileComplete(prompt: string, system?: string): Promise<string | null> {
  return completeChain('reconcile', prompt, system);
}

/**
 * Multi-turn chat leading with the reconcile provider (higher quality, better
 * for user-facing responses), then the fallback chain. Each provider receives
 * the full message history; claude-cli formats it as a transcript since it only
 * accepts a text prompt.
 */
export async function llmChat(messages: ChatMessage[], system?: string): Promise<string | null> {
  return chatChain('reconcile', messages, system);
}

const LLM_TIMEOUT_MS = 60_000;

/**
 * Generic OpenAI-compatible chat completion — covers OpenAI, Gemini (via
 * Google's compat endpoint), Groq, Ollama, LM Studio, and anything else that
 * speaks POST {baseUrl}/chat/completions. Returns null on any failure so
 * callers fall back gracefully.
 */
async function openaiCompatComplete(provider: 'openai' | 'ollama', prompt: string, system: string | undefined, modelOverride?: string): Promise<string | null> {
  const cfg = readConfig().consolidation ?? {};
  const baseUrl = (cfg.baseUrl ?? (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const model = modelOverride ?? cfg.model ?? (provider === 'ollama' ? 'llama3.2' : 'gpt-4o-mini');
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
function claudeCliComplete(prompt: string, system: string | undefined, modelOverride?: string): Promise<string | null> {
  const model = modelOverride ?? readConfig().consolidation?.model ?? 'haiku';
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

async function anthropicComplete(prompt: string, system: string | undefined, modelOverride?: string): Promise<string | null> {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;

  const config = readConfig();
  const model = modelOverride ?? config.consolidation?.model ?? 'claude-haiku-4-5-20251001';

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

// ── Chat (multi-turn) variants ────────────────────────────────────────────────

/** claude-cli doesn't support message arrays — format history as a transcript. */
function claudeCliChat(messages: ChatMessage[], system: string | undefined, modelOverride?: string): Promise<string | null> {
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return claudeCliComplete(transcript, system, modelOverride);
}

async function openaiCompatChat(provider: 'openai' | 'ollama', messages: ChatMessage[], system: string | undefined, modelOverride?: string): Promise<string | null> {
  const cfg = readConfig().consolidation ?? {};
  const baseUrl = (cfg.baseUrl ?? (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const model = modelOverride ?? cfg.model ?? (provider === 'ollama' ? 'llama3.2' : 'gpt-4o-mini');
  const apiKey = cfg.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'none';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          { role: 'system', content: system ?? 'You are a helpful assistant.' },
          ...messages,
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

async function anthropicChat(messages: ChatMessage[], system: string | undefined, modelOverride?: string): Promise<string | null> {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  const model = modelOverride ?? readConfig().consolidation?.model ?? 'claude-haiku-4-5-20251001';

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
        max_tokens: 512,
        system: system ?? 'You are a helpful assistant.',
        messages,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { content?: { text: string }[] };
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}
