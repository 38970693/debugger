const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once, EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { BridgeAdapter } = require('../src/bridge.cjs');
const { ConnectionService } = require('../src/connection.cjs');

test('Bridge uses scoped page commands and can fall back after attach rejection', async (t) => {
  const url = 'http://127.0.0.1:7457/';
  const entries = [
    { id: 'alpha', url, title: 'First', type: 'page' },
    { id: 'beta', url, title: 'Second', type: 'page' },
  ];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/list') return res.end(JSON.stringify(entries));
    if (req.url === '/json/browsers') return res.end(JSON.stringify([{ connected: true }]));
    res.end(JSON.stringify({
      Browser: 'Chrome/test (cdp-tunnel/3.6.4)', totalPlugins: 1,
      webSocketDebuggerUrl: `ws://localhost:${server.address().port}/devtools/browser/fixture`,
    }));
  });
  const sockets = new WebSocketServer({ server });
  const opened = new Set();
  const detached = [];
  const identities = [];
  let supplemental = [{ id: 87, url: url + 'other', title: 'Extra' }, { id: 88, url, title: 'Duplicate' }];
  sockets.on('connection', (socket, req) => {
    opened.add(socket);
    socket.on('close', () => opened.delete(socket));
    socket.on('message', (raw) => {
      const { id, method, params, sessionId } = JSON.parse(raw.toString());
      const answer = (payload, session = sessionId) => socket.send(JSON.stringify({ id, sessionId: session, ...payload }));
      if (method === 'Tab.getMuteStatus') {
        assert.deepEqual(params, { cdpOnly: false });
        answer({ result: { tabs: supplemental } });
      } else if (method === 'Target.attachToTarget') {
        assert.equal(sessionId, undefined);
        assert.deepEqual(params, { targetId: 'beta', flatten: true });
        if (req.url !== '/client') return answer({ error: { message: 'legacy endpoint' } });
        answer({ result: { sessionId: 'test-session' } });
      } else if (method === 'Runtime.evaluate') {
        identities.push(sessionId);
        answer({ result: { result: { value: { url, title: 'Wrong result' } } } }, 'unrelated-session');
        answer({ result: { result: { value: { url, title: 'Second (actual)' } } } });
      } else if (method === 'Target.detachFromTarget') {
        detached.push(params.sessionId);
        answer({ result: {} });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const service = new ConnectionService(new BridgeAdapter({ relayPort: port, takeoverPort: port }));
  t.after(async () => {
    await service.dispose();
    for (const client of sockets.clients) client.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const listing = await service.run({ action: 'list', port });
  assert.deepEqual(listing.map(({ id }) => id), ['alpha', 'beta', '87']);
  supplemental = [
    { id: 88, url, title: 'First' }, { id: 89, url, title: 'Second' }, { id: 90, url, title: 'Third' },
  ];
  assert.deepEqual((await service.run({ action: 'list', port })).map(({ id }) => id), ['88', '89', '90']);
  await assert.rejects(service.run({ action: 'adopt', port, url }), { code: 'AMBIGUOUS_REFERENCE' });
  supplemental = [];
  const status = await service.run({ action: 'connect', port, targetId: 'beta' });
  assert.equal(status.target.title, 'Second (actual)');
  assert.equal(status.transport, 'chrome-cdp');
  for (const socket of opened) {
    socket.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'other' } }));
  }
  assert.equal((await service.pageStatus()).target.id, 'beta');
  assert.deepEqual(identities, ['test-session', 'test-session']);
  assert.equal((await service.run({ action: 'disconnect' })).connected, false);
  assert.deepEqual(detached, ['test-session']);
  assert.deepEqual(await service.bridgeStatus(port), {
    installed: 'unknown', relayAvailable: true, extensionConnected: true, discoveryAvailable: true,
    port, version: '3.6.4',
  });
});

test('the single takeover socket remains usable for scans and switching between two pages', async (t) => {
  const pages = [
    { id: 'first', url: 'http://localhost:7457/first', title: 'First', type: 'page' },
    { id: 'second', url: 'http://localhost:7457/second', title: 'Second', type: 'page' },
  ];
  const browserSessions = new Map();
  let activeSocket;
  let fallback = 0;
  const attached = [];
  const detached = [];
  const http = createServer((req, res) => {
    const data = req.url === '/json/list' ? pages : {
      Browser: 'Chrome/test (cdp-tunnel/3.6.4)', totalPlugins: 1,
      webSocketDebuggerUrl: `ws://127.0.0.1:${http.address().port}/devtools/browser/fixture`,
    };
    res.end(JSON.stringify(data));
  });
  const sockets = new WebSocketServer({ server: http });
  sockets.on('connection', (socket, req) => {
    if (req.url === '/client') fallback += 1;
    if (activeSocket) return socket.close(1008, 'one takeover client');
    activeSocket = socket;
    socket.on('close', () => { activeSocket = undefined; });
    socket.on('message', (message) => {
      const { id, method, params, sessionId } = JSON.parse(message.toString());
      let result = {};
      if (method === 'Target.attachToTarget') {
        const target = pages.find((page) => page.id === params.targetId);
        const id = 'session-' + target.id;
        browserSessions.set(id, target);
        attached.push(id);
        result = { sessionId: id };
      }
      if (method === 'Runtime.evaluate') {
        const target = browserSessions.get(sessionId);
        result = { result: { value: { url: target.url, title: target.title } } };
      }
      if (method === 'Target.detachFromTarget') {
        browserSessions.delete(params.sessionId);
        detached.push(params.sessionId);
      }
      socket.send(JSON.stringify({ id, sessionId, result }));
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = http.address().port;
  const service = new ConnectionService(new BridgeAdapter({ relayPort: port, takeoverPort: port }));
  t.after(async () => {
    await service.dispose();
    for (const client of sockets.clients) client.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  });
  await service.run({ action: 'connect', port, targetId: 'first' });
  assert.deepEqual((await service.run({ action: 'list', port })).map(({ connected }) => connected), [true, false]);
  await service.run({ action: 'connect', port, targetId: 'second' });
  assert.equal((await service.pageStatus()).target.id, 'second');
  assert.deepEqual(attached, ['session-first', 'session-second']);
  assert.deepEqual(detached, ['session-first']);
  await service.run({ action: 'disconnect' });
  assert.equal(fallback, 0);
  assert.equal(browserSessions.size, 0);
});

test('a cancelled attach which exceeds its deadline can still detach without closing the new target', async (t) => {
  const targets = [
    { id: 'slow', url: 'http://127.0.0.1:7457/slow', title: 'Slow', type: 'page' },
    { id: 'fast', url: 'http://127.0.0.1:7457/fast', title: 'Fast', type: 'page' },
  ];
  let delayedAttach;
  const attached = new Map();
  const detached = [];
  const events = new EventEmitter();
  const http = createServer((req, res) => {
    res.end(JSON.stringify(req.url === '/json/list' ? targets : {
      Browser: 'Chrome/test (cdp-tunnel/3.6.4)', totalPlugins: 1,
      webSocketDebuggerUrl: `ws://127.0.0.1:${http.address().port}/devtools/browser/fixture`,
    }));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => socket.on('message', (raw) => {
    const { id, method, params, sessionId } = JSON.parse(raw.toString());
    const respond = (result) => socket.send(JSON.stringify({ id, sessionId, result }));
    if (method === 'Target.attachToTarget') {
      const target = targets.find((target) => target.id === params.targetId);
      const attach = () => {
        attached.set(target.id, target);
        respond({ sessionId: target.id });
      };
      if (target.id === 'slow') {
        delayedAttach = attach;
        events.emit('slow-attach');
      } else {
        attach();
      }
    } else if (method === 'Runtime.evaluate') {
      const target = attached.get(sessionId);
      respond({ result: { value: { title: target.title, url: target.url } } });
    } else if (method === 'Target.detachFromTarget') {
      detached.push(params.sessionId);
      attached.delete(params.sessionId);
      respond({});
      events.emit('detach', params.sessionId);
    } else {
      respond({ tabs: [] });
    }
  }));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = http.address().port;
  const service = new ConnectionService(new BridgeAdapter({
    takeoverPort: port, attachTimeoutMs: 100, lateAttachGraceMs: 1000,
  }));
  t.after(async () => {
    await service.dispose();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  });
  const reachedRelay = once(events, 'slow-attach');
  const cancelled = assert.rejects(service.run({ action: 'connect', port, targetId: 'slow' }), { code: 'REVISION_CONFLICT' });
  await reachedRelay;
  const next = await service.run({ action: 'connect', port, targetId: 'fast' });
  await cancelled;
  assert.equal(service.status().revision, next.revision);
  const detachedLate = once(events, 'detach');
  delayedAttach();
  assert.deepEqual(await detachedLate, ['slow']);
  assert.deepEqual(detached, ['slow']);
  assert.equal((await service.pageStatus()).target.id, 'fast');
  assert.deepEqual([...attached.keys()], ['fast']);

  const secondAttach = once(events, 'slow-attach');
  const cancelledByUnload = assert.rejects(service.run({ action: 'connect', port, targetId: 'slow' }), { code: 'REVISION_CONFLICT' });
  await secondAttach;
  const unloaded = service.dispose();
  await cancelledByUnload;
  const detachedDuringUnload = once(events, 'detach');
  delayedAttach();
  assert.deepEqual(await detachedDuringUnload, ['slow']);
  await unloaded;
  assert.equal(attached.size, 0);
});

test('discovery rejects a directory collected while the extension reconnected', async (t) => {
  let browser = 'original';
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      browser = 'replacement';
      return res.end(JSON.stringify([{ id: '1', type: 'page', url: 'http://localhost:7457/', title: 'Old target' }]));
    }
    res.end(JSON.stringify({
      Browser: 'Chrome/test (cdp-tunnel/3.6.4)', totalPlugins: 1,
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/${browser}`,
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(new BridgeAdapter().list(server.address().port), /扫描期间.*浏览器已更换/);
});
