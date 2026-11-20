# 09 Creator 面板与 IPC

主进程持有连接，面板组织输入与显示。面板关闭只清理界面任务，不断开扩展实例共享的浏览器目标。

## 消息契约

| 界面入口 | 消息 | 参数 |
| --- | --- | --- |
| 扫描 | list-browser-targets | port |
| 列表连接 | connect-browser | action:connect、port、targetId、url、title |
| 接管 | connect-browser | action:adopt、port、url? |
| 原生共存（后续） | connect-browser | action:current、url? |
| 专用 Chrome（后续） | connect-browser | action:launch、url? |
| 断开 | connect-browser | action:disconnect |
| 页面状态 | browser-page-status | 首版仅标题、URL 与目标身份 |
| 截图（后续） | browser-screenshot | 返回路径和尺寸 |
| 观察（后续） | browser-observe | durationMs:5000、detail:summary |
| 监听结果（后续） | browser-monitor-snapshot | 当前窗口事件及覆盖范围 |

连接状态还需要 IPC 查询入口，首版可复用 `connect-browser {action:"status"}`，在实现契约中固定。

在 package.json contributions.messages 注册并绑定主进程导出方法；面板通过 `Editor.Message.request` 调用容器中的同一连接服务。参考系统兼容数字参数 browser-observe；新首版无需实现历史兼容参数。

## 面板行为

- 提供可选 URL、默认 9220 端口，展示服务实际地址。扫描防止重复点击，在 finally 恢复控件。
- 连接按钮使用真实条目的 targetId/url/title，ID 不变形。
- 连接中、已连接、重连中、失败、断开明确显示；仅最新有效显示请求可以更新界面。
- 分开显示扩展安装状态、relay 运行状态、扩展联通状态和页面连接状态。无安装证据显示未知。
- 页面回读、截图、观察失败分别定位；截图 IPC 不传 Base64。
- 关闭时解绑 DOM/window 监听、停止轮询、使待处理显示失效；重新打开不重复注册。
- 主进程代次控制实际连接，面板代次只控制显示，两者缺一不可。

首版只展示可用连接动作，不展示未实现的截图、原生、专用 Chrome、监控或一键策略安装按钮。

## 联调验收

- 面板连接 A，MCP status 与身份回读一致；MCP 切 B，面板最终更新为 B。
- 快速切换时迟到请求不覆盖新目标。
- 区分扫描超时、relay 不在线、relay 在线但扩展未连接、附着失败。
- 关闭重开后每个按钮和轮询只有一个有效执行来源，MCP 连接仍可用。
- 完整系统另测原生授权拒绝、观察窗口、本地 404 和截图元信息。

参考：[面板](https://boke.feishu.cn/extensions/cocos_mcp/panels/default/index.js)、[消息注册](https://boke.feishu.cn/extensions/cocos_mcp/package.json)、[主进程](https://boke.feishu.cn/extensions/cocos_mcp/src/main.ts)、[连接控制器](https://boke.feishu.cn/extensions/cocos_mcp/panels/default/browser-connection-controller.js)。
