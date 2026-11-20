# Cocos Chrome 浏览器连接

在 Cocos Creator 3.8.6–3.8.x 中通过 CDP Bridge 选取已打开的 Chrome 页签。Creator 面板和本地 MCP 共享活动目标。通过页签调试会话回读标题和 URL，断开后可以继续使用原页签。

## 安装插件

解压发布 ZIP，将 `cocos-browser-bridge` 目录放入项目的 `extensions/`。在 Creator 的「扩展 → 扩展管理器 → 已安装扩展」刷新并启用插件，再从顶部菜单的「Chrome → 浏览器连接」打开。解压版自带运行依赖。

开发时使用普通扩展目录加文件硬链接。Creator 3.8.8 的实测中，目录 Junction 未出现在扫描结果里。源码构建后运行 `node scripts/stage.cjs`，将产物写到 `.local/creator-extension/cocos-browser-bridge`，再重载插件。

## 准备 CDP Bridge

项目参考上游 `cdp-tunnel@3.6.4`。安装到自选的工作目录，使用包里的 `extension-new`。Chrome 的 CDP Bridge 扩展设置应连接 `ws://127.0.0.1:9221/plugin`。插件通过 `http://127.0.0.1:9220` 接管页签。已有健康 relay 可直接复用。[CDP Tunnel 安装说明](https://github.com/dyyz1993/cdp-tunnel)

在独立本地部署时，先核对 relay 的绑定。3.6.4 的 `server/proxy-server.js` 和 `server/modules/port-pool.js` 默认绑定 `0.0.0.0`。本机部署可以在独立包副本中将这些监听地址改为 `127.0.0.1`，将 `POOL_SIZE` 设为 `0`，然后运行该包的 `node server/proxy-server.js`。用系统监听列表确认 9220 和 9221 的实际绑定。MCP 凭据仅用于插件的 HTTP 服务。

打开测试页后在 Creator 面板点「检查 Bridge」，确认 relay 在线、Chrome 扩展已联通、接管端点可用。点「扫描页签」，从列表选择目标并连接。需要按 URL 选择时，可使用「接管已打开页签」。

## MCP 客户端接入

打开面板查看实际 MCP 地址。通过「显示令牌」获取控制令牌或只读令牌。每次重载插件会生成新令牌，客户端需更新环境变量。工具默认 profile 为 `core`，在同一会话中激活 `runtime` 后调用浏览器工具。

```toml
[mcp_servers.cocos-browser-bridge]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "COCOS_MCP_AUTH_TOKEN"
```

如面板显示其他端口，以面板为准。在源码目录运行 `npm.cmd ci` 后，可使用调试脚本。脚本从 `COCOS_MCP_URL` 和 `COCOS_MCP_AUTH_TOKEN` 读取配置，`--runtime` 自动激活当前会话的 runtime。

```powershell
@'
{"name":"system","arguments":{"action":"health"}}
{"name":"browser_connect","arguments":{"action":"list"}}
{"name":"browser_connect","arguments":{"action":"status"}}
'@ | node scripts/mcp-session.cjs --runtime
```

只读凭据在 runtime 中可以调用 `browser_page status`。`browser_connect` 的整个工具属于控制权限，包括其中的 list 和 status。按目标 ID 连接使用 `browser_connect connect`，随后以 `browser_page status` 回读页面身份。

## 构建与验收

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run release
```

发布 ZIP 保存在 `release/`。构建与测试命令在源码目录执行，交付记录见 [实机记录](docs/acceptance.md)，实施清单见 [开发计划](docs/development-plan.md)。

先断开 Creator 面板中的活动目标，使 `9220` 可接受实机验收脚本。打开两个地址不同的测试页后运行下列命令。把 URL 替换为地址栏中的实际地址。

```powershell
node scripts/verify-bridge.cjs http://127.0.0.1:7456/ http://127.0.0.1:7457/
```
