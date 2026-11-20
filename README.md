# Cocos Chrome 浏览器连接

`cocos-browser-bridge` 是一个 Cocos Creator 扩展。它通过 CDP Bridge 扫描并连接 Chrome 中已经打开的 HTTP/HTTPS 页签，例如 Creator 的 Browser Preview。Creator 面板和本地 MCP 客户端共享一个活动页签，可回读页面的实际标题和 URL。断开会释放调试会话，原页签可以继续使用。

扩展清单要求 Cocos Creator **3.8.6 至 3.8.x**。面板已在 Windows 上的 Creator **3.8.8** 验证，真实 Chrome 页签的联调进度见 [首版验收记录](docs/acceptance.md)。

## 快速开始

### 1. 安装 Creator 扩展

解压 `cocos-browser-bridge-0.1.0.zip`，将里面的 `cocos-browser-bridge` 目录放进项目的 `extensions/`。安装后，扩展清单应位于 `<项目>/extensions/cocos-browser-bridge/package.json`。ZIP 已包含运行依赖。需要自行生成 ZIP 时，参见下文的「从源码构建」。

在 Creator 的「扩展 → 扩展管理器 → 已安装扩展」中刷新并启用扩展，再从顶部菜单打开「Chrome → 浏览器连接」。

### 2. 准备 Chrome CDP Bridge

在 Creator 面板点「检查 Bridge」。Windows 上如果已安装兼容的 **CDP Bridge 2.4.0**，插件会自动准备它使用的本机端口 `127.0.0.1:18765`。等面板显示「已联通」后即可扫描页签。这个通道读取标题和 URL。如果显示等待联通，可刷新 Chrome 中的目标页签后再检查。

使用标准 CDP 接管时，按以下步骤准备 **cdp-tunnel 3.6.4**。没有识别到扩展时，面板会显示「安装指引」。

已有正常运行的本地 relay 时可以复用。首次安装需要 Node.js 和 npm。在单独的目录中打开 PowerShell，安装项目核对过的 `cdp-tunnel@3.6.4`。

```powershell
npm.cmd install --save-exact cdp-tunnel@3.6.4
```

启动本机 relay 前，在这个安装副本的 `node_modules/cdp-tunnel` 下，将 `server/proxy-server.js` 与 `server/modules/port-pool.js` 中的监听地址由 `0.0.0.0` 改为 `127.0.0.1`。在同一工作目录运行以下命令，保留终端窗口。

```powershell
$env:POOL_SIZE = '0'
node .\node_modules\cdp-tunnel\server\proxy-server.js
```

在另一个 PowerShell 中检查 `9220` 与 `9221` 的实际监听地址。MCP 令牌只用于 Creator 插件的 HTTP 服务。

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9220,9221 |
  Select-Object LocalAddress, LocalPort
```

在目标 Chrome 用户配置中打开 `chrome://extensions`，启用「开发者模式」，选择「加载已解压的扩展程序」，加载 `node_modules/cdp-tunnel/extension-new`。在 CDP Bridge 的连接设置中确认本地 WebSocket 地址为 `ws://127.0.0.1:9221/plugin`。扩展加载方式可参阅 [CDP Tunnel 上游文档](https://github.com/dyyz1993/cdp-tunnel)。

| 本机地址 | 用途 |
| --- | --- |
| `ws://127.0.0.1:9221/plugin` | Chrome 扩展连接 relay |
| `http://127.0.0.1:9220` | Creator 插件扫描和接管已打开的页签 |
| `http://127.0.0.1:8765/mcp` | MCP 客户端连接 Creator 插件。占用时依次尝试到 `8785`，以面板显示为准 |

### 3. 连接并确认页签

1. 在 Chrome 打开目标网页。在 Creator 面板点击「检查 Bridge」，确认 Relay 在线、Chrome 扩展已联通、接管端点可用。
2. 点击「扫描页签」，选中目标，点击「连接所选页签」。也可填写目标 URL，再点击「接管已打开页签」。遇到多个匹配项时，从列表明确选择。
3. 点击「读取页面信息」，核对标题和 URL。使用完毕后点击「断开」。关闭面板后，共享的活动页签仍可供 MCP 调用。

## MCP 客户端接入

在面板的「本地 MCP」区域查看实际地址，点击「显示令牌」获取控制令牌或只读令牌。在客户端配置 Streamable HTTP 和 Bearer 认证。以下为 Codex 配置示例，启动客户端的环境中需将 `COCOS_MCP_AUTH_TOKEN` 设为对应令牌。

