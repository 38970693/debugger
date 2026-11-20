# 01 架构与实施顺序

## 完整系统目标

在 Creator 扩展内提供 MCP 服务，使客户端能够连接本机 GameView 或 Chrome，读取页面、发送输入、收集诊断证据并录制性能。面板与 MCP 使用同一连接业务。

| 使用场景 | 通道或能力 | 完成标准 |
| --- | --- | --- |
| Creator 内调试 | GameView | 目标、状态、截图、输入、事件均指向预览 |
| 接管已有页签 | Bridge 或原生共存 | 明确选页、可读状态，断开保留用户页面 |
| 独立浏览器 | 专用 Chrome 或显式 CDP | 返回真实端口和目标，按所有权回收 |
| 诊断 | 页面、输入、监控、调查 | 证据可归属目标、来源、窗口及覆盖范围 |
| 性能 | Chrome Trace | 限额内录制、停止、导入及分析 |
| 双入口 | 面板与 MCP | 共享活动目标，权限按 MCP 会话计算 |

## 依赖方向

```text
MCP 客户端 → HTTP / MCP SDK / 能力注册表 ┐
                                        ├→ 应用模块与连接业务
Creator 面板 → Editor.Message / 主进程 ┘           ↓
                                    BrowserCdpPort / BrowserMonitorPort
                                                   ↓
                                      GameView / Chrome / Companion
```

- 访问层处理会话、鉴权、Schema、结果；面板使用 Creator IPC。
- 应用层定义工具动作、目标选择、错误与采集顺序。
- 领域接口定义目标、状态、事件和产物，不引用 Electron 或具体 CDP 客户端。
- 适配器封装 Electron、Chrome CDP 和旧 Companion 细节。
- 装配层创建实例、注册工具，并在扩展卸载时统一处置。

完整系统中，Chrome 适配器同时提供页面与监控能力，GameView 和 Companion 分别提供页面、监控适配器。页面路由和监控路由切换必须协调，旧监听先停止。首版只需 Bridge 页面适配器与连接服务。

## 状态与所有权

| 对象 | 归属 | 结束条件 |
| --- | --- | --- |
| MCP HTTP 会话 | 单个客户端 | 显式终止、空闲回收、服务停止 |
| 活动目标 | Creator 扩展实例 | 切换、断开、卸载 |
| 页签调试会话 | 适配器 | 切换、断开、目标销毁、适配器销毁 |
| 监控订阅与缓冲 | 适配器及其目标 | 停止、切换；旧事件不得混入新目标 |
| 专用 Chrome | 启动它的适配器 | 适配器处置；单纯断开可保留供复用 |
| 用户 Chrome 和页签 | 用户 | 插件仅释放调试资源 |
| Trace 与文件句柄 | 录制器 | 完成、预算耗尽、切换或失败 |
| relay | 实际启动者 | 外部服务仅复用；插件拥有的服务才负责回收 |

会话 profile 是客户端状态，活动目标是扩展实例状态。多个客户端可见工具不同，但操作同一目标。跨调用工作流必须比较目标 ID、通道和连接代次。

## 完整系统参考实施顺序

1. HTTP、MCP 会话、健康检查及替身工具。
2. GameView 或专用 Chrome 跑通状态、截图和点击。
3. Bridge 跑通已有页面的发现、附着、读取和断开。
4. 监控、证据、诊断与 Trace。
5. 面板联调、各通道独立验收与交付。

当前项目为 Bridge 首版调整了顺序，以 [开发计划](development-plan.md) 为准。

参考入口：[功能概览](https://boke.feishu.cn/wiki/browser-connection-report.md)、[容器](https://boke.feishu.cn/extensions/cocos_mcp/src/bootstrap/container.ts)、[页面接口](https://boke.feishu.cn/extensions/cocos_mcp/src/domain/creator/browser-cdp-port.ts)、[监控接口](https://boke.feishu.cn/extensions/cocos_mcp/src/domain/creator/browser-monitor-port.ts)。
