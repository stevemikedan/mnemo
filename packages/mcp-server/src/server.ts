import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStore, GraphStore, RecallEngine } from '@mnemo/core';
import { registerWriteTools } from './tools/write.js';
import { registerReadTools } from './tools/read.js';
import { registerDreamTools } from './tools/dream.js';

export async function createServer(dbPath?: string): Promise<McpServer> {
  const store = new MemoryStore(dbPath);
  const graph = new GraphStore(store.db);
  const recall = new RecallEngine(store, graph);

  const server = new McpServer({
    name: 'mnemo',
    version: '0.1.0',
  });

  registerWriteTools(server, store, graph);
  registerReadTools(server, store, graph, recall);
  registerDreamTools(server, store, graph);

  return server;
}

export async function startStdio(dbPath?: string): Promise<void> {
  const server = await createServer(dbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
