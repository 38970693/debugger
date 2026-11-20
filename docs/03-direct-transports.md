# 03 GameView 与 Chrome 直连适配器

本篇为后续能力参考，不属于 Bridge 首版。

## GameView

- 通过 Creator Electron 运行时定位活动 GameView `webContents` 和运行区域。没有可用预览时报告不可用，不能将固定目标 ID 当作连接健康证明。
- 目标 ID 与 transport 均为 `creator-gameview`。
- 探针用 `executeJavaScript`；截图按预览区域 `capturePage`；输入用 `sendInputEvent` 等接口。
- 监控单独由 `CreatorElectronBrowserMonitor` 管理，附着 Electron debugger，启用 Runtime，按可用性启用 Log/Network。
- 已有 debugger 占用应明确提示。停止时按原引用解绑，只释放本次附着；预览由 Creator 管理。

## 专用 Chrome 与显式端口

定位 Chrome，从 `9222` 起查找可用回环端口，创建独立用户目录。参数以独立进程参数传递：

```text
--remote-debugging-port=PORT
--remote-debugging-address=127.0.0.1
--user-data-dir=DIR
--no-first-run
--no-default-browser-check
URL
```

启动后在有界窗口轮询发现。首次 MCP `launch` 未传 URL 时使用 `about:blank`，仅在本适配器拥有的端口接纳该空白页；面板另行解析预览 URL。适配器已拥有的进程可复用，启动超时清理本次资源。

显式 CDP 先 `list(port)` 后在同端口按 ID 连接；用户启动的浏览器不属于适配器，不随插件卸载关闭。

## Chrome 原生共存

用户资料将此能力标为 Chrome 144+；实施前需以目标 Chrome 版本和官方说明重新核验，当前未执行实机验证。

1. 用户在 `chrome://inspect/#remote-debugging` 启用远程调试，调用 `current`，在 Chrome 授权提示中允许。
2. Windows 默认读取 `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort`，自定义用户目录需要单独适配。
3. 第一行为 1–65535 端口，排除 `9220/9221`；第二行为 `/devtools/browser/<id>`，校验路径及多余内容。
4. 连接回环浏览器 WebSocket，列举 `Target.getTargets` 的 HTTP/HTTPS page，再 flatten 附着。建立连接、发现和附着参考等待上限分别为 60 秒，客户端超时需覆盖授权窗口。
5. 传入 URL 时精确匹配。省略时优先已记录 URL，再本机 7456 预览，最后唯一 HTTP/HTTPS 候选；同 URL 多页需提示歧义。
6. 成功提交前校验连接代次，返回 `transport=chrome-cdp`、`devToolsCompatible=true`；真实共存仍需在同页 DevTools 验证。

浏览器级 WebSocket 保存授权；页签级 session 保存附着。`createCdpPageSession(browser, sessionId, false)` 释放页签时保留父连接。页签读超时且父连接有效时可复用授权恢复。显式断开先释放 session，再关闭适配器拥有的父连接，保留 Chrome 和 DevTools。

原生失败不得自动切到 Bridge；返回授权、端点或选页错误。新附着成功前可保留原健康连接。

## 验收

- GameView 关闭预览后状态变化，debugger 占用可解释。
- 专用 Chrome 空白页、断开复用、启动失败回收；显式端口断开保留用户进程。
- 原生授权后 MCP 与 DevTools 指向同一页。
- 不同 `sessionId` 事件隔离；关闭后的迟到命令和事件不影响下一目标。

参考：[GameView 页面](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-page-electron.ts)、[Chrome 适配器](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-monitor-cdp.ts)、[原生连接](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/existing-chrome-connection.ts)、[页签代理](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/cdp-page-session.ts)、[Chrome 官方接入说明](https://developer.chrome.com/docs/devtools/agents/get-started/configuration/)。
