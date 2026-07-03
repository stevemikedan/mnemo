import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Run fn with console.log/console.error suppressed. The AsterMind library logs
 * to stdout on construction/train/load, which would corrupt the MCP stdio
 * stream — every ELM/vectorizer call must be wrapped in this.
 */
export function silenced<T>(fn: () => T): T {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** ~/.mnemo, created if missing. */
export function mnemoDir(): string {
  const dir = join(homedir(), '.mnemo');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to a model file under ~/.mnemo, e.g. modelPath('elm-type-classifier.json'). */
export function modelPath(name: string): string {
  return join(mnemoDir(), name);
}

export function loadJSON<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function saveJSON(path: string, obj: unknown): void {
  mnemoDir();
  writeFileSync(path, JSON.stringify(obj));
}
