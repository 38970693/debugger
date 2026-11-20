# 首版验收记录

记录版本为 `cocos-browser-bridge 0.1.0`。Windows 实机装有 Creator 3.8.7 和 3.8.8，两者的 Electron 运行时均为 31.3.1、Node 20.15.1。Creator 界面验收使用 3.8.8。开发和测试使用 Node 24.14.0。系统 Chrome 为 157.0.8103.79。插件清单要求 Creator 3.8.6 至 3.8.x。

| 阶段 | 已取得的证据 | 仍需实机验证 |
| --- | --- | --- |
| M0 Bridge | 已下载并核对 cdp-tunnel 3.6.4。隔离 relay 确认监听 `127.0.0.1:9220/9221`，三个发现端点可响应 | Chrome 扩展接入后的真实附着与断开 |
| M1 插件入口 | Creator 3.8.8 的 `cat_game1` 已识别并启用插件。最终面板从菜单打开，显示项目进程上的 MCP 地址和 relay 3.6.4 的状态。工程使用普通目录和文件硬链接 | 完整面板操作及关闭重开时的现场验证 |
| M2 MCP | 真实 HTTP SDK 会话通过 profile 隔离、只读凭据、Host/Origin、Bearer、会话终止和端口回收测试。独立 Creator 进程从解压包启动 MCP 并返回 `GET /health` | 在 Creator 内跨入口读到同一真实 Chrome 目标 |
| M3 连接 | WebSocket 测试覆盖 flatten session、回读身份、不同 session 隔离、补扫、同 URL 区分、旧端点回退与明确断开 | 使用真实扩展验证协议与 Chrome 页签保留 |
| M4 面板与恢复 | 连接测试覆盖旧 ID、目标身份、有歧义时停止恢复、取消后晚到会话的释放、单接管 socket 切页。最终 ZIP 的 IPC 和真实 MCP 会话对本地替身目标双向同步 | 实际 Chrome 页签的面板双向操作、relay 中断和浏览器恢复 |
| M5 交付 | 测试通过后构建 ZIP，核对清单导出、主入口和面板文件。独立验收工程解压 ZIP 后服务启动 | 完成登录后的独立工程面板、最终包卸载、真实 Creator Browser Preview |

## 检查命令

```powershell
npm.cmd test
npm.cmd run release
npm.cmd audit --omit=dev --registry=https://registry.npmjs.org
```

WebSocket 和选择测试使用替身浏览器。SDK 测试使用真实回环 HTTP 及 SDK 客户端，浏览器适配器为替身。独立运行的 relay 及 Creator 端口探测来自实机。真实 Chrome 用例在两个指定页签打开后通过 `scripts/verify-bridge.cjs` 执行。

另在隔离的 `19220/19221` 启动 3.6.4 relay，接入受控扩展替身。通过发现两个目标、flatten 读取、单 WebSocket 切页和显式 detach。测试退出时关闭 relay 子进程。Chrome 的 `chrome.debugger` 行为仍由实机用例覆盖。

当前自动测试结果为 13 项通过。npm 运行依赖通过官方注册表的审计检查。工作区构建包和用户工程中的入口、面板与清单逐文件比较一致，文件硬链接保留。

后续复验还分别加载了源码入口和最终 ZIP 的解压入口。对两者发起 MCP `initialize` 均返回 HTTP 200 和会话 ID。SSE 空闲回收用例改用受控时钟，先证实 SDK 的回环事件流已打开，再验证过期会话返回 404。

本次串行复验 13 项通过。最终 ZIP 的额外联调使用真实 HTTP MCP 和本地 CDP 替身。通过 IPC 连接 `alpha` 后，控制和只读客户端都读取到该目标。控制客户端切换到 `beta` 后，IPC 读取到 `beta`。只读会话无法断开；切换和卸载分别释放对应会话，卸载后 HTTP 服务关闭，重载时处于未连接状态。

## 当前环境状态

- 测试 relay 的 `9221/json/browsers` 返回空列表。`9220/json/version` 报告 relay 3.6.4、`totalPlugins=0`，目标目录为空。
- 用户工程的 Creator Browser Preview 服务对 `http://127.0.0.1:7456/` 返回 200，浏览器页签会话仍待验证。
- 用户工程已运行最终版插件。实机确认顶栏的「Chrome」位于「Funplay」右侧，点击「Chrome → 浏览器连接」可打开面板。面板显示「Relay 在线」「Chrome 扩展 等待联通」「接管端点 可用 · 3.6.4」，项目进程的 `http://127.0.0.1:8765/health` 返回 ready。
- 独立 Creator 工程通过解压 ZIP 启动了插件服务。窗口显示 Cocos Developer Login，独立工程的面板验收等待登录授权。
- 自动审核阻止通过命令启动加载 Bridge 的隔离 Chrome，执行器显示 `blocked by policy`。

## 代码审查

使用 `ai-code-author` 实现，使用 `ai-code-reviewer` 完成三轮独立审查。第 1 轮记录 F1–F8。复审聚焦超时、卸载和浏览器更换时的竞态。最后一轮报告后补齐卸载等待迟到附着清理，以及扫描前后校验浏览器身份的回归，13 项检查通过。最后两处变更以回归测试核实。

附着命令默认为 3 秒超时。对于已经发出的附着，保留最多 12 秒收取迟到结果和清理会话。超过该窗口或 relay 已不可达时，扩展无法确认 Chrome 端的附着结果。真实扩展的恢复和资源清理仍列入实机验收。
