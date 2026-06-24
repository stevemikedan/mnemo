import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface MnemoConfig {
  consolidation?: {
    provider?: 'anthropic' | 'openai' | 'ollama' | 'none';
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  embeddings?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
}

let _config: MnemoConfig | null = null;

export function readConfig(): MnemoConfig {
  if (_config) return _config;
  const path = join(homedir(), '.mnemo', 'config.json');
  if (!existsSync(path)) return (_config = {});
  try {
    _config = JSON.parse(readFileSync(path, 'utf-8'));
    return _config!;
  } catch {
    return (_config = {});
  }
}
