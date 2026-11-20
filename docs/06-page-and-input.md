# 06 页面读取、截图与输入

首版仅使用最小页面身份回读；本篇其余能力后置。DOM 反映网页元素，不等于 Cocos Canvas 内游戏节点。

## 页面读取契约

| action | 参数 | 结果 |
| --- | --- | --- |
| status | 无 | URL、标题、viewport/DPR、文档状态、Canvas/WebGL/Cocos 可得状态 |
| screenshot | format 默认 png，可选 jpeg | 文件路径、尺寸、MCP 图片 |
| dom | selector 可选；maxDepth 默认 5，0–8 | 有界 DOM、节点数、truncated |
| find | text；limit 默认 20，最多 100 | 可见文本匹配 |
| inspect | selector | 元素属性、可见性、CSS 矩形 |

Chrome 用 `Runtime.evaluate` 按值返回，GameView 用 `executeJavaScript`。选择器和文本 JSON 序列化后插入固定脚本，限制深度、节点数、文本及返回体积。密码字段与敏感属性脱敏；不提供任意脚本执行的公开工具。

Canvas 同时记录物理分辨率和 CSS 尺寸；Cocos 场景、暂停、设计分辨率按引擎可得接口读取。readiness 可为 loading/blank/ready/unknown/unsupported 并附 reasons。WebGL 只被动读取已有设备，不能新建 context；信息不足返回 unknown 或 `webglKnown=false`，不据此判定页面无 WebGL。

截图 Chrome 使用 `Page.captureScreenshot`，GameView 使用区域 `capturePage`。路径以返回值为准；最初总览参考缓存 `%TEMP%/cocos-mcp/screenshots`、最近 20 张，具体实现策略需确认。MCP 返回 image content，面板 IPC 只返回落盘元信息。

## 输入契约

| action | 参数 | 行为 |
| --- | --- | --- |
| click | selector 或 x+y | 唯一可见元素中心或明确坐标，移入/按下/释放 |
| drag | 起终点；默认 300ms、12 步 | 有界插值；失败也处理释放 |
| type | selector/text；clear 默认 true | 聚焦并按需清空，Chrome Input.insertText |
| key | key | 按下和释放 |
| scroll | x/y/deltaX/deltaY；deltaX 默认 0 | 指定 viewport 点发滚轮；旧形式兼容 deltaY=y |
| wait | durationMs 0–60000 | 等待后继续校验目标 |
| batch | steps 1–50；stopOnError 默认 true | 顺序执行，逐步结果、完成数及失败原因 |

坐标统一为 CSS viewport 像素。设备像素截图需根据截图与视口尺寸映射，再验证点在视口内；不能只假定 DPR 等于映射比例。批量操作可复用采样视口，但必须防止排队期间切目标。Chrome 用 CDP Input，GameView 用 Electron 与页面适配逻辑。

```json
{
  "action": "batch",
  "steps": [
    {"action": "type", "selector": "#search", "text": "cocos"},
    {"action": "key", "key": "Enter"},
    {"action": "wait", "durationMs": 300}
  ],
  "stopOnError": true
}
```

成功封装不代表所有步骤成功，仍需检查 `data.steps/data.failed` 和页面实际变化。不提供刷新、导航或 localStorage 修改入口。

## 验收

使用含输入框、按钮、长列表和 Canvas 的测试页；覆盖空选择器结果、多可见结果、越界、大 DPR、加载中、首步失败后的两种 stopOnError 策略，以及排队期间换页不误发。

参考：[页面工具](https://boke.feishu.cn/extensions/cocos_mcp/src/application/modules/browser-page.ts)、[探针](https://boke.feishu.cn/extensions/cocos_mcp/src/infrastructure/creator/browser-page-status-script.ts)、[输入工具](https://boke.feishu.cn/extensions/cocos_mcp/src/application/modules/browser-interact.ts)、[被动观测测试](https://boke.feishu.cn/extensions/cocos_mcp/tests/infrastructure/browser-page-passive-observation.test.ts)。
