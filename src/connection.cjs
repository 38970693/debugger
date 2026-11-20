const { setTimeout: delay } = require('node:timers/promises');
const { BrowserError, normalizedUrl, browserKey } = require('./contract.cjs');

const REPLACED = () => new BrowserError('REVISION_CONFLICT', '连接请求已被较新的操作取代');
const MISSING = () => new BrowserError('NOT_FOUND', '找不到目标页签，请刷新列表并确认页面已打开');
const AMBIGUOUS = (targets) => new BrowserError('AMBIGUOUS_REFERENCE', '多个页签符合条件，请按目标 ID 选择', {
  targetIds: targets.map(({ id }) => id),
});

function byIdentity(targets, original) {
  if (!original?.url || original.title === undefined) return undefined;
  const matches = targets.filter(({ url, title }) =>
    normalizedUrl(url) === normalizedUrl(original.url) && title === original.title);
  if (matches.length > 1) throw AMBIGUOUS(matches);
  return matches[0];
}

function recoverTarget(targets, original) {
  return targets.find((target) => target.id === original.id && target[browserKey] === original[browserKey] &&
    normalizedUrl(target.url) === normalizedUrl(original.url)) || byIdentity(targets, original);
}

function publicTarget(target) {
  const { [browserKey]: _endpoint, ...display } = target;
  return display;
}

function selectTarget(targets, input, current) {
  if (input.action === 'connect') {
    return targets.find(({ id }) => id === input.targetId) || byIdentity(targets, input);
  }
  let candidates = input.url
    ? targets.filter(({ url }) => normalizedUrl(url) === normalizedUrl(input.url))
    : targets;
  if (candidates.length <= 1) return candidates[0];
  for (const preferred of [
    (target) => target.active === true,
    ({ url }) => {
      const address = new URL(url);
      return ['localhost', '127.0.0.1'].includes(address.hostname) && address.port === '7456';
    },
    ({ id }) => input.port === current?.port && id === current?.target.id,
  ]) {
    const matches = candidates.filter(preferred);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) candidates = matches;
  }
  throw AMBIGUOUS(candidates);
}

