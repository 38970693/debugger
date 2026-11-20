const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readFile, readdir } = require('node:fs/promises');
const { isAbsolute, join } = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { BrowserError, browserKey, isWebUrl } = require('./contract.cjs');

const LEGACY_PORT = 18765;
const DEFAULT_PORT = 9220;
const LEGACY_ID = 'nebfobgfljofcokgognlfkbnfmmdaccm';
const LEGACY_ORIGIN = 'chrome-extension://' + LEGACY_ID;
const unavailable = (message) => new BrowserError('PROVIDER_UNAVAILABLE', message);
const transportError = (message) => new BrowserError('TRANSPORT_ERROR', message);

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }
}

async function directories(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name); }
  catch { return []; }
}

async function inspectChrome(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return { known: false };
  const root = join(localAppData, 'Google', 'Chrome', 'User Data');
  const profiles = (await directories(root)).filter((name) => /^Default$|^Profile \d+$/.test(name));
  let legacyVersion;
  let tunnelVersion;
  for (const profile of profiles) {
    const home = join(root, profile);
    function register(id, manifest) {
      if (manifest?.name !== 'CDP Bridge' || !manifest.permissions?.includes('debugger')) return;
      if (id === LEGACY_ID && /^2\.4\./.test(manifest.version)) legacyVersion = manifest.version;
      if (typeof manifest.version === 'string' && manifest.options_ui?.page === 'config-page-preview.html') {
        tunnelVersion = manifest.version;
      }
    }
    const extensions = join(home, 'Extensions');
    for (const id of await directories(extensions)) {
      const location = join(extensions, id);
      for (const version of await directories(location)) {
        register(id, await json(join(location, version, 'manifest.json')));
      }
    }
    // Chrome records unpacked extensions by absolute path rather than copying their files.
    for (const file of ['Preferences', 'Secure Preferences']) {
      const preferences = await json(join(home, file));
      for (const [id, entry] of Object.entries(preferences?.extensions?.settings ?? {})) {
        if (!entry || typeof entry.path !== 'string' || !isAbsolute(entry.path)) continue;
        register(id, entry.manifest ?? await json(join(entry.path, 'manifest.json')));
      }
    }
  }
  return { known: profiles.length > 0, legacyVersion, tunnelVersion };
}

class LegacyBrowser extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.key = 'legacy:' + randomUUID();
    this.serial = 0;
    this.pending = new Map();
    this.ready = false;
    const handshake = setTimeout(() => socket.terminate(), 5000);
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (message?.type === 'ext_ready' && Array.isArray(message.tabs)) {
        clearTimeout(handshake);
        this.ready = true;
      } else if (message?.type === 'ping') {
        socket.send('{"type":"pong"}');
      } else {
        this.pending.get(message?.id)?.(message?.result);
      }
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(handshake);
      this.ready = false;
      for (const finish of this.pending.values()) finish();
      this.emit('lost');
    });
  }

  async tabs(signal) {
    signal?.throwIfAborted();
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) throw transportError('Chrome Bridge 已断开');
    if (this.pending.size >= 16) throw transportError('Chrome Bridge 正在处理其他请求');
    const id = ++this.serial;
    const values = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(), 3000);
      const onAbort = () => finish();
      const finish = (result) => {
        this.pending.delete(id);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) reject(signal.reason);
        else if (result?.ok && Array.isArray(result.data)) resolve(result.data);
        else reject(transportError('Chrome Bridge 未返回页签列表'));
      };
      this.pending.set(id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket.send(JSON.stringify({ id, code: { cmd: 'tabs' } }), (error) => { if (error) finish(); });
    });
    return values.filter((tab) => Number.isSafeInteger(tab?.id) && tab.id >= 0 &&
      isWebUrl(tab.url) && tab.url.length <= 8192).map((tab) => ({
      id: `${this.key}:${tab.id}`, url: tab.url, title: typeof tab.title === 'string' ? tab.title.slice(0, 1000) : '',
      ...(typeof tab.active === 'boolean' ? { active: tab.active } : {}),
      [browserKey]: this.key,
    }));
  }
}

class LegacyPage extends EventEmitter {
  constructor(browser, tabId) {
    super();
    this.browser = browser;
    this.tabId = tabId;
    this.transport = 'chrome-tab-metadata';
    this.onBrowserLoss = () => this.emit('lost');
    browser.once('lost', this.onBrowserLoss);
  }

  get lost() { return !this.browser.ready; }

  async identity(signal) {
    const tab = (await this.browser.tabs(signal)).find(({ id }) => id === this.tabId);
    if (!tab) throw new BrowserError('NOT_FOUND', 'Chrome 中的页签已关闭或不再是 HTTP/HTTPS 页签');
    return { title: tab.title, url: tab.url };
  }

  async dispose() { this.browser.off('lost', this.onBrowserLoss); }
}

