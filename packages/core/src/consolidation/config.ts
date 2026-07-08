import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface MnemoConfig {
  consolidation?: {
    /** 'none', 'claude-cli' (reuse the local Claude Code login — no API key), or 'anthropic' (direct API, needs apiKey). */
    provider?: 'anthropic' | 'claude-cli' | 'openai' | 'ollama' | 'none';
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  embeddings?: {
    /** 'none' (default), 'local' (built-in hashing), 'astermind' (on-device TF-IDF), 'openai', or 'ollama'. */
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    /** Vector size: dimension for 'local' (default 256); max vocabulary for 'astermind' (default 1024). */
    dimensions?: number;
  };
  ml?: {
    /** ELM type suggestion on remember(). Off by default. */
    typeSuggest?: { enabled?: boolean; minConfidence?: number; minMargin?: number };
    /** KNN tag suggestion on remember(). Off by default. */
    tagSuggest?: { enabled?: boolean; minSim?: number; voteThreshold?: number; maxTags?: number };
    /** Write-time near-duplicate warning. On by default (warn-only, never blocks). */
    dedup?: { enabled?: boolean; overlapThreshold?: number; cosineThreshold?: number };
    /** Consolidation pre-screener (logging now; gating later). Off by default. */
    prescreen?: { enabled?: boolean; logging?: boolean };
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
  const path = process.env['MNEMO_CONFIG_PATH'] ?? join(homedir(), '.mnemo', 'config.json');
  if (!existsSync(path)) return (_config = {});
  try {
    _config = JSON.parse(readFileSync(path, 'utf-8'));
    return _config!;
  } catch {
    return (_config = {});
  }
}

/**
 * Test seam: override the memoized config directly. Pass an object to force a
 * config (e.g. `{ embeddings: { provider: 'local' } }`), or null to reset so
 * the next readConfig re-reads from disk. Not for production use.
 */
export function __setConfig(cfg: MnemoConfig | null): void {
  _config = cfg;
}

/**
 * Clear the memoized config so the next readConfig re-reads from disk. Call
 * after writing config.json at runtime (e.g. from a settings UI) so changes
 * apply without a process restart.
 */
export function reloadConfig(): void {
  _config = null;
}
