const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const NAME = 'cocos-browser-bridge';
const INSTANCE = Symbol('browser panel');
const STATES = {
  disconnected: '未连接', connecting: '连接中', connected: '已连接',
  reconnecting: '重连中', failed: '连接失败',
};

async function request(message, payload) {
  const response = await Editor.Message.request(NAME, message, payload);
  if (!response?.ok) throw new Error(response?.error?.message || '插件主进程未返回结果');
  return response.data;
}

function setup(panel) {
  const $ = panel.$;
  const handlers = new AbortController();
  let closed = false;
  let viewRevision = 0;
  let scanning = false;
  let polling = false;
  let targetList = [];
  let status;
  let poll;

  function renderStatus(next) {
    if (next.revision < (status?.revision ?? 0)) return;
    status = next;
    $.state.textContent = STATES[next.state] ?? next.state;
    $.state.dataset.state = next.state;
    const { title, url, id } = next.target ?? {};
    $.targetTitle.textContent = title || (id ? '无标题' : '尚未选择页签');
    $.targetUrl.textContent = url || '';
    $.targetId.textContent = id ? `目标 ${id} · CDP ${next.port}` : '';
    $.connectionError.textContent = next.error || '';
    $.read.disabled = !next.connected;
    $.disconnect.disabled = !next.connected && !['connecting', 'reconnecting'].includes(next.state);
    for (const option of $.targets.options) {
      const target = targetList.find((item) => item.id === option.value);
      if (!target) continue;
      const prefix = id === target.id && next.connected && next.port === Number($.port.value) ? '已连接 · ' : '';
      option.textContent = `${prefix}${target.title || '无标题'} — ${target.url}`;
    }
  }

  function readPort() {
    const value = Number($.port.value);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('请输入 1–65535 的 CDP 端口');
    return value;
  }

  async function refresh() {
    if (closed || polling) return;
    polling = true;
    const revision = viewRevision;
    try {
      const [next, info] = await Promise.all([
        request('connect-browser', { action: 'status' }), request('service-info'),
      ]);
      if (closed || revision !== viewRevision) return;
      renderStatus(next);
      $.service.textContent = info.url || info.error || 'MCP 服务正在启动…';
      $.credentials.disabled = info.state !== 'ready';
    } catch (error) {
      if (!closed && revision === viewRevision) $.service.textContent = error.message;
    } finally {
      polling = false;
    }
  }

  async function health() {
    const port = readPort();
    $.check.disabled = true;
    try {
      const bridge = await request('bridge-status', port);
      if (closed || port !== Number($.port.value)) return;
      $.relay.textContent = bridge.relayAvailable ? '在线' : '未响应';
      $.extension.textContent = bridge.extensionConnected === null ? '未知' :
        bridge.extensionConnected ? '已联通' : '等待联通';
      $.discovery.textContent = bridge.discoveryAvailable ? `可用${bridge.version ? ` · ${bridge.version}` : ''}` : '不可用';
    } finally {
      if (!closed) $.check.disabled = false;
    }
  }

  async function scan() {
    if (scanning) return;
    const port = readPort();
    scanning = true;
    $.scan.disabled = true;
    $.scan.textContent = '扫描中…';
    try {
      const targets = await request('list-browser-targets', port);
      if (closed || port !== Number($.port.value)) return;
      const selected = $.targets.value;
      targetList = targets;
      $.targets.replaceChildren(new Option(targets.length ? '选择 Chrome 页签' : '没有可用页签', ''));
      for (const target of targets) {
        $.targets.add(new Option(`${target.connected ? '已连接 · ' : ''}${target.title || '无标题'} — ${target.url}`, target.id));
      }
      if (targets.some(({ id }) => id === selected)) $.targets.value = selected;
      $.connect.disabled = !$.targets.value;
    } finally {
      if (!closed) {
        scanning = false;
        $.scan.disabled = false;
        $.scan.textContent = '扫描页签';
      }
    }
  }

  async function change(input) {
    const revision = ++viewRevision;
    $.state.textContent = input.action === 'disconnect' ? '正在断开…' : '连接中';
    $.disconnect.disabled = input.action === 'disconnect';
    try {
      const next = await request('connect-browser', input);
      if (!closed && revision === viewRevision) {
        viewRevision += 1;
        renderStatus(next);
      }
    } catch (error) {
      if (!closed && revision === viewRevision) {
        const completedRevision = ++viewRevision;
        await refresh();
        if (!closed && completedRevision === viewRevision) $.message.textContent = error.message;
      }
    }
  }

  function on(element, event, callback) {
    element.addEventListener(event, async () => {
      $.message.textContent = '';
      const revision = viewRevision;
      try {
        await callback();
      } catch (error) {
        if (!closed && revision === viewRevision) $.message.textContent = error.message;
      }
    }, { signal: handlers.signal });
  }
  on($.check, 'click', health);
  on($.scan, 'click', scan);
  on($.port, 'input', () => {
    targetList = [];
    $.targets.replaceChildren(new Option('请扫描页签', ''));
    $.connect.disabled = true;
    for (const element of [$.relay, $.extension, $.discovery]) element.textContent = '待检查';
  });
  on($.targets, 'change', () => { $.connect.disabled = !$.targets.value; });
  on($.connect, 'click', () => {
    const target = targetList.find(({ id }) => id === $.targets.value);
    if (!target) throw new Error('请先选择页签');
    return change({ action: 'connect', port: readPort(), targetId: target.id, url: target.url, title: target.title });
  });
  on($.adopt, 'click', () => {
    const url = $.url.value.trim();
    return change({ action: 'adopt', port: readPort(), ...(url ? { url } : {}) });
  });
  on($.disconnect, 'click', () => change({ action: 'disconnect' }));
  on($.read, 'click', async () => {
    const revision = viewRevision;
    const answer = await request('browser-page-status');
    if (closed || revision !== viewRevision || answer.revision < (status?.revision ?? 0)) return;
    $.message.textContent = '已从活动页签读取标题和地址。';
    await refresh();
  });
  on($.credentials, 'click', async () => {
    if (!$.tokens.hidden) {
      $.control.value = '';
      $.readonly.value = '';
      $.tokens.hidden = true;
      $.credentials.textContent = '显示令牌';
      return;
    }
    const { control, readOnly } = await request('mcp-credentials');
    if (closed) return;
    $.control.value = control;
    $.readonly.value = readOnly;
    $.tokens.hidden = false;
    $.credentials.textContent = '隐藏令牌';
  });
  void refresh();
  void health().catch(() => {});
  poll = setInterval(refresh, 1500);
  return () => {
    closed = true;
    handlers.abort();
    clearInterval(poll);
    $.control.value = '';
    $.readonly.value = '';
  };
}

module.exports = Editor.Panel.define({
  template: readFileSync(join(__dirname, 'index.html'), 'utf8'),
  style: readFileSync(join(__dirname, 'index.css'), 'utf8'),
  $: Object.fromEntries([
    'state', 'targetTitle', 'targetUrl', 'targetId', 'connectionError',
    'service', 'credentials', 'tokens', 'control', 'readonly', 'message',
    'port', 'check', 'relay', 'extension', 'discovery', 'scan', 'targets',
    'connect', 'url', 'adopt', 'read', 'disconnect',
  ].map((id) => [id, `#${id}`])),
  ready() {
    this[INSTANCE]?.();
    this[INSTANCE] = setup(this);
  },
  close() {
    this[INSTANCE]?.();
    delete this[INSTANCE];
  },
});