class LegacyRelay {
  constructor(port = LEGACY_PORT) {
    this.port = port;
    this.browsers = new Set();
  }

  start() {
    if (this.closed) return Promise.resolve();
    if (!this.startup) {
      this.state = 'starting';
      this.startup = this.listen().catch(() => {
        this.state = 'unavailable';
        this.startup = undefined;
      });
    }
    return this.startup;
  }

  async listen() {
    this.server = createServer((request, response) => {
      const ok = request.method === 'HEAD' && request.url === '/' && this.isLoopbackHost(request);
      response.writeHead(ok ? 204 : 404).end();
    });
    this.hub = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server.on('upgrade', (request, socket, head) => {
      if (this.closed || request.url !== '/' || !this.isLoopbackHost(request) ||
          request.headers.origin !== LEGACY_ORIGIN || this.browsers.size >= 4) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.hub.handleUpgrade(request, socket, head, (client) => {
        const browser = new LegacyBrowser(client);
        this.browsers.add(browser);
        browser.once('lost', () => this.browsers.delete(browser));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    this.state = 'online';
  }

  isLoopbackHost(request) {
    return request.headers.host === '127.0.0.1:' + this.server.address()?.port;
  }

  readyBrowsers() { return [...this.browsers].filter((browser) => browser.ready); }

  source() {
    const ready = this.readyBrowsers();
    if (ready.length > 1) throw new BrowserError('AMBIGUOUS_REFERENCE', '多个 Chrome 配置已连接，请仅保留待使用的 Bridge');
    if (ready.length === 1) return ready[0];
    throw unavailable(this.state === 'unavailable'
      ? 'CDP Bridge 2.4 所需的本机端口 18765 不可用'
      : '等待 CDP Bridge 2.4 联通，请在 Chrome 刷新目标页签后再扫描');
  }

  async dispose() {
    this.closed = true;
    await this.startup;
    for (const socket of this.hub?.clients ?? []) socket.terminate();
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
    this.hub?.close();
  }
}

class InstalledBridgeAdapter {
  constructor(tunnel, { inspect = inspectChrome, legacy = new LegacyRelay() } = {}) {
    this.tunnel = tunnel;
    this.inspect = inspect;
    this.legacy = legacy;
  }

  async setup() {
    if (!this.checking) {
      this.checking = (async () => {
        this.installation = await this.inspect();
        if (this.installation.legacyVersion) await this.legacy.start();
      })().finally(() => { this.checking = undefined; });
    }
    await this.checking;
    return this.installation;
  }

  async route(port, signal) {
    const [installation, primary] = await Promise.all([
      this.setup(),
      this.tunnel.health(port === LEGACY_PORT ? DEFAULT_PORT : port, signal),
    ]);
    signal?.throwIfAborted();
    const tunnelUsable = primary.extensionConnected && primary.discoveryAvailable;
    const useMetadata = port === LEGACY_PORT ||
      (port === DEFAULT_PORT && !tunnelUsable && Boolean(installation.legacyVersion));
    return { installation, primary, useMetadata };
  }

  async health(port, signal) {
    const { installation, primary, useMetadata } = await this.route(port, signal);
    const ready = this.legacy.readyBrowsers().length;
    const installed = primary.extensionConnected || installation.legacyVersion || installation.tunnelVersion
      ? 'installed' : installation.known ? 'missing' : 'unknown';
    if (useMetadata) return {
      installed, relayAvailable: this.legacy.state === 'online', extensionConnected: ready > 0,
      discoveryAvailable: ready === 1, port: LEGACY_PORT, version: installation.legacyVersion,
      mode: 'metadata', ...(ready > 1 ? { issue: '多个 Chrome 配置已连接，请仅保留待使用的 Bridge' } :
        this.legacy.state === 'unavailable' ? { issue: '本机端口 18765 不可用' } : {}),
    };
    return { ...primary, installed, ...(installation.tunnelVersion ? { extensionVersion: installation.tunnelVersion } : {}) };
  }

  async list(port, signal) {
    if (port === LEGACY_PORT) {
      await this.setup();
      return this.legacy.source().tabs(signal);
    }
    if (port === DEFAULT_PORT && (await this.route(port, signal)).useMetadata) {
      return this.legacy.source().tabs(signal);
    }
    return this.tunnel.list(port, signal);
  }

  async attach(port, id, signal, key) {
    if (!key?.startsWith('legacy:')) return this.tunnel.attach(port, id, signal, key);
    signal?.throwIfAborted();
    const browser = this.legacy.source();
    if (browser.key !== key) throw transportError('Chrome 配置已变化，请重新扫描页签');
    return new LegacyPage(browser, id);
  }

  async dispose() {
    await Promise.all([this.tunnel.dispose(), this.legacy.dispose()]);
  }
}

module.exports = { InstalledBridgeAdapter, LegacyRelay };
