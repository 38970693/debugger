const http = require('node:http');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { BrowserError, isWebUrl, browserKey } = require('./contract.cjs');

const HOST = '127.0.0.1';
const RELAY_PORT = 9221;
const TAKEOVER_PORT = 9220;
const MAX_MESSAGE = 2 * 1024 * 1024;
const transportError = (message) => new BrowserError('TRANSPORT_ERROR', message);

function getJson(port, path, signal, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: HOST, port, path, signal }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(transportError(`${path} 返回 HTTP ${response.statusCode}`));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_MESSAGE) {
          request.destroy(transportError('Bridge 响应超过大小限制'));
        } else {
          chunks.push(chunk);
        }
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(transportError(`${path} 未返回有效 JSON`));
        }
      });
    });
    const timer = setTimeout(() => request.destroy(transportError(`${path} 请求超时`)), timeout);
    request.once('error', reject);
    request.once('close', () => clearTimeout(timer));
  });
}

function endpointAt(version, port) {
  try {
    const endpoint = new URL(version.webSocketDebuggerUrl);
    if (endpoint.protocol === 'ws:' && [HOST, 'localhost'].includes(endpoint.hostname) &&
        Number(endpoint.port || 80) === port && /^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname) &&
        !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) {
      endpoint.hostname = HOST;
      return endpoint.href;
    }
  } catch {
    // A malformed version response has the same meaning as an unexpected endpoint.
  }
  throw transportError('Bridge 返回了无效的浏览器调试地址');
}

function mergeTabs(targets, tabs) {
  const directory = new Map();
  const extra = new Map();
  for (const target of targets.values()) {
    const group = directory.get(target.url) || [];
    group.push(target.id);
    directory.set(target.url, group);
  }
  const ids = new Set();
  for (const tab of tabs) {
    if (!Number.isSafeInteger(tab?.id) || tab.id < 0 || !isWebUrl(tab.url) || tab.url.length > 8192) continue;
    const id = String(tab.id);
    if (ids.has(id)) continue;
    ids.add(id);
    const group = extra.get(tab.url) || [];
    group.push({
      id, tabId: tab.id, url: tab.url, title: typeof tab.title === 'string' ? tab.title.slice(0, 1000) : '',
      ...(typeof tab.active === 'boolean' ? { active: tab.active } : {}),
    });
    extra.set(tab.url, group);
  }
  for (const [url, group] of extra) {
    const mainIds = directory.get(url) || [];
    if (group.length <= mainIds.length) continue;
    // There is no reliable mapping from a debugger ID to these Chrome tab IDs.
    // Use the complete tab group when the debugger directory omitted a same-URL tab.
    for (const id of mainIds) targets.delete(id);
    for (const tab of group) targets.set(tab.id, tab);
  }
}

class CdpSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.pending = new Map();
    this.sequence = 0;
    socket.on('message', (message) => this.receive(message));
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      for (const { finish } of this.pending.values()) finish(transportError('Bridge 连接已关闭'));
      this.emit('lost');
    });
  }

  static open(endpoint, signal, timeout = 3000) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const socket = new WebSocket(endpoint, { handshakeTimeout: timeout, maxPayload: MAX_MESSAGE });
      const abort = () => socket.terminate();
      const cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('error', () => {
        cleanup();
        reject(transportError('无法打开 Bridge 调试连接'));
      });
      socket.once('close', () => {
        cleanup();
        reject(transportError('Bridge 调试连接已关闭'));
      });
      socket.once('open', () => {
        cleanup();
        resolve(new CdpSocket(socket));
      });
    });
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'plugin-disconnected') {
      void this.close();
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending) {
      // Relay versions can omit the response sessionId. A present ID must match.
      if (message.sessionId !== undefined && message.sessionId !== pending.sessionId) return;
      pending.finish(message.error ? new BrowserError('CDP_REJECTED', `Bridge 拒绝了 ${pending.method}`) : null, message.result);
    } else if (typeof message.method === 'string') {
      this.emit('event', message);
    }
  }

  send(method, params, { sessionId, signal, timeout = 3000, lateReply } = {}) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(transportError('Bridge 连接已关闭'));
        return;
      }
      const id = ++this.sequence;
      let timedOut = false;
      const abort = () => finish(signal.reason);
      const timeoutError = () => transportError(`${method} 超时`);
      let timer = setTimeout(() => {
        if (!lateReply) return finish(timeoutError());
        timedOut = true;
        lateReply.onTimeout();
        reject(timeoutError());
        timer = setTimeout(() => finish(timeoutError()), lateReply.graceMs);
      }, timeout);
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (timedOut) void lateReply.cleanup(value).catch(() => {});
        else if (error) reject(error);
        else resolve(value);
      };
      this.pending.set(id, { method, sessionId, finish });
      signal?.addEventListener('abort', abort, { once: true });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }), (error) => {
        if (error) finish(transportError(`${method} 发送失败`));
      });
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.socket.terminate(), 500);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }
}

