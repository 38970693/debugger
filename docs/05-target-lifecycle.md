# 05 目标选择、路由与断线恢复

## 公开参数

| action | 参数 | 完整系统行为 |
| --- | --- | --- |
| list | port 默认 9220 | 返回 ID、URL、标题和连接状态 |
| connect | targetId 必填；port 默认 9220；url/title 可选 | ID 优先，URL 与标题辅助找回重建目标 |
| adopt | port 默认 9220；url 可选 | 选择已有 HTTP/HTTPS 页签 |
| current | url 可选 | 独立原生授权与共存接管 |
| launch | url 可选 | 启动或复用专用 Chrome；首次 MCP 无 URL 用空白页 |
| status | 无 | 当前活动路由状态 |
| disconnect | 无 | 清理外部会话，完整系统回 GameView |

状态至少包含 `connected`、`transport`、`target.id/url`、`port`、`launched`；原生增加 `devToolsCompatible`，恢复可标 `reconnecting`。首版仅实现 list/connect/adopt/status/disconnect，断开后未连接。

## 选页规则

- 完整系统默认 GameView，合并 Chrome 与 Companion 目标按 ID 去重；首版只发现 Bridge。
- 普通接管仅接受 HTTP/HTTPS。URL 解析后去 hash、默认端口和尾部斜线，保留 query；`localhost` 与 `127.0.0.1` 仍是不同主机。
- `adopt(url)` 先按 URL 限定候选，再选择；不允许活动页优先级越过指定 URL。
- 候选唯一直接连接，多候选依次优先 active、本机 7456 预览、已连接页；仍不唯一报 `AMBIGUOUS_REFERENCE`。
- 同 URL 多页按 `targetId` 明确选择。`adopt` 不接收 title；需要标题辅助恢复时用 `list + connect`。
- `connect` 优先显式 ID；ID 重建时用已知 URL 与标题查找。只有旧 ID 且没有保存身份时不能凭空猜测目标。
- `current` 的精确 URL 匹配与授权是独立契约，见 [03](03-direct-transports.md)，不能直接复用上述规范化逻辑。

## 两类恢复

| 情形 | 处理 |
| --- | --- |
| 首次附着遇到可恢复失败 | 保存首次身份，每轮刷新目标及 ID→端口映射；参考退避 200/500/1000ms |
| 无候选且无可重试错误 | `NOT_FOUND`；歧义立即返回，不盲目重试 |
| 已连接后 socket 断开或读取超时 | 保留原目标身份，参考最多 8 次有界恢复；先旧 ID，再 URL+标题唯一匹配 |
| 主动断开、切换或卸载 | 推进连接代次，取消恢复；不自动接管其他页面 |
| 恢复成功 | 重建该页订阅；后续监控模块恢复之前明确请求的监听意图 |

完整系统首次恢复可扫描指定端口与默认 9220，并尝试同身份兼容通道；首版只允许已配置的 Bridge 路径，不增加 Companion 或原生回退。原生父授权丢失可能需要再次 `current`，不能静默切通道。

诊断字段包括 `relayAvailable`、`listErrors`、`originalError`、`lastErrors`、可用通道与目标数。路由推断出的 relay 可用性需和 HTTP 健康信息对照，不能当作安装检测结果。

## 竞态与取消

连接提交、切换和断开协调处理。发起新意图时推进连接代次，使旧请求失效；发现、附着、恢复的异步结果提交前均校验。过期结果负责关闭自己刚创建的 session/socket。

页面事件同时核对连接对象和 `sessionId`。面板另有显示请求代次，不能替代主进程连接代次。排队的页面操作绑定发起时目标，不得执行到后来选中的页。

典型回归：阻塞连接 A，发起 B 或断开，再释放 A；检查最终目标、资源关闭和监听来源。串行提交不能阻止更新的断开意图及时使 A 失效。

## 错误与验收

- `NOT_FOUND`：无对应页；`AMBIGUOUS_REFERENCE`：需要指定目标。
- `REVISION_CONFLICT`：操作期间目标改变；`TRANSPORT_ERROR`：恢复失败。
- `PROVIDER_UNAVAILABLE`：通道能力不可用；具体错误字段在实现时统一。
- 测试旧 ID 重建、重复身份不误连、人工取消不复活、旧事件不混入新目标。
- 完整系统断开后 connected 可能因 GameView 为真，必须同时查看 transport；首版不会出现该回退。

参考：[连接业务](https://boke.feishu.cn/extensions/cocos_mcp/src/application/browser-connection.ts)、[页面路由](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-cdp-router.ts)、[恢复测试](https://boke.feishu.cn/extensions/cocos_mcp/tests/application/browser-connection-recovery.test.ts)、[Chrome 恢复](https://boke.feishu.cn/extensions/cocos_mcp/tests/infrastructure/browser-monitor-recovery.test.ts)。
