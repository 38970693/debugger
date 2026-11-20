const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { setImmediate: settle } = require('node:timers/promises');

class Element extends EventTarget {
  value = '';
  textContent = '';
  disabled = false;
  dataset = {};
  options = [];
  replaceChildren(...children) { this.options = children; }
  add(item) { this.options.push(item); }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a delayed panel poll cannot overwrite a completed connection and close removes polling and listeners', async () => {
  const directory = join(__dirname, '..', 'panels', 'browser');
  const calls = [];
  const timers = new Map();
  let interval = 0;
  const connection = deferred();
  const staleInfo = deferred();
  let delayedPoll = false;
  const ready = { state: 'disconnected', connected: false, revision: 0 };
  const target = { id: 'A', url: 'http://localhost:7457/', title: 'Test page' };
  const ok = (data) => ({ ok: true, data });
  async function request(_, message, input) {
    calls.push({ message, input });
    switch (message) {
      case 'service-info': return delayedPoll ? staleInfo.promise : ok({ state: 'ready', url: 'http://127.0.0.1:8765/mcp' });
      case 'bridge-status': return ok({ relayAvailable: true, extensionConnected: true, discoveryAvailable: true });
      case 'connect-browser':
        if (input.action === 'adopt') return connection.promise;
        return ok(delayedPoll ? { state: 'connecting', connected: false, revision: 1 } : ready);
    }
    throw new Error('Unhandled IPC request');
  }
  const context = {
    __dirname: directory,
    require,
    module: { exports: {} },
    AbortController,
    setInterval(handler) { timers.set(++interval, handler); return interval; },
    clearInterval(id) { timers.delete(id); },
    Editor: { Panel: { define: (config) => config }, Message: { request } },
  };
  runInNewContext(readFileSync(join(directory, 'index.js'), 'utf8'), context);
  const panel = context.module.exports;
  const elements = Object.fromEntries(Object.keys(panel.$).map((key) => [key, new Element()]));
  elements.port.value = '9220';
  elements.url.value = target.url;
  const view = { $: elements };
  panel.ready.call(view);
  await settle();
  assert.equal(elements.state.textContent, '未连接');
  assert.equal(timers.size, 1);
  elements.adopt.dispatchEvent(new Event('click'));
  delayedPoll = true;
  const poll = [...timers.values()][0]();
  connection.resolve(ok({ state: 'connected', connected: true, revision: 1, target, port: 9220 }));
  await settle();
  assert.equal(elements.state.textContent, '已连接');
  staleInfo.resolve(ok({ state: 'ready' }));
  await poll;
  assert.equal(elements.state.textContent, '已连接');
  assert.equal(elements.targetTitle.textContent, 'Test page');
  panel.close.call(view);
  assert.equal(timers.size, 0);
  const seen = calls.length;
  elements.adopt.dispatchEvent(new Event('click'));
  assert.equal(calls.length, seen);
  delayedPoll = false;
  panel.ready.call(view);
  await settle();
  assert.equal(timers.size, 1);
  panel.close.call(view);
});
