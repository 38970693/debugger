const http = require('node:http');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { connection, page, health, manage, BrowserError, result } = require('./contract.cjs');
const { name, version } = require('../package.json');

const HOST = '127.0.0.1';
const MAX_SESSIONS = 32;
const MAX_BODY = 32768;
const hash = (value) => createHash('sha256').update(value).digest();
const makeToken = () => randomBytes(32).toString('base64url');

const tools = [
  { name: 'system', schema: health, description: '查看本地 MCP 服务的健康状态。', group: 'core', read: true },
  { name: 'manage_tools', schema: manage, description: '查看工具组并设置本会话的 profile。', group: 'core', read: true },
  { name: 'browser_connect', schema: connection, description: '通过 CDP Bridge 扫描、选择、连接或断开 Chrome 页签。', group: 'runtime' },
  { name: 'browser_page', schema: page, description: '从活动页签读取实际标题和 URL。', group: 'runtime', read: true },
].map(({ schema, ...info }) => {
  const { $schema, ...inputSchema } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  return { ...info, schema, inputSchema: { type: 'object', ...inputSchema } };
});

function createSessionServer(service, healthInfo, readOnly) {
  const server = new Server({ name, version }, { capabilities: { tools: { listChanged: true } } });
  let profile = 'core';
  const allowed = (tool) => (tool.group === 'core' || profile === 'runtime') && (!readOnly || tool.read);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.filter(allowed).map(({ name, description, inputSchema, read }) => ({
      name, description, inputSchema, annotations: { readOnlyHint: Boolean(read && name !== 'manage_tools') },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const value = await result(async () => {
      const tool = tools.find(({ name }) => name === params.name);
      if (!tool) throw new BrowserError('NOT_FOUND', '没有这个工具');
      if (!allowed(tool)) throw new BrowserError('PERMISSION_DENIED', '当前会话不能调用此工具');
      const input = tool.schema.parse(params.arguments ?? {});
      switch (tool.name) {
        case 'system': return healthInfo();
        case 'browser_connect': return service.run(input);
        case 'browser_page': return service.pageStatus();
        case 'manage_tools': {
          if (input.action === 'activate') {
            const next = input.profile || 'runtime';
            if (profile !== next) {
              profile = next;
              void server.sendToolListChanged().catch(() => {});
            }
          }
          return { groups: ['core', 'runtime'], profile, readOnly };
        }
      }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: !value.ok,
    };
  });
  return server;
}

function sendJson(response, status, data) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function fail(response, status, message) {
  sendJson(response, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  // Leave the socket writable so the caller can return a precise error.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) return { tooLarge: true };
    chunks.push(chunk);
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return {};
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve(server.address().port);
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, HOST);
  });
}

class McpHost {
  constructor(service, { firstPort = 8765, lastPort = 8785, idleMs = 15 * 60_000,
    token = makeToken(), readOnlyToken = makeToken() } = {}) {
    if (!token || !readOnlyToken || token === readOnlyToken) throw new Error('需要两个独立的 MCP 访问令牌');
    this.firstPort = firstPort;
    this.lastPort = lastPort;
    this.idleMs = idleMs;
    this.tokens = { control: token, readOnly: readOnlyToken };
    this.tokenHashes = [hash(token), hash(readOnlyToken)];
    this.service = service;
    this.sessions = new Map();
    this.initializing = new Set();
    this.sockets = new Set();
    this.server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
      this.handle(request, response).catch(() => fail(response, 500, 'MCP request failed'));
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  start() {
    this.startup ||= this.bind();
    return this.startup;
  }

  async bind() {
    for (let port = this.firstPort; port <= this.lastPort; port += 1) {
      try {
        this.port = await listen(this.server, port);
        const interval = Math.min(this.idleMs, 60_000);
        this.reaper = setInterval(() => this.reapIdle(), interval);
        this.reaper.unref();
        return this.health();
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error(`MCP 端口 ${this.firstPort}–${this.lastPort} 均已占用`);
  }

  health() {
    return { state: this.stopping ? 'stopping' : this.port ? 'ready' : 'starting', version,
      ...(this.port ? { port: this.port, url: `http://${HOST}:${this.port}/mcp` } : {}) };
  }

  authenticate(request) {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization || '');
    if (!match) return undefined;
    const value = hash(match[1]);
    const control = timingSafeEqual(value, this.tokenHashes[0]);
    const readOnly = timingSafeEqual(value, this.tokenHashes[1]);
    if (control) return 'control';
    if (readOnly) return 'readOnly';
  }

  async handle(request, response) {
    if (this.stopping) return fail(response, 503, 'Service stopping');
    const hosts = [`${HOST}:${this.port}`, `localhost:${this.port}`];
    if (!hosts.includes(request.headers.host)) return fail(response, 403, 'Invalid Host');
    if (request.url === '/health' && request.method === 'GET') return sendJson(response, 200, this.health());
    if (request.url !== '/mcp') return fail(response, 404, 'Not found');
    if (request.headers.origin !== undefined && !hosts.some((host) => request.headers.origin === `http://${host}`)) {
      return fail(response, 403, 'Invalid Origin');
    }
    const role = this.authenticate(request);
    if (!role) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return fail(response, 401, 'Invalid Bearer token');
    }
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'POST, GET, DELETE');
      return fail(response, 405, 'Method not supported');
    }
    const id = request.headers['mcp-session-id'];
    const entry = this.sessions.get(id);
    if (id !== undefined && (!entry || role !== entry.role)) return fail(response, 404, 'Unknown MCP session');

