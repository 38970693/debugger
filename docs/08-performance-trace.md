# 08 Chrome Performance Trace

本篇为后续能力。必须由使用者先选定 Chrome 目标；GameView 不支持，chrome-cdp/chrome-companion 还需底层实际支持 Tracing。

## 工具契约

| 动作 | 参数与行为 |
| --- | --- |
| start | filePath、includeScreenshots、预算可选；开始并返回 ID |
| sample | 同上及 durationMs，默认 1000；开始、等待、停止 |
| status | 活动状态、完成结果或失败摘要 |
| mark | name；performance.mark 与可用的 console.timeStamp |
| stop | 等待命令确认及 tracingComplete，返回文件信息 |
| analyze | traceId；markerWindowMs 默认 100 |

默认最大 60000ms、100000 事件、32 MiB，Schema 允许下调，默认包括截图。限制实际写出事件及文件体积，不代表可精确约束浏览器内部全部缓冲内存。

## 生命周期

1. 固定目标传输和可得 frame ID，分配 traceId，创建 writer，绑定事件，拒绝重复开始。
2. `Tracing.start` 使用 ReportEvents，收到 Chrome 启动确认才标活动。逐事件写文件，统计已收到、写入与丢弃数量。
3. 时长、字节、事件耗尽或参考缓冲压力≥95% 时进入统一停止路径并记录原因。
4. 发送 `Tracing.end` 前订阅 `Tracing.tracingComplete`；命令确认与完成事件都到达才算完成。重复 stop 共享同一 Promise。
5. 闭合 `traceEvents` JSON，计算尺寸与 SHA-256；分别记录 recordingDurationMs/finalizeDurationMs。
6. 断线、切换、I/O 失败或超时清理资源并报告失败。完成状态不明时提示重连原目标，不能发布为可分析产物。

ReportEvents 可能在停止后集中返回，writer 仍需执行预算。参考项目的报告路径 `reports/mcp-improvement/batch-04/traces` 是历史任务路径，不作为新项目默认目录。

## 登记、分析与人工核对

仅登记完成确认的 Trace，绑定项目、目标、ID、路径、大小、哈希。参考记录有效 30 分钟、最多 32 条。analyze 仅接受 traceId，验证项目、大小和哈希，在预算内解析，不能用任意路径绕过登记。

分析按 frame/renderer/thread 归因，提供长任务、事件候选成本、标记窗口和真实帧证据。包含子事件的成本不可简单累加。帧覆盖不足保留限制；不能从 rAF、截图数量或设定 FPS 推断真实帧率。

验收分别记录 JSON 可解析与 DevTools Performance 实际导入成功。标记、线程、任务和帧需人工对照同一测试操作。

## 验收

- 正常样本含已知标记，completionConfirmed=true，可读取及导入。
- 事件、字节、时长限额和目标中断均有准确截止原因。
- 未确认完成文件不能分析；重复停止返回同一结果。
- 篡改文件、未知 ID、过期及项目不符明确拒绝。
- Chrome 可录制，GameView 返回通道限制。

参考：[工具](https://boke.feishu.cn/extensions/cocos_mcp/src/application/modules/browser-performance.ts)、[状态机](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-performance-trace.ts)、[产物校验](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-trace-artifacts.ts)、[分析](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-trace-analysis.ts)。
