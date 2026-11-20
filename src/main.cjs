const { BridgeAdapter } = require('./bridge.cjs');
const { ConnectionService } = require('./connection.cjs');
const { McpHost } = require('./mcp.cjs');
const { port, connection, BrowserError, result } = require('./contract.cjs');
const { name } = require('../package.json');

let runtime;
let shutdown = Promise.resolve();

function load() {
  if (runtime) return;
  const service = new ConnectionService(new BridgeAdapter());
  const host = new McpHost(service);
  const current = { service, host };
  runtime = current;
  current.startup = shutdown.then(() => {
    if (runtime === current) return host.start();
  }).catch(() => {
    current.error = 'MCP 服务启动失败，请检查 8765–8785 是否可用。';
  });
}

function unload() {
  if (!runtime) return shutdown;
  const current = runtime;
  runtime = undefined;
  shutdown = Promise.allSettled([current.service.dispose(), current.host.stop()]).then(() => {});
  return shutdown;
}

function currentRuntime() {
  if (!runtime) throw new BrowserError('PROVIDER_UNAVAILABLE', '插件尚未启动');
  return runtime;
}

const methods = {
  openPanel() {
    return Editor.Panel.open(name);
  },
  serviceInfo() {
    return result(() => {
      const { host, error } = currentRuntime();
      return error ? { state: 'failed', error } : host.health();
    });
  },
  mcpCredentials() {
    return result(() => {
      const { host } = currentRuntime();
      if (host.health().state !== 'ready') throw new BrowserError('PROVIDER_UNAVAILABLE', 'MCP 服务尚未启动');
      return { ...host.tokens };
    });
  },
  bridgeStatus(input) {
    return result(() => currentRuntime().service.bridgeStatus(port.parse(input)));
  },
  listBrowserTargets(input) {
    return methods.connectBrowser({ action: 'list', port: input });
  },
  connectBrowser(input) {
    return result(() => currentRuntime().service.run(connection.parse(input)));
  },
  browserPageStatus() {
    return result(() => currentRuntime().service.pageStatus());
  },
};

module.exports = { load, unload, methods };
