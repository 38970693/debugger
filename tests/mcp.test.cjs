const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, request } = require('node:http');
const { once, EventEmitter } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ConnectionService } = require('../src/connection.cjs');
const { McpHost } = require('../src/mcp.cjs');

const fixture = { id: '8', title: 'Fixture', url: 'http://127.0.0.1:7457/' };

async function connect(host, token, options = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(host.health().url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...options,
  });
  const client = new Client({ name: 'acceptance', version: '1' });
  await client.connect(transport);
  return { client, transport };
}

function raw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('real HTTP profile, read-only credential and DELETE isolate sessions but share the active page', async (t) => {
  const adapter = {
    list: async () => [fixture],
    attach: async () => Object.assign(new EventEmitter(), {
      identity: async () => ({ title: fixture.title, url: fixture.url }),
      dispose: async () => {},
    }),
  };
  const service = new ConnectionService(adapter);
  const host = new McpHost(service, { firstPort: 0, lastPort: 0 });
  await host.start();
  t.after(async () => { await host.stop(); await service.dispose(); });
  const a = await connect(host, host.tokens.control);
  const b = await connect(host, host.tokens.control);
  const reader = await connect(host, host.tokens.readOnly);
  t.after(() => Promise.all([a, b, reader].map(({ client }) => client.close())));
  const names = async ({ client }) => (await client.listTools()).tools.map(({ name }) => name);
  const call = ({ client }, name, args) => client.callTool({ name, arguments: args });
  const activate = { action: 'activate', profile: 'runtime' };
  assert.deepEqual(await names(a), ['system', 'manage_tools']);
  assert.equal((await call(a, 'browser_connect', { action: 'status' })).structuredContent.error.code, 'PERMISSION_DENIED');
  assert.equal((await call(a, 'manage_tools', activate)).structuredContent.ok, true);
  assert.deepEqual(await names(a), ['system', 'manage_tools', 'browser_connect', 'browser_page']);
  assert.deepEqual(await names(b), ['system', 'manage_tools']);
  assert.equal((await call(a, 'browser_connect', { action: 'connect' })).structuredContent.error.code, 'INVALID_ARGUMENT');
  const connectTool = (await a.client.listTools()).tools.find(({ name }) => name === 'browser_connect');
  assert.ok(connectTool.inputSchema.oneOf.some(({ required }) => required.includes('targetId')));
  const attached = await service.run({ action: 'connect', port: 9220, targetId: fixture.id });
  assert.equal(attached.target.url, fixture.url);

  await call(b, 'manage_tools', { action: 'activate', groups: ['runtime'] });
  await call(reader, 'manage_tools', activate);
  assert.deepEqual(await names(reader), ['system', 'manage_tools', 'browser_page']);
  const forbidden = await call(reader, 'browser_connect', { action: 'disconnect' });
  assert.equal(forbidden.isError, true);
  assert.equal(forbidden.structuredContent.error.code, 'PERMISSION_DENIED');
  for (const client of [a, b, reader]) {
    const page = await call(client, 'browser_page', { action: 'status' });
    assert.equal(page.structuredContent.data.target.id, fixture.id);
  }

  const oldId = a.transport.sessionId;
  await a.transport.terminateSession();
  const { port } = host.health();
  assert.equal((await raw(port, '/mcp', { Authorization: `Bearer ${host.tokens.control}`, 'Mcp-Session-Id': oldId })).status, 404);
  assert.equal((await call(b, 'browser_connect', { action: 'status' })).structuredContent.data.connected, true);
  assert.equal((await raw(port, '/mcp', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await raw(port, '/mcp', { Authorization: `Bearer ${host.tokens.control}`, Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await raw(port, '/mcp', { Host: 'foreign.test' })).status, 403);
  assert.deepEqual((await raw(port, '/health')).data, host.health());
});

test('occupied first port is skipped and stopping releases the listener', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const firstPort = occupied.address().port;
  const host = new McpHost({}, { firstPort, lastPort: Math.min(firstPort + 8, 65535) });
  t.after(() => host.stop());
  await host.start();
  const { port } = host.health();
  assert.ok(port > firstPort);
  await host.stop();
  const rebound = new McpHost({}, { firstPort: port, lastPort: port });
  await rebound.start();
  assert.equal(rebound.health().port, port);
  await rebound.stop();
});

test('a passive SDK event stream does not keep an idle MCP session alive', async (t) => {
  const idleMs = 15 * 60_000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const host = new McpHost({}, { firstPort: 0, lastPort: 0, idleMs });
  await host.start();
  t.after(() => host.stop());
  let open;
  const eventStream = new Promise((resolve, reject) => { open = { resolve, reject }; });
  const { client } = await connect(host, host.tokens.control, {
    async fetch(url, init) {
      const response = await fetch(url, init);
      if (init?.method === 'GET' && response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.startsWith('text/event-stream')) open.resolve();
        else open.reject(new Error('Expected a live event stream'));
      }
      return response;
    },
  });
  t.after(() => client.close());
  await eventStream;
  now += idleMs + 1;
  host.reapIdle();
  await assert.rejects(client.listTools(), /404|session/i);
});