```toml
[mcp_servers.cocos-browser-bridge]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "COCOS_MCP_AUTH_TOKEN"
```

每个 MCP 会话从 `core` 开始。调用 `manage_tools`，传入 `{"action":"activate","profile":"runtime"}`，再在同一会话调用浏览器工具。扩展重载会生成新令牌，重连时使用面板显示的当前地址和令牌。

| 工具 | Profile | Action | 令牌权限 |
| --- | --- | --- | --- |
| `system` | `core` | `health` | 控制、只读 |
| `manage_tools` | `core` | `list_groups`、`activate` | 控制、只读 |
| `browser_connect` | `runtime` | `list`、`connect`、`adopt`、`status`、`disconnect` | 控制 |
| `browser_page` | `runtime` | `status` | 控制、只读 |

在源码目录运行 `npm.cmd ci` 后，可用下面的 PowerShell 示例检查连接。先在面板连接一个页签，按提示输入面板的控制令牌，并按需修改 MCP 地址。`--runtime` 会为脚本创建的会话激活工具。

```powershell
$env:COCOS_MCP_URL = 'http://127.0.0.1:8765/mcp'
$env:COCOS_MCP_AUTH_TOKEN = Read-Host 'MCP 控制令牌'
@'
{"name":"system","arguments":{"action":"health"}}
{"name":"browser_connect","arguments":{"action":"list"}}
{"name":"browser_page","arguments":{"action":"status"}}
'@ | node scripts/mcp-session.cjs --runtime
```

也可通过 MCP 连接页签。先调用 `browser_connect` 的 `list`，然后用 `{"action":"connect","targetId":"<列表返回的 id>"}` 连接，再用 `browser_page status` 回读标题和 URL。使用只读令牌时，由 Creator 面板或有控制权限的会话选择页签，客户端可通过 `browser_page status` 读取。

## 排查连接问题

| 现象 | 检查 |
| --- | --- |
| Relay 显示「未响应」 | 确认 relay 仍在运行，并检查 `http://127.0.0.1:9221/json/browsers` 是否返回浏览器列表 |
| Chrome 扩展显示「等待联通」 | 确认 CDP Bridge 已启用，刷新目标页签后点「检查 Bridge」。对于 cdp-tunnel，请核对 WebSocket 地址 |
| 接管端点显示「不可用」 | 核对面板的 CDP 端口，默认 `9220`。检查该端口的 `/json/version` 是否返回 cdp-tunnel 信息 |
| 扫描不到目标或匹配有歧义 | 确认目标是已打开的 HTTP/HTTPS 页签。匹配到多个页签时从列表明确选择。若 relay 连接了多个浏览器，保留目标浏览器的连接后重新扫描 |
| MCP 返回 `401` | 核对 Bearer 令牌是否来自当前运行的扩展实例 |
| MCP 客户端看不到浏览器工具 | 在同一会话激活 `runtime`。控制与只读令牌的工具权限见上表 |

## 从源码构建

以下命令从仓库根目录执行。构建和测试使用过 Node.js **24.14.0**，发布脚本依赖 Windows 的 `tar.exe`。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run release
```

发布命令会构建并生成 `release/cocos-browser-bridge-0.1.0.zip`。开发时也可单独运行 `npm.cmd run build` 和 `node scripts/stage.cjs`，将产物暂存到 `.local/creator-extension/cocos-browser-bridge`。首次调试时把暂存目录复制到 Creator 项目的 `extensions/`，之后更新项目中的副本并重载扩展。如果使用文件硬链接同步产物，项目下的扩展仍使用普通目录。验收时 Creator 3.8.8 未扫描到目录 Junction。

## 实机验证

先在 Creator 面板断开活动页签，释放接管连接。在 Chrome 打开两个地址不同的测试页，每个地址保留一个页签，然后用实际 URL 替换下面的示例值。脚本依次连接两个页签，回读页面身份，并确认断开后两个页签仍可发现。使用其他接管端口时，可在末尾追加端口号。

```powershell
node scripts/verify-bridge.cjs http://127.0.0.1:7456/ http://127.0.0.1:7457/
```

自动测试范围和实机进度见 [首版验收记录](docs/acceptance.md)，实现范围见 [开发计划](docs/development-plan.md)。
