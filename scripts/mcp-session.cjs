const { createInterface } = require('node:readline');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function main() {
  const { COCOS_MCP_URL: address, COCOS_MCP_AUTH_TOKEN: token } = process.env;
  if (!address || !token) throw new Error('请设置 COCOS_MCP_URL 和 COCOS_MCP_AUTH_TOKEN');
  const url = new URL(address);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
    throw new Error('MCP 调试脚本仅接受本机 /mcp 地址');
  }
  const client = new Client({ name: 'cocos-browser-bridge-session', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    if (process.argv.includes('--runtime')) {
      const activation = await client.callTool({ name: 'manage_tools', arguments: { action: 'activate', profile: 'runtime' } });
      if (activation.isError) throw new Error('无法激活 runtime profile');
    }
    let failed = false;
    for await (const line of createInterface({ input: process.stdin })) {
      if (!line.trim()) continue;
      const toolResult = await client.callTool(JSON.parse(line));
      console.log(JSON.stringify(toolResult.structuredContent ?? { isError: toolResult.isError }));
      failed ||= Boolean(toolResult.isError);
    }
    if (failed) process.exitCode = 1;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
