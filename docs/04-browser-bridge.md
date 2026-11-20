# 04 CDP Bridge 与旧版兼容

CDP Bridge 是现成 Chrome 扩展，连接本地 relay；relay 暴露 CDP 端点供 Creator 插件使用。首版不编写浏览器扩展。

```text
Creator CDP 客户端 → 9220 接管端点 → relay ← 9221/plugin ← CDP Bridge ← Chrome 页签
```

## 发现目标

1. `CDP.List({host:"127.0.0.1",port:9220})`，参考超时 3 秒，过滤 HTTP/HTTPS page。
2. 保留原始 ID、URL、标题、可得的 active/tabId；根据当前 ID 标记 connected。
3. 目录不完整时，用独立临时浏览器 WebSocket 调 Bridge 自定义 `Tab.getMuteStatus({cdpOnly:false})` 补扫。只取合法数字 tab ID 与 HTTP/HTTPS URL，连接和命令分别参考 1.5 秒上限。
4. 补扫失败保留主目录，结束或迟到返回均清理临时连接。补扫按原始 URL 去重，但不能因此合并主目录中同 URL 的多个真实目标。

发现连接与业务页签 session 分开；不能在已附着的页面 session 上执行浏览器级补扫。

用户资料标注 `cdp-tunnel@3.6.4` 支持数字字符串 ID 映射 tabId，其他 ID 经 `chrome.debugger.getTargets()` 定位。目标 ID 必须原样保留，不能擅自转成数字或重写。

## 附着与页面会话

1. 从选页端口调用 `CDP.Version`，校验 `webSocketDebuggerUrl` 为 `ws:`、本地主机、同一发现端口、`/devtools/browser/` 路径，连接主机统一为 `127.0.0.1`。
2. 连接浏览器 WebSocket，发送 `Target.attachToTarget({targetId,flatten:true})`。
3. 仅在已经连通 9220 WebSocket、随后附着失败时，参考实现关闭原连接并回退 `ws://127.0.0.1:9221/client`，使用同一 ID 重试。版本发现或首次 socket 失败不进入这个内部回退。
4. 用返回的 `sessionId` 包装页面 session：Runtime/Page/Input/Network 等页面命令携带该 ID，页面事件按 ID 过滤；Browser/Target 使用浏览器级连接。
5. 结果为 `connected=true`、`transport=chrome-cdp`，再经页面会话读取实际标题和 URL。连接不隐式启动监控。

```jsonl
{"id":1,"method":"Target.attachToTarget","params":{"targetId":"37","flatten":true}}
{"id":1,"result":{"sessionId":"session-demo"}}
{"id":2,"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true},"sessionId":"session-demo"}
```

`9221/client` 是特定旧兼容路径，不应当作日常接管入口；实际兼容策略需对锁定版本核验。

## 断开

停止本目标采集，清理监听，发送 `Target.detachFromTarget({sessionId})`，参考等待上限 1.5 秒，随后释放拥有的 socket。异常断线按 [05](05-target-lifecycle.md) 判断恢复。

完整系统断开后回到 GameView；当前 Bridge 首版没有 GameView，断开后明确为未连接。两种情况均保留用户 Chrome 与页签。

## 安装与分发参考

参考部署流程包括检查 Node/npm/Chrome、准备 `cdp-tunnel@3.6.4`、签名 CRX、扩展 ID、update.xml，以及回环更新服务。安装策略写入 `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`，需要管理员授权；可能正常退出并重新打开 Chrome。签名私钥属于安装端，扩展 ID 以签名产物为准，不硬编码历史 ID。

配置时先检查 `9220/9221`。健康 relay 可复用，端口被其他服务占用则明确报错。按用户配置检查扩展安装，自定义 `--user-data-dir` 单独核对。日志参考 `bridge-setup.log`。

这些是参考系统的安装能力。首版优先编写现成 Bridge 的安装与启动说明，不默认开发企业策略、CRX 分发或一键安装脚本。

## 故障分层

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9221/json/browsers' -TimeoutSec 3
Invoke-RestMethod -Uri 'http://127.0.0.1:9220/json/version' -TimeoutSec 3
Invoke-RestMethod -Uri 'http://127.0.0.1:9220/json/list' -TimeoutSec 3
```

分别记录 relay 运行、扩展已连接、发现接口、实际附着和回读结果。HTTP 可用或目录非空均不足以证明目标会话可用。缺少安装检测证据时应显示未知，不能把 relay 断线推断成未安装扩展。

用户资料指出 3.6.4 的 relay 和端口池监听 `0.0.0.0`；本项目未独立核验。不能因为客户端连接 `127.0.0.1` 就宣称服务仅回环开放。实施时核对并记录实际绑定及访问保护，MCP token 不覆盖此链路。

## 旧 Companion（后续兼容）

旧通道在 MCP HTTP server 挂载 `/browser-companion` WebSocket，处理 hello、heartbeat、response、event、detached。命令按 ID 匹配 pending，断线或超时清理；目标前缀 `companion:`，transport 为 `chrome-companion`。参考服务按固定 Origin 或 token 验证，不能直接将该历史策略视为新项目安全契约。旧扩展默认仅报告预览页，需独立回归，首版不实现。

## 验收重点

- 主目录为空、数字 tab ID、补扫超时，临时 socket 全部回收。
- 两个同 URL 页签不被误合并；不同 session 的事件隔离。
- 只有附着失败触发指定内部回退，原连接释放。
- 切换、断开后旧回包及恢复任务失效，两张用户页均保留。
- 分别记录扩展安装、relay、扩展在线、目标回读及网络绑定。

参考：[CDP Tunnel 上游](https://github.com/dyyz1993/cdp-tunnel)、[发现](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-discovery.ts)、[Bridge 附着](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/cdp-tunnel-session.ts)、[安装脚本](https://boke.feishu.cn/extensions/cocos_mcp/browser-companion/setup-browser-bridge.ps1)、[扩展 debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)。
