const { once } = require('node:events');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WebSocket } = require('ws');
const { ConnectionService } = require('../src/connection.cjs');
const { InstalledBridgeAdapter, LegacyRelay } = require('../src/installed-bridge.cjs');
const { BrowserError } = require('../src/contract.cjs');

const ORIGIN = 'chrome-extension://nebfobgfljofcokgognlfkbnfmmdaccm';
const tabs = [
  { id: 1, title: 'Creator Preview', url: 'http://localhost:7456/' },
  { id: 2, title: 'Other test page', url: 'http://localhost:7457/' },
  { id: 3, title: 'Internal page', url: 'chrome://settings/' },
];

test('the installed 2.4 bridge can list and select tabs via a read-only loopback channel', async (t) => {
  const relay = new LegacyRelay(0);
  let tunnelReady = false;
  const adapter = new InstalledBridgeAdapter({
    async health() { return { extensionConnected: tunnelReady, relayAvailable: true, discoveryAvailable: true }; },
    async list() {
      if (tunnelReady) return [{ id: 'primary', url: 'http://localhost:7458/', title: 'Standard channel' }];
      throw new BrowserError('PROVIDER_UNAVAILABLE', 'No 3.6 client');
    },
    async dispose() {},
  }, { legacy: relay, inspect: async () => ({ known: true, legacyVersion: '2.4.0' }) });
  const service = new ConnectionService(adapter);
  t.after(() => service.dispose());
  assert.equal((await service.bridgeStatus(9220)).relayAvailable, true);
  const port = relay.server.address().port;
  const address = `127.0.0.1:${port}`;
  const untrusted = new WebSocket('ws://' + address, { origin: 'https://untrusted.example' });
  await assert.rejects(once(untrusted, 'open'), /403/);
  assert.equal((await fetch('http://' + address, { method: 'HEAD' })).status, 204);

  const peer = new WebSocket('ws://' + address, { origin: ORIGIN });
  const commands = [];
  peer.on('message', (raw) => {
    const message = JSON.parse(raw);
    commands.push(message.code);
    peer.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, data: tabs } }));
  });
  await once(peer, 'open');
  peer.send(JSON.stringify({ type: 'ext_ready', tabs }));
  for (let attempt = 0; !relay.readyBrowsers().length && attempt < 20; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await service.bridgeStatus(9220)).extensionConnected, true);
  const listed = await service.run({ action: 'list', port: 9220 });
  assert.deepEqual(listed.map(({ id }) => id), ['1', '2']);
  assert.equal((await service.run({ action: 'connect', port: 9220, targetId: '1' })).transport, 'chrome-tab-metadata');
  assert.equal((await service.pageStatus()).target.url, tabs[0].url);
  assert.equal((await service.run({ action: 'connect', port: 9220, targetId: '2' })).target.url, tabs[1].url);
  assert.equal((await service.run({ action: 'disconnect' })).connected, false);
  assert.ok(commands.length > 0);
  assert.deepEqual(commands, commands.map(() => ({ cmd: 'tabs' })));
  assert.deepEqual((await service.run({ action: 'list', port: 9220 })).map(({ id }) => id), ['1', '2']);

  tunnelReady = true;
  assert.equal((await service.run({ action: 'list', port: 9220 }))[0].id, 'primary');
  assert.deepEqual((await service.run({ action: 'list', port: 18765 })).map(({ id }) => id), ['1', '2']);
});