class ConnectionService {
  constructor(adapter, {
    retryDelays = [0, 200, 500, 1000],
    recoveryDelays = [250, 500, 750, 1000, 1250, 1500, 1750, 2000],
    heartbeatMs = 5000,
  } = {}) {
    this.adapter = adapter;
    this.retryDelays = retryDelays;
    this.recoveryDelays = recoveryDelays;
    this.revision = 0;
    this.state = 'disconnected';
    this.tasks = new Set();
    this.heartbeat = setInterval(() => {
      if (this.state === 'connected' && !this.healthProbe) {
        this.healthProbe = this.track(this.pageStatus().catch(() => {}).finally(() => {
          this.healthProbe = undefined;
        }));
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  run(input) {
    if (this.closed) throw new BrowserError('PROVIDER_UNAVAILABLE', '插件正在停止');
    if (input.action === 'status') return this.status();
    if (input.action === 'list') {
      return this.track((async () => {
        const targets = await this.adapter.list(input.port, this.lifetime.signal);
        return targets.map((target) => ({
          ...publicTarget(target),
          connected: input.port === this.active?.port && target.id === this.active.target.id &&
            target[browserKey] === this.active.target[browserKey],
        }));
      })());
    }
    if (input.action === 'disconnect') return this.disconnect();
    return this.start(input);
  }

  lifetime = new AbortController();

  status() {
    const current = this.active || this.recovering;
    return {
      state: this.state, revision: this.revision, connected: Boolean(this.active),
      reconnecting: this.state === 'reconnecting', transport: 'chrome-cdp', launched: false,
      ...(current ? { port: current.port, target: publicTarget(current.target) } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  bridgeStatus(port) {
    return this.track(this.adapter.health(port, this.lifetime.signal));
  }

  track(task) {
    this.tasks.add(task);
    const remove = () => this.tasks.delete(task);
    task.then(remove, remove);
    return task;
  }

  begin(state) {
    this.operation?.abort(REPLACED());
    this.operation = new AbortController();
    this.revision += 1;
    this.state = state;
    this.recovering = undefined;
    this.lastError = undefined;
    return this.operation.signal;
  }

  async prepare(target, port, signal, requiredUrl) {
    let page;
    try {
      page = await this.adapter.attach(port, target.id, signal, target[browserKey]);
      const identity = await page.identity(signal);
      signal.throwIfAborted();
      if (page.lost) throw new BrowserError('TRANSPORT_ERROR', '目标在身份确认前断开');
      if (requiredUrl && normalizedUrl(identity.url) !== normalizedUrl(requiredUrl)) {
        throw new BrowserError('TARGET_CHANGED', '页签地址已变化，请重新选择目标');
      }
      return { page, target: { ...target, ...identity }, port };
    } catch (error) {
      await page?.dispose();
      throw error;
    }
  }

  start(input) {
    const signal = this.begin('connecting');
    return this.track(this.connect(input, signal));
  }

  async connect(input, signal) {
    let original;
    const errors = [];
    let count = 0;
    try {
      for (const wait of this.retryDelays) {
        if (wait) await delay(wait, undefined, { signal });
        try {
          const targets = await this.adapter.list(input.port, signal);
          count = targets.length;
          const target = original
            ? recoverTarget(targets, original)
            : selectTarget(targets, input, this.active);
          if (!target) throw MISSING();
          original ||= target;
          if (this.active?.target.id === target.id && this.active.port === input.port &&
              this.active.target[browserKey] === target[browserKey] && !this.active.page.lost) {
            const old = this.active;
            const identity = await old.page.identity(signal);
            signal.throwIfAborted();
            if (old !== this.active || old.page.lost) throw new BrowserError('TRANSPORT_ERROR', '页签已断开');
            if (normalizedUrl(identity.url) !== normalizedUrl(input.url || original.url)) {
              throw new BrowserError('TARGET_CHANGED', '页签地址已变化，请重新选择目标');
            }
            old.target = { ...target, ...identity };
            this.state = 'connected';
            return this.status();
          }
          const attached = await this.prepare(target, input.port, signal, input.url || original.url);
          return await this.commit(attached, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (['AMBIGUOUS_REFERENCE', 'TARGET_CHANGED', 'PROVIDER_UNAVAILABLE'].includes(error.code) ||
              (error.code === 'NOT_FOUND' && !original)) throw error;
          errors.push(error instanceof BrowserError ? error.message : '无法连接 Bridge');
        }
      }
      throw new BrowserError('TRANSPORT_ERROR', '未能附着到所选页签', {
        targetCount: count, originalError: errors[0], lastErrors: errors.slice(-3),
      });
    } catch (error) {
      signal.throwIfAborted();
      this.state = this.active ? 'connected' : 'failed';
      this.lastError = error instanceof BrowserError ? error.message : '无法连接 Bridge';
      throw error;
    }
  }

  async commit(attached, signal) {
    if (signal.aborted || attached.page.lost) {
      await attached.page.dispose();
      signal.throwIfAborted();
      throw new BrowserError('TRANSPORT_ERROR', '目标在连接提交前断开');
    }
    const previous = this.active;
    this.active = attached;
    this.state = 'connected';
    this.recovering = undefined;
    this.lastError = undefined;
    attached.page.once('lost', () => this.onLost(attached));
    await previous?.page.dispose();
    signal.throwIfAborted();
    return this.status();
  }

  onLost(old) {
    if (this.active !== old || this.closed) return;
    this.active = undefined;
    this.track(old.page.dispose());
    if (this.state === 'connecting') return;
    const signal = this.begin('reconnecting');
    this.recovering = old;
    this.track(this.restore(old, signal));
  }

  async restore(old, signal) {
    let lastError = '原页签已不可用';
    for (const wait of this.recoveryDelays) {
      try {
        await delay(wait, undefined, { signal });
        const targets = await this.adapter.list(old.port, signal);
        const target = recoverTarget(targets, old.target);
        if (!target) throw MISSING();
        const attached = await this.prepare(target, old.port, signal, old.target.url);
        await this.commit(attached, signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        lastError = error instanceof BrowserError ? error.message : '恢复连接失败';
        if (error.code === 'AMBIGUOUS_REFERENCE') break;
      }
    }
    this.state = 'failed';
    this.lastError = lastError;
    this.recovering = undefined;
  }

  async pageStatus() {
    const current = this.active;
    const revision = this.revision;
    if (!current) throw new BrowserError('PROVIDER_UNAVAILABLE', '请先连接 Chrome 页签');
    let identity;
    try {
      identity = await current.page.identity(this.lifetime.signal);
    } catch (error) {
      if (this.active !== current || this.revision !== revision) throw REPLACED();
      this.onLost(current);
      throw error;
    }
    if (this.active !== current || this.revision !== revision) throw REPLACED();
    current.target = { ...current.target, ...identity };
    return { target: publicTarget(current.target), transport: 'chrome-cdp', port: current.port, revision };
  }

  disconnect() {
    const signal = this.begin('disconnected');
    const previous = this.active;
    this.active = undefined;
    return this.track((async () => {
      await previous?.page.dispose();
      signal.throwIfAborted();
      return this.status();
    })());
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.lifetime.abort(REPLACED());
    await this.disconnect();
    await Promise.allSettled([...this.tasks]);
    await this.adapter.dispose?.();
  }
}

module.exports = { ConnectionService };
