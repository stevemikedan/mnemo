import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import { llmComplete, getLlmTelemetry, resetLlmTelemetry, lastModelUsed } from '../src/consolidation/llm.js';
import { __setConfig } from '../src/consolidation/config.js';

// Fake OpenAI-compatible /chat/completions endpoint. `failFirst` lets a test
// make the next N requests 500 so the fallback chain has something to fall past.
let server: Server;
let base: string;
let lastBody: any = null;
let failFirst = 0;
let reqSeen = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/chat/completions')) {
        reqSeen++;
        if (reqSeen <= failFirst) { res.statusCode = 500; res.end('{}'); return; }
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong from compat' } }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
});

afterAll(() => server.close());
beforeEach(() => { failFirst = 0; reqSeen = 0; resetLlmTelemetry(); });

describe('llmComplete — OpenAI-compatible providers', () => {
  it("provider 'openai' posts to {baseUrl}/chat/completions and returns the content", async () => {
    __setConfig({ consolidation: { provider: 'openai', baseUrl: base, model: 'test-model', apiKey: 'k' } });
    const out = await llmComplete('ping', 'sys');
    expect(out).toBe('pong from compat');
    expect(lastBody.model).toBe('test-model');
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(lastBody.messages[1]).toEqual({ role: 'user', content: 'ping' });
  });

  it("provider 'ollama' uses the same compat path", async () => {
    __setConfig({ consolidation: { provider: 'ollama', baseUrl: base, model: 'llama3.2' } });
    expect(await llmComplete('ping')).toBe('pong from compat');
  });

  it('returns null on an unreachable endpoint (graceful fallback)', async () => {
    __setConfig({ consolidation: { provider: 'openai', baseUrl: 'http://localhost:9', model: 'x', apiKey: 'k' } });
    expect(await llmComplete('ping')).toBeNull();
  });

  it("provider 'none' returns null", async () => {
    __setConfig({ consolidation: { provider: 'none' } });
    expect(await llmComplete('ping')).toBeNull();
  });
});

describe('consolidation fallback chain', () => {
  it('falls through to the fallback provider when the primary fails, and records it', async () => {
    failFirst = 1; // the primary's request 500s; the fallback's succeeds
    __setConfig({ consolidation: {
      provider: 'openai', baseUrl: base, model: 'primary-model', apiKey: 'k',
      fallback: [{ provider: 'ollama', model: 'fallback-model' }],
    } });
    expect(await llmComplete('ping')).toBe('pong from compat');
    expect(lastModelUsed()).toBe('ollama/fallback-model');
    expect(getLlmTelemetry().fallbacks).toBe(1);
    expect(getLlmTelemetry().byModel['ollama/fallback-model']).toBe(1);
  });

  it('uses the primary and records no fallback when the primary succeeds', async () => {
    __setConfig({ consolidation: {
      provider: 'openai', baseUrl: base, model: 'primary-model', apiKey: 'k',
      fallback: [{ provider: 'ollama', model: 'fallback-model' }],
    } });
    expect(await llmComplete('ping')).toBe('pong from compat');
    expect(lastModelUsed()).toBe('openai/primary-model');
    expect(getLlmTelemetry().fallbacks).toBe(0);
  });

  it('returns null and reports heuristic when the whole chain fails', async () => {
    failFirst = 5; // both primary and fallback 500
    __setConfig({ consolidation: {
      provider: 'openai', baseUrl: base, model: 'primary-model', apiKey: 'k',
      fallback: [{ provider: 'ollama', model: 'fallback-model' }],
    } });
    expect(await llmComplete('ping')).toBeNull();
    expect(lastModelUsed()).toBe('heuristic');
  });

  it('still runs the fallback even when the primary provider is none', async () => {
    __setConfig({ consolidation: {
      provider: 'none', baseUrl: base,
      fallback: [{ provider: 'ollama', model: 'only-fallback' }],
    } });
    expect(await llmComplete('ping')).toBe('pong from compat');
    expect(lastModelUsed()).toBe('ollama/only-fallback');
    // First (and only) chain entry succeeded — not counted as a fallthrough.
    expect(getLlmTelemetry().fallbacks).toBe(0);
  });
});
