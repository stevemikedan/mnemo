#!/usr/bin/env node
import { startStdio } from './server.js';

const dbPath = process.env['MNEMO_DB_PATH'];
startStdio(dbPath).catch(err => {
  console.error('mnemo-mcp error:', err);
  process.exit(1);
});
