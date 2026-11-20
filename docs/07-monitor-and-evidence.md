# 07 浏览器监控与诊断证据

本篇能力后置；首版连接不得隐式启用监控。

## 采集与归一化

| 源 | 输出与处理 |
| --- | --- |
| Runtime.consoleAPICalled | console：级别、有界参数、首帧和栈 |
| Runtime.exceptionThrown | exception / promise-rejection |
| Log.entryAdded | 警告、错误归为 console；网络按独立分支处理 |
| Network.requestWillBeSent / loadingFinished | 请求 ID、URL、方法、起始时间；完成释放关联 |
| Network.responseReceived / loadingFailed | HTTP 4xx/5xx、请求失败；同请求去重 |
| 既有缓存与 Cocos 遮罩 | existingErrors，明确采集来源 |

实时事件分配递增 cursor，附 executionTarget、transport、collectionSource、observedAt。堆栈行列转换为面向用户的一基索引。参考实时缓冲最多 1000 条，既有错误单独保存；限制堆栈及参数，URL query 与常见凭据脱敏。最初总览参考 message≤4000、stack≤12000、未完成请求≤1000。

附着与启动采集独立。启动启用采集域，部分失败回滚本次订阅；停止关闭采集而保留页面连接。事件按连接身份和 sessionId 隔离。

## 游标工作流

1. start，确认目标及 active。
2. snapshot，afterCursor 默认 0、limit 默认 100，最多 200。
3. 保存返回的 nextCursor，下一次作为 afterCursor。
4. 请求游标早于 droppedBeforeCursor 时报告淘汰及缺失范围。
5. stop 停采集；status 读状态；clear 清数据。目标变化后重新确定游标起点。

兼容路径可能在未连接时扫描 9222。指定页面的流程应先显式连接，不应依赖该路径。

## 单次调查

固定目标 ID、通道和连接代次，读取前状态及可选 DOM，记录开始游标和原监听状态。observe 默认等 10 秒；reproduce 执行 1–50 步已知输入，首个失败即停止。再读后状态、窗口内事件、既有错误及可选截图。

换目标时拒绝混用证据；部分失败保留 warnings、覆盖范围、时间和目标。本轮临时启用的监控在结束时恢复；原本已启用的监控继续可用。

```json
{"name":"browser_investigate","arguments":{"action":"observe","durationMs":3000,"detail":"summary","includeScreenshot":false}}
```

full 返回完整采集；summary 限制结构化体积，完整记录存 EvidenceStore。客户端经 completeEvidence 获取 evidenceId/scopeId，再用 evidence_read 的 manifest/page/chunk 读取。chunk 偏移按 Unicode 码点。过期或 scope 不匹配时拒绝读取，需重新采集。最初总览参考摘要上限 32 KiB。

候选原因分数用于规则排序，不代表经统计校准的概率或已确认根因。

## 验收与差异

- 制造日志、异常、Promise 拒绝、本地 404，核对分类、归属、栈与请求状态。
- 覆盖游标分页、淘汰、既有错误来源、清空重连、摘要完整回读、过期与作用域。
- 观察结束不能误停调用前已有监控。
- 总览对默认 5 分钟闲置自动停止和显式监听常驻的描述不一致；后续实施需明确消费者级 idle 策略，不能直接采用冲突默认值。

参考：[监控模块](https://boke.feishu.cn/extensions/cocos_mcp/src/application/modules/browser-monitor.ts)、[调查模块](https://boke.feishu.cn/extensions/cocos_mcp/src/application/modules/browser-investigate.ts)、[证据存储](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/diagnostics/evidence-store.ts)、[证据回读](https://boke.feishu.cn/extensions/cocos_mcp/src/application/modules/evidence-read.ts)。
