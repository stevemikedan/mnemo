import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readConfig, reloadConfig, __setConfig } from '../src/consolidation/config.js';

let configPath: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-cfg-'));
  configPath = join(dir, 'config.json');
  process.env.MNEMO_CONFIG_PATH = configPath;
  __setConfig(null); // reset memo + pin
});

afterEach(() => {
  delete process.env.MNEMO_CONFIG_PATH;
  __setConfig(null);
  vi.useRealTimers();
});

describe('config TTL memoization', () => {
  it('memoizes within the TTL, re-reads from disk after it expires', () => {
    vi.useFakeTimers();
    writeFileSync(configPath, JSON.stringify({ embeddings: { provider: 'local' } }));
    expect(readConfig().embeddings?.provider).toBe('local');

    // Edit the file — within the TTL the memo still serves the old value.
    writeFileSync(configPath, JSON.stringify({ embeddings: { provider: 'ollama' } }));
    expect(readConfig().embeddings?.provider).toBe('local');

    // Past the TTL the edit is picked up with no reload/restart.
    vi.advanceTimersByTime(3_000);
    expect(readConfig().embeddings?.provider).toBe('ollama');
  });

  it('reloadConfig applies edits immediately, without waiting out the TTL', () => {
    writeFileSync(configPath, JSON.stringify({ consolidation: { provider: 'ollama' } }));
    expect(readConfig().consolidation?.provider).toBe('ollama');

    writeFileSync(configPath, JSON.stringify({ consolidation: { provider: 'claude-cli' } }));
    reloadConfig();
    expect(readConfig().consolidation?.provider).toBe('claude-cli');
  });

  it('__setConfig pins: TTL expiry never replaces a test-injected config', () => {
    vi.useFakeTimers();
    writeFileSync(configPath, JSON.stringify({ embeddings: { provider: 'ollama' } }));
    __setConfig({ embeddings: { provider: 'local' } });

    vi.advanceTimersByTime(10_000);
    expect(readConfig().embeddings?.provider).toBe('local'); // still pinned, not 'ollama'

    __setConfig(null); // unpin → next read hits disk
    expect(readConfig().embeddings?.provider).toBe('ollama');
  });

  it('missing file yields {} but keeps checking, so a config created later is found', () => {
    vi.useFakeTimers();
    expect(readConfig()).toEqual({});

    writeFileSync(configPath, JSON.stringify({ embeddings: { provider: 'local' } }));
    vi.advanceTimersByTime(3_000);
    expect(readConfig().embeddings?.provider).toBe('local');
  });
});
