#!/usr/bin/env node
import { startStdio } from './server.js';

// A stdio MCP server must never die mid-session: Node ≥15 terminates on any
// unhandled rejection, and one stray async error (a timer, a spawn callback,
// an abort event) would otherwise close the connection for the whole host.
// Log to stderr (never stdout — that's the protocol channel) and keep serving.
process.on('uncaughtException', (err) => {
  console.error('mnemo-mcp uncaught exception (recovered):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('mnemo-mcp unhandled rejection (recovered):', reason);
});

const dbPath = process.env['MNEMO_DB_PATH'];
startStdio(dbPath).catch(err => {
  console.error('mnemo-mcp error:', err);
  process.exit(1);
});
