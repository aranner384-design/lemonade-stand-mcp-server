import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startService(port, database) {
  const child = spawn(process.execPath, ['server-v2.js'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LEMONADE_DB_PATH: database },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const health = 'http://127.0.0.1:' + port + '/health';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Service exited: ' + stderr);
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(500) });
      if (response.ok) return child;
    } catch { /* still starting */ }
    await sleep(50);
  }
  child.kill('SIGTERM');
  throw new Error('Service did not start: ' + stderr);
}

async function stopService(child) {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

async function connect(port) {
  const client = new Client({ name: 'lemonade-v2-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'))
  );
  return client;
}

async function tool(client, name, args = {}) {
  const answer = await client.callTool({ name, arguments: args });
  const value = JSON.parse(answer.content[0].text);
  if (value.success !== true) throw new Error(value.error ?? 'Unknown tool failure');
  return value.result;
}

test('real Streamable HTTP MCP requests survive an HTTP process restart', { timeout: 25000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lemonade-http-'));
  const database = join(dir, 'save.sqlite');
  const port = await freePort();
  let child;
  let client;
  try {
    child = await startService(port, database);
    // An untrusted website's Origin must not reach even a read-only endpoint.
    const crossSite = await fetch('http://127.0.0.1:' + port + '/mcp', {
      method: 'POST',
      headers: { Origin: 'https://malicious.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(crossSite.status, 403);
    client = await connect(port);
    const listing = await client.listTools();
    const names = listing.tools.map(t => t.name);
    for (const name of ['start_game', 'get_game_state', 'resume_game',
      'new_game', 'buy_supplies', 'set_price', 'sell_lemonade', 'next_day']) {
      assert.ok(names.includes(name), 'Missing tool ' + name);
    }
    const created = await tool(client, 'start_game');
    assert.equal(created.gameState.money, 20);
    const bought = await tool(client, 'buy_supplies', {
      cups: 10, lemons: 4, sugar: 4, ice: 15, operationId: 'http-buy-one'
    });
    assert.equal(bought.gameState.money, 18.48);
    // Test raw tool dispatch validation rather than trusting the advertised schema.
    const injected = await client.callTool({
      name: 'buy_supplies',
      arguments: { operationId: 'inject-1', cups: 1, bananas: 999 }
    });
    assert.equal(injected.isError, true);
    const afterInvalid = await tool(client, 'get_game_state');
    assert.equal(afterInvalid.gameState.money, 18.48);
    const replay = await tool(client, 'buy_supplies', {
      cups: 10, lemons: 4, sugar: 4, ice: 15, operationId: 'http-buy-one'
    });
    assert.deepEqual(replay, bought);
    await client.close();
    client = null;
    await stopService(child);
    child = await startService(port, database);
    client = await connect(port);
    const restored = await tool(client, 'resume_game');
    assert.equal(restored.gameId, created.gameId);
    assert.equal(restored.gameState.inventory.cups, 10);
    assert.equal(restored.gameState.money, 18.48);
    const startedAgain = await tool(client, 'start_game');
    assert.equal(startedAgain.gameId, created.gameId);
    await tool(client, 'set_price', { price: 0.29, operationId: 'price-1' });
    const sold = await tool(client, 'sell_lemonade', { operationId: 'sell-1' });
    assert.equal(sold.gameState.status, 'reporting');
    assert.equal(sold.gameState.salesHistory.length, 1);
  } finally {
    if (client) await client.close().catch(() => {});
    if (child) await stopService(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