class BridgePage extends EventEmitter {
  constructor(browser, sessionId, targetId, release) {
    super();
    this.browser = browser;
    this.sessionId = sessionId;
    this.closed = false;
    this.lost = false;
    this.release = release;
    const lost = () => {
      if (this.closed || this.lost) return;
      this.lost = true;
      this.emit('lost');
    };
    const event = ({ method, params, sessionId: eventSession }) => {
      if ((method === 'Target.detachedFromTarget' && params?.sessionId === sessionId) ||
          (method === 'Target.targetDestroyed' && params?.targetId === targetId) ||
          (method === 'Inspector.detached' && eventSession === sessionId)) {
        lost();
      }
    };
    browser.once('lost', lost);
    browser.on('event', event);
    this.unsubscribe = () => {
      browser.off('lost', lost);
      browser.off('event', event);
    };
  }

  async identity(signal) {
    const reply = await this.browser.send('Runtime.evaluate', {
      expression: '({title: document.title, url: location.href})',
      returnByValue: true,
    }, { sessionId: this.sessionId, signal });
    const value = reply?.result?.value;
    if (reply?.exceptionDetails || !value || typeof value.title !== 'string' || !isWebUrl(value.url) ||
        value.url.length > 8192) {
      throw transportError('无法从指定页签读取 HTTP/HTTPS 页面身份');
    }
    return { url: value.url, title: value.title.slice(0, 1000) };
  }

  dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.unsubscribe();
    this.disposal = this.browser.send('Target.detachFromTarget', { sessionId: this.sessionId }, { timeout: 1500 })
      .catch(() => {})
      .finally(this.release);
    return this.disposal;
  }
}

class BridgeAdapter {
  constructor({ relayPort = RELAY_PORT, takeoverPort = TAKEOVER_PORT,
    attachTimeoutMs = 3000, lateAttachGraceMs = 12000 } = {}) {
    this.relayPort = relayPort;
    this.takeoverPort = takeoverPort;
    this.attachTimeoutMs = attachTimeoutMs;
    this.lateAttachGraceMs = lateAttachGraceMs;
    this.browsers = new Map();
    this.lateAttachments = new Set();
  }

