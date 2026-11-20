const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { ConnectionService } = require('../src/connection.cjs');
const { browserKey, BrowserError } = require('../src/contract.cjs');

const left = { id: 'A', url: 'http://localhost:7457/?screen=one', title: 'Left' };
const right = { id: 'B', url: 'http://localhost:7457/?screen=two', title: 'Right', active: true };
const connect = (targetId) => ({ action: 'connect', targetId, port: 9220 });

class Page extends EventEmitter {
  constructor(target) {
    super();
    this.target = target;
  }
  async identity() { return { title: this.target.title, url: this.target.url }; }
  async dispose() { this.closed = true; }
  lose() {
    this.lost = true;
    this.emit('lost');
  }
}

test('an explicit URL limits selection before active preference and preserves query differences', async (t) => {
  const service = new ConnectionService({
    list: async () => [left, right],
    attach: async (_, id) => new Page([left, right].find((target) => target.id === id)),
  });
  t.after(() => service.dispose());
  const chosen = await service.run({ action: 'adopt', port: 9220, url: left.url + '#fragment' });
  assert.equal(chosen.target.id, 'A');
  await assert.rejects(service.run({ action: 'adopt', port: 9220, url: left.url.replace('localhost', '127.0.0.1') }), {
    code: 'NOT_FOUND',
  });
  assert.equal(service.status().target.id, 'A');
});

for (const replacement of ['switch', 'disconnect']) {
  test(`a late attachment is reclaimed after ${replacement}`, async (t) => {
    let unblock;
    let started;
    const pending = new Promise((resolve) => { unblock = resolve; });
    const attaching = new Promise((resolve) => { started = resolve; });
    const late = new Page(left);
    const service = new ConnectionService({
      list: async () => [left, right],
      attach: async (_, id) => {
        if (id === 'B') return new Page(right);
        started();
        return pending;
      },
    });
    t.after(() => service.dispose());
    const first = assert.rejects(service.run(connect('A')), { code: 'REVISION_CONFLICT' });
    await attaching;
    if (replacement === 'switch') await service.run(connect('B'));
    else await service.run({ action: 'disconnect' });
    unblock(late);
    await first;
    assert.equal(service.status().target?.id, replacement === 'switch' ? 'B' : undefined);
    assert.equal(late.closed, true);
  });
}

test('disconnect recovery attaches a unique replacement and stops on ambiguous identity', async (t) => {
  let targets = [{ ...left, [browserKey]: 'browser-1' }];
  const pages = [];
  const service = new ConnectionService({
    list: async () => targets,
    attach: async (_, id) => {
      const page = new Page(targets.find((target) => target.id === id));
      pages.push(page);
      return page;
    },
  }, { recoveryDelays: [0] });
  t.after(() => service.dispose());
  await service.run(connect('A'));
  targets = [
    { ...left, id: 'A-2', [browserKey]: 'browser-2' },
    { ...left, id: 'A', title: 'Reused ID, same URL', [browserKey]: 'browser-2' },
  ];
  pages[0].lose();
  await delay(20);
  assert.equal(service.status().target.id, 'A-2');
  assert.equal(pages[0].closed, true);

  targets = [{ ...left, id: 'A-3' }, { ...left, id: 'A-4' }];
  pages[1].lose();
  await delay(20);
  assert.equal(service.status().state, 'failed');
  assert.equal(pages.length, 2);
});

test('initial retry only attaches a matching page after the bridge browser changes', async (t) => {
  const first = { ...left, [browserKey]: 'before' };
  const original = { ...left, id: 'A-2', [browserKey]: 'after' };
  const unrelated = { ...first, title: 'Same URL in another tab', [browserKey]: 'after' };
  const attempts = [];
  let scanned = false;
  const service = new ConnectionService({
    async list() {
      if (scanned) return [unrelated, original];
      scanned = true;
      return [first];
    },
    async attach(port, id, signal, endpoint) {
      attempts.push({ id, endpoint });
      if (endpoint === 'before') throw new BrowserError('TRANSPORT_ERROR', 'Browser changed');
      return new Page(id === original.id ? original : unrelated);
    },
  }, { retryDelays: [0, 0] });
  t.after(() => service.dispose());
  const status = await service.run({ action: 'adopt', port: 9220 });
  assert.deepEqual(attempts, [{ id: 'A', endpoint: 'before' }, { id: 'A-2', endpoint: 'after' }]);
  assert.equal(status.target.title, left.title);
});
