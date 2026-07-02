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
    /** 'none' (default), 'openai' (OpenAI-compatible /embeddings), or 'ollama'. */
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  };
  decay?: {
    /** Master switch for the decay/lifecycle pass. Default true. */
    enabled?: boolean;
    /** Base stability in days — the memory half-life before importance/access scaling. Default 30. */
    halfLifeDays?: number;
    /** Retention below this demotes active → dormant. Default 0.5. */
    dormantThreshold?: number;
    /** Retention below this demotes to archived. Default 0.2. */
    archiveThreshold?: number;
    /** Retention below this expires the memory. Default 0.05. */
    expireThreshold?: number;
    /** Memories at or above this importance are pinned (never demoted below active). Default 0.9. */
    protectImportance?: number;
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