  async acquire(endpoint, signal, timeout) {
    signal?.throwIfAborted();
    let entry = this.browsers.get(endpoint);
    if (entry?.closing) {
      await entry.closing;
      return this.acquire(endpoint, signal, timeout);
    }
    if (!entry) {
      entry = { users: 0, opening: CdpSocket.open(endpoint, undefined, timeout) };
      this.browsers.set(endpoint, entry);
      entry.opening.then((browser) => {
        browser.once('lost', () => {
          if (this.browsers.get(endpoint) === entry) this.browsers.delete(endpoint);
        });
      }, () => {});
    }
    entry.users += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users > 0) return;
      entry.closing = entry.opening.then((browser) => browser.close(), () => {}).finally(() => {
        if (this.browsers.get(endpoint) === entry) this.browsers.delete(endpoint);
      });
      await entry.closing;
    };
    try {
      const browser = await entry.opening;
      signal?.throwIfAborted();
      return { browser, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async health(port, signal) {
    const [relay, version] = await Promise.allSettled([
      getJson(this.relayPort, '/json/browsers', signal), getJson(port, '/json/version', signal),
    ]);
    signal?.throwIfAborted();
    const browserList = relay.status === 'fulfilled' && Array.isArray(relay.value) ? relay.value : null;
    const isBridge = version.status === 'fulfilled' && /cdp-tunnel/i.test(version.value?.Browser);
    let discoveryAvailable = false;
    if (isBridge) {
      try {
        endpointAt(version.value, port);
        discoveryAvailable = true;
      } catch {
        // An HTTP response alone does not validate the discovery endpoint.
      }
    }
    const count = browserList?.filter((browser) => browser?.connected === true).length;
    return {
      installed: 'unknown', relayAvailable: browserList !== null,
      extensionConnected: count === undefined ? null : count > 0,
      discoveryAvailable, port,
      ...(isBridge ? { version: version.value.Browser.match(/cdp-tunnel\/([\d.]+)/i)?.[1] } : {}),
    };
  }

  async version(port, signal) {
    const data = await getJson(port, '/json/version', signal);
    if (!/cdp-tunnel/i.test(data?.Browser)) throw transportError('所选端口未提供 CDP Bridge 接管服务');
    if (data.totalPlugins === 0) throw new BrowserError('PROVIDER_UNAVAILABLE', 'relay 在线，等待 Chrome 中的 CDP Bridge 连接');
    if (data.totalPlugins > 1) throw new BrowserError('AMBIGUOUS_REFERENCE', 'relay 连接了多个浏览器，请保留需要接管的 Bridge 连接');
    return endpointAt(data, port);
  }

  async list(port, signal) {
    try {
      const endpoint = await this.version(port, signal);
      const directory = await getJson(port, '/json/list', signal);
      if (!Array.isArray(directory)) throw transportError('Bridge 页签目录格式无效');
      const targets = new Map();
      for (const entry of directory) {
        if (entry?.type !== 'page' || typeof entry.id !== 'string' || !entry.id || entry.id.length > 500 ||
            !isWebUrl(entry.url) || entry.url.length > 8192) continue;
        targets.set(entry.id, {
          id: entry.id, url: entry.url, title: typeof entry.title === 'string' ? entry.title.slice(0, 1000) : '',
          ...(typeof entry.active === 'boolean' ? { active: entry.active } : {}),
        });
      }
      if (port === this.takeoverPort) {
        const tabs = await this.supplement(endpoint, signal);
        mergeTabs(targets, tabs);
      }
      if (await this.version(port, signal) !== endpoint) {
        throw transportError('扫描期间 Bridge 所连接的浏览器已更换');
      }
      signal?.throwIfAborted();
      return Array.from(targets.values(), (target) => ({ ...target, [browserKey]: endpoint }));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('PROVIDER_UNAVAILABLE', '无法读取 Bridge 页签，请检查 relay 与浏览器扩展');
    }
  }

  async supplement(endpoint, signal) {
    let lease;
    try {
      lease = await this.acquire(endpoint, signal, 1500);
      const data = await lease.browser.send('Tab.getMuteStatus', { cdpOnly: false }, { signal, timeout: 1500 });
      return Array.isArray(data?.tabs) ? data.tabs : [];
    } catch {
      return [];
    } finally {
      await lease?.release();
    }
  }

  async attach(port, id, signal, expectedEndpoint) {
    const endpoint = await this.version(port, signal);
    if (expectedEndpoint && endpoint !== expectedEndpoint) {
      throw transportError('Bridge 所连接的浏览器已更换，需重新枚举页签');
    }
    const attachTo = async (lease) => {
      let waitingForLateReply = false;
      let finishLateCleanup;
      try {
        signal?.throwIfAborted();
        // Wait for the attach response even on cancellation so its session can be detached.
        const attached = await lease.browser.send('Target.attachToTarget', { targetId: id, flatten: true }, {
          timeout: this.attachTimeoutMs,
          lateReply: {
            graceMs: this.lateAttachGraceMs,
            onTimeout: () => {
              waitingForLateReply = true;
              const cleanup = new Promise((resolve) => { finishLateCleanup = resolve; });
              this.lateAttachments.add(cleanup);
              void cleanup.then(() => this.lateAttachments.delete(cleanup));
            },
            cleanup: async (late) => {
              try {
                if (typeof late?.sessionId === 'string' && late.sessionId) {
                  await lease.browser.send('Target.detachFromTarget', { sessionId: late.sessionId }, { timeout: 1500 });
                }
              } finally {
                try {
                  await lease.release();
                } finally {
                  finishLateCleanup();
                }
              }
            },
          },
        });
        if (typeof attached?.sessionId !== 'string' || !attached.sessionId) throw transportError('Bridge 未返回页签会话 ID');
        const page = new BridgePage(lease.browser, attached.sessionId, id, lease.release);
        if (signal?.aborted) {
          await page.dispose();
          signal.throwIfAborted();
        }
        return page;
      } catch (error) {
        // Keep the lease until the bounded late reply cleanup finishes. Other pages can still use this socket.
        if (!waitingForLateReply) await lease.release();
        throw error;
      }
    };
    const lease = await this.acquire(endpoint, signal);
    try {
      return await attachTo(lease);
    } catch (error) {
      signal?.throwIfAborted();
      if (port !== this.takeoverPort || error.code !== 'CDP_REJECTED') throw error;
      if (this.browsers.has(endpoint)) throw error;
      const fallback = await this.acquire(`ws://${HOST}:${this.relayPort}/client`, signal);
      return attachTo(fallback);
    }
  }

  async dispose() {
    await Promise.allSettled([...this.lateAttachments]);
    const entries = [...this.browsers.values()];
    await Promise.allSettled(entries.map(async (entry) => {
      const browser = await entry.opening;
      await browser.close();
    }));
  }
}

module.exports = { BridgeAdapter };
