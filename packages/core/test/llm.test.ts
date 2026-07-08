import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { llmComplete } from '../src/consolidation/llm.js';
import { __setConfig } from '../src/consolidation/config.js';

// Fake OpenAI-compatible /chat/completions endpoint.
let server: Server;
let base: string;
let lastBody: any = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/chat/completions')) {
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