    // A passive GET event stream can remain open while the client is idle.
    if (entry && request.method === 'POST') this.trackResponse(entry, response);
    let body;
    if (request.method === 'POST') {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return fail(response, 415, 'Expected application/json');
      }
      const parsed = await readBody(request);
      if (parsed.tooLarge) {
        response.setHeader('Connection', 'close');
        return fail(response, 413, 'MCP request exceeds size limit');
      }
      if (parsed.body === undefined) return fail(response, 400, 'Invalid JSON');
      body = parsed.body;
    }
    if (this.stopping) return fail(response, 503, 'Service stopping');
    if (entry) {
      if (this.sessions.get(id) !== entry) return fail(response, 404, 'Unknown MCP session');
      return entry.transport.handleRequest(request, response, body);
    }
    if (request.method !== 'POST' || !isInitializeRequest(body)) return fail(response, 400, 'Initialize an MCP session first');
    if (this.sessions.size + this.initializing.size >= MAX_SESSIONS) return fail(response, 503, 'Too many MCP sessions');
    return this.initialize(request, response, body, role);
  }

  trackResponse(entry, response) {
    if (response.destroyed) return;
    entry.active += 1;
    entry.lastSeen = Date.now();
    response.once('close', () => {
      entry.active -= 1;
      entry.lastSeen = Date.now();
    });
  }

  async initialize(request, response, body, role) {
    const entry = { role, active: 0, lastSeen: Date.now() };
    const server = createSessionServer(this.service, () => this.health(), role === 'readOnly');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.initializing.delete(entry);
        this.sessions.set(id, entry);
      },
    });
    entry.transport = transport;
    this.initializing.add(entry);
    transport.onclose = () => {
      this.initializing.delete(entry);
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    this.trackResponse(entry, response);
    try {
      await server.connect(transport);
      if (this.stopping) return fail(response, 503, 'Service stopping');
      await transport.handleRequest(request, response, body);
    } finally {
      this.initializing.delete(entry);
      if (!transport.sessionId || this.stopping) await transport.close();
    }
  }

  reapIdle() {
    const cutoff = Date.now() - this.idleMs;
    for (const entry of this.sessions.values()) {
      if (!entry.active && entry.lastSeen <= cutoff) void entry.transport.close().catch(() => {});
    }
  }

  stop() {
    this.stopping = true;
    this.shutdown ||= this.finish();
    return this.shutdown;
  }

  async finish() {
    await this.startup?.catch(() => {});
    clearInterval(this.reaper);
    const closed = new Promise((resolve) => this.server.close(resolve));
    const entries = [...this.sessions.values(), ...this.initializing];
    await Promise.allSettled(entries.map(({ transport }) => transport.close()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }
}

module.exports = { McpHost };
