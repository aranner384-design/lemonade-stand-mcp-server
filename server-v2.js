#!/usr/bin/env node
// Lemonade Stand V2 remote MCP entrypoint.
// Keeps original server.js unchanged on the main branch.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  McpError, ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { GameStore } from './src/store.js';
import { newGame, buySupplies, setPrice, sellLemonade, nextDay } from './src/game.js';

const PORT = Number(process.env.PORT ?? 8044);
const HOST = process.env.HOST ?? '127.0.0.1';
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const store = new GameStore(process.env.LEMONADE_DB_PATH ?? './data/lemonade.sqlite');

const string = { type: 'string' };
const operationId = {
  type: 'string', minLength: 1, maxLength: 128,
  description: 'Stable unique identifier for this user operation. Reuse the same ID on a network retry.'
};
const gameId = { ...string, description: 'Optional game ID. Omit to use the active save.' };
const quantity = { type: 'integer', minimum: 0 };
const schema = (properties, required = []) => ({
  type: 'object', additionalProperties: false, properties, required
});
const writeSchema = (properties = {}) =>
  schema({ gameId, operationId, ...properties }, ['operationId']);
const tools = [
  {
    name: 'start_game',
    description: 'Start the first game or resume the existing active game; never replaces a save.',
    inputSchema: schema({})
  },
  {
    name: 'get_game_state',
    description: 'Read a saved game without modifying it. Defaults to the active save.',
    inputSchema: schema({ gameId })
  },
  {
    name: 'resume_game',
    description: 'Read the current active saved game without creating a new game.',
    inputSchema: schema({})
  },
  {
    name: 'new_game',
    description: 'Create a brand-new 14-day game and archive the current game. Only use after the player explicitly asks to start over.',
    inputSchema: schema({ confirm: { type: 'boolean', const: true } }, ['confirm'])
  },
  {
    name: 'buy_supplies',
    description: 'Purchase nonnegative integer quantities. This spends money. Provide a stable operationId to prevent retry duplicates.',
    inputSchema: writeSchema({ cups: quantity, lemons: quantity, sugar: quantity, ice: quantity })
  },
  {
    name: 'set_price',
    description: 'Set lemonade price per cup in dollars, $0.01 to $100 with two decimal places at most.',
    inputSchema: { ...writeSchema({ price: { type: 'number', exclusiveMinimum: 0, maximum: 100 } }),
      required: ['operationId', 'price'] }
  },
  {
    name: 'sell_lemonade',
    description: 'Open for business and settle the current day exactly once, after setting price.',
    inputSchema: writeSchema()
  },
  {
    name: 'next_day',
    description: 'Advance after the daily sales report. On day 14, finish the game.',
    inputSchema: writeSchema()
  }
];

function response(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function requiredGameId(args) {
  const id = args?.gameId ?? store.getActive()?.gameId;
  if (!id) throw new Error('No active saved game. Call start_game first.');
  return id;
}

function callTool(name, args = {}) {
  if (!tools.some(t => t.name === name)) {
    throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool: ' + name);
  }
  switch (name) {
    case 'start_game':
      return store.startOrResume(randomUUID(), newGame);
    case 'resume_game':
      return store.getActive() ?? { message: 'No active saved game.' };
    case 'get_game_state':
      return (args.gameId ? store.get(args.gameId) : store.getActive()) ??
        { message: 'Game not found.' };
    case 'new_game':
      if (args.confirm !== true) throw new Error('Explicit confirmation is required.');
      return store.startFresh(randomUUID(), newGame);
    case 'buy_supplies': {
      const quantities = {};
      for (const key of ['cups', 'lemons', 'sugar', 'ice']) {
        if (args[key] !== undefined) quantities[key] = args[key];
      }
      return store.apply(requiredGameId(args), args.operationId, name, quantities,
        state => buySupplies(state, quantities));
    }
    case 'set_price':
      return store.apply(requiredGameId(args), args.operationId, name, { price: args.price },
        state => setPrice(state, args.price));
    case 'sell_lemonade':
      return store.apply(requiredGameId(args), args.operationId, name, {},
        state => sellLemonade(state));
    case 'next_day':
      return store.apply(requiredGameId(args), args.operationId, name, {},
        state => nextDay(state));
    default:
      throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool: ' + name);
  }
}

function buildServer() {
  const server = new Server(
    { name: 'lemonade-stand-v2', version: '2.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return response({ success: true, result: callTool(request.params.name, request.params.arguments ?? {}) });
    } catch (error) {
      return { ...response({ success: false, error: error.message }), isError: true };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: store.listGames().map(row => ({
      uri: 'game://' + row.gameId,
      name: 'Game ' + row.gameId,
      mimeType: 'application/json',
      description: row.active ? 'Active lemonade game' : 'Archived lemonade game'
    }))
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const match = /^game:\/\/(.+)$/.exec(request.params.uri);
    if (!match) throw new McpError(ErrorCode.InvalidRequest, 'Invalid game resource');
    const value = store.get(match[1]);
    if (!value) throw new McpError(ErrorCode.InvalidRequest, 'Game not found');
    return { contents: [{
      uri: request.params.uri,
      mimeType: 'application/json',
      text: JSON.stringify(value)
    }] };
  });
  return server;
}

if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535 ||
    !MCP_PATH.startsWith('/') || MCP_PATH.length < 2) {
  throw new Error('Invalid PORT or MCP_PATH configuration');
}

const http = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  // Stateless transport: create a fresh MCP server per HTTP request.
  // All persistent game data lives in SQLite, not in a transport session.
  try {
    const mcp = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

http.listen(PORT, HOST, () => {
  console.error('Lemonade V2 on http://' + HOST + ':' + PORT + MCP_PATH);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    http.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
