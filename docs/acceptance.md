# 首版验收记录

记录版本为 `cocos-browser-bridge 0.1.0`。Windows 实机装有 Creator 3.8.7 和 3.8.8，两者的 Electron 运行时均为 31.3.1、Node 20.15.1。Creator 界面验收使用 3.8.8。开发和测试使用 Node 24.14.0。系统 Chrome 为 157.0.8103.79。插件清单要求 Creator 3.8.6 至 3.8.x。

| 阶段 | 已取得的证据 | 仍需实机验证 |
| --- | --- | --- |
| M0 Bridge | 已下载并核对 cdp-tunnel 3.6.4。隔离 relay 确认监听 `127.0.0.1:9220/9221`，三个发现端点可响应 | Chrome 扩展接入后的真实附着与断开 |
| M1 插件入口 | Creator 3.8.8 的 `cat_game1` 已识别并启用插件。最终面板从菜单打开，显示项目进程上的 MCP 地址和 relay 3.6.4 的状态。工程使用普通目录和文件硬链接 | 完整面板操作及关闭重开时的现场验证 |
| M2 MCP | 真实 HTTP SDK 会话通过 profile 隔离、只读凭据、Host/Origin、Bearer、会话终止和端口回收测试。独立 Creator 进程从解压包启动 MCP 并返回 `GET /health`。用户工程实机验证了面板与只读 MCP 回读同一 Chrome 目标 | 标准 Bridge 通道的双向切换 |
| M3 连接 | WebSocket 测试覆盖 flatten session、回读身份、不同 session 隔离、补扫、同 URL 区分、旧端点回退与明确断开 | 使用真实扩展验证协议与 Chrome 页签保留 |
| M4 面板与恢复 | 连接测试覆盖旧 ID、目标身份、有歧义时停止恢复、取消后晚到会话的释放、单接管 socket 切页。最终 ZIP 的 IPC 和真实 MCP 会话对本地替身目标双向同步 | 实际 Chrome 页签的面板双向操作、relay 中断和浏览器恢复 |
| M5 交付 | 测试通过后构建 ZIP，核对清单导出、主入口和面板文件。独立验收工程解压 ZIP 后服务启动。真实 Creator Browser Preview 的标题与 URL 已回读 | 完成登录后的独立工程面板、最终包卸载、标准 Bridge 实机验收 |

## 已安装 Bridge 2.4.0 的页签链接

本机同名 CDP Bridge 2.4.0 使用 `127.0.0.1:18765`。插件通过独立的只读通道与它连接。使用真实 Chrome 回读了预览标题 `Cocos Creator - cat_game1` 和地址 `http://localhost:7456/`，断开后再次扫描仍可找到该页签。标准 cdp-tunnel 3.6.4 的实际调试附着仍需该版本扩展接入后验证。

更新已同步到 `cat_game1` 并在现有 Creator 3.8.8 会话重载。实机点「扫描页签」，选择并连接预览页。Creator 面板与同进程的只读 HTTP MCP 会话均回读相同标题和 URL。现有扩展在本机自动联通，面板显示 `18765` 与 `2.4.0`。14 项自动测试通过。独立审查发现的通道选择不一致和页签 ID 冲突已修复，并纳入回归检查。

## 检查命令

```powershell
npm.cmd test
npm.cmd run release
npm.cmd audit --omit=dev --registry=https://registry.npmjs.org
```

WebSocket 和选择测试使用替身浏览器。SDK 测试使用真实回环 HTTP 及 SDK 客户端，浏览器适配器为替身。独立运行的 relay 及 Creator 端口探测来自实机。真实 Chrome 用例在两个指定页签打开后通过 `scripts/verify-bridge.cjs` 执行。

另在隔离的 `19220/19221` 启动 3.6.4 relay，接入受控扩展替身。通过发现两个目标、flatten 读取、单 WebSocket 切页和显式 detach。测试退出时关闭 relay 子进程。Chrome 的 `chrome.debugger` 行为仍由实机用例覆盖。

加入 2.4.0 兼容前的自动测试为 13 项通过；当前为 14 项。npm 运行依赖通过官方注册表的审计检查。工作区构建包和用户工程中的入口、面板与清单逐文件比较一致，文件硬链接保留。

后续复验还分别加载了源码入口和最终 ZIP 的解压入口。对两者发起 MCP `initialize` 均返回 HTTP 200 和会话 ID。SSE 空闲回收用例改用受控时钟，先证实 SDK 的回环事件流已打开，再验证过期会话返回 404。

本次串行复验 13 项通过。最终 ZIP 的额外联调使用真实 HTTP MCP 和本地 CDP 替身。通过 IPC 连接 `alpha` 后，控制和只读客户端都读取到该目标。控制客户端切换到 `beta` 后，IPC 读取到 `beta`。只读会话无法断开；切换和卸载分别释放对应会话，卸载后 HTTP 服务关闭，重载时处于未连接状态。

## 当前环境状态

- 测试 relay 的 `9221/json/browsers` 返回空列表。`9220/json/version` 报告 relay 3.6.4、`totalPlugins=0`，目标目录为空。
- 用户工程的 Creator Browser Preview 服务对 `http://127.0.0.1:7456/` 返回 200。已通过 2.4.0 从 Chrome 回读实际页签的地址 `http://localhost:7456/`。
- 用户工程已运行当前插件。实机确认顶栏的「Chrome」位于「Funplay」右侧，点击「Chrome → 浏览器连接」可打开面板。面板已通过 `18765` 连接 2.4.0 页签，项目进程的 `http://127.0.0.1:8765/health` 返回 ready。
- 将当前发布包解压到独立 `Bridge Acceptance` 工程，用 Creator 3.8.8 重新启动。该实例在 `127.0.0.1:8767` 返回 `ready`，无效令牌访问 `/mcp` 返回 401。同一时间 `cat_game1` 的 `8765` 服务仍正常。独立工程已打开并停在 Cocos Developer Login，面板操作和卸载验收等待用户登录。
- 自动审核阻止通过命令启动加载 Bridge 的隔离 Chrome，执行器显示 `blocked by policy`。

## 代码审查

使用 `ai-code-author` 实现，使用 `ai-code-reviewer` 完成三轮独立审查。第 1 轮记录 F1–F8。复审聚焦超时、卸载和浏览器更换时的竞态。最后一轮报告后补齐卸载等待迟到附着清理，以及扫描前后校验浏览器身份的回归，13 项检查通过。最后两处变更以回归测试核实。

附着命令默认为 3 秒超时。对于已经发出的附着，保留最多 12 秒收取迟到结果和清理会话。超过该窗口或 relay 已不可达时，扩展无法确认 Chrome 端的附着结果。真实扩展的恢复和资源清理仍列入实机验收。
