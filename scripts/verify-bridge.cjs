const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { BridgeAdapter } = require('../src/bridge.cjs');
const { ConnectionService } = require('../src/connection.cjs');
const { isWebUrl, normalizedUrl } = require('../src/contract.cjs');

async function main() {
  const [first, second, portText = '9220'] = process.argv.slice(2);
  const port = Number(portText);
  if (![first, second].every(isWebUrl) || normalizedUrl(first) === normalizedUrl(second) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('用法 node scripts/verify-bridge.cjs <已打开的预览 URL> <已打开的测试页 URL> [CDP 端口]');
  }
  const service = new ConnectionService(new BridgeAdapter());
  try {
    const health = await service.bridgeStatus(port);
    assert.equal(health.relayAvailable, true, 'relay 未在线');
    assert.equal(health.extensionConnected, true, 'Chrome 中的 Bridge 尚未连接');
    assert.equal(health.discoveryAvailable, true, '接管端点不可用');
    const before = await service.run({ action: 'list', port });
    const observed = [];
    for (const url of [first, second]) {
      const matches = before.filter((target) => normalizedUrl(target.url) === normalizedUrl(url));
      assert.equal(matches.length, 1, '每个测试地址应有一个明确的页签');
      const [{ id, title }] = matches;
      await service.run({ action: 'connect', port, targetId: id, title, url });
      const actual = await service.pageStatus();
      assert.equal(actual.target.id, id);
      assert.equal(normalizedUrl(actual.target.url), normalizedUrl(url));
      observed.push({ targetId: id, title: actual.target.title, transport: actual.transport });
    }
    await service.run({ action: 'disconnect' });
    assert.equal(service.status().connected, false);
    // cdp-tunnel 3.6.4 can reuse its target directory for two seconds.
    await delay(2100);
    const after = await service.run({ action: 'list', port });
    for (const url of [first, second]) {
      assert.ok(after.some((target) => normalizedUrl(target.url) === normalizedUrl(url)), '断开后测试页须继续存在');
    }
    console.log(JSON.stringify({ bridge: health.version, port, observed, disconnected: true, pagesPreserved: true }));
  } finally {
    await service.dispose();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
