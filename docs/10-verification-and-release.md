# 10 验收、构建与交付

本篇来自用户提供的实机、测试页与交付资料。没有完整第 10 篇开头；不补造缺失命令。文中历史成绩不是本项目成绩。

## 历史基线

参考资料记录 **240 通过、1 失败、2 跳过**。失败位于 `mcp-session.test.ts` 的完整工具目录比较，新出现 runtime_resources/runtime_resource_trace，后续只读断言未执行。因此不能宣称只读权限已验收，也不能仅更新工具目录快照便忽略权限复验。

专用 Chrome 实机冒烟单独启用为 **1 通过、1 跳过**；跳过不等于通过。使用独立用户目录启动并回收本次拥有的进程及测试目录，可按环境探测已有 9222 HTTP/HTTPS 页进行外置端口验证。

以下仅适用于有相应源码、依赖及用例的参考仓库：

```powershell
$env:COCOS_MCP_REAL_CHROME = '1'
try {
    node node_modules/vitest/vitest.mjs run --no-cache tests/infrastructure/browser-cdp-real.test.ts
} finally {
    Remove-Item Env:COCOS_MCP_REAL_CHROME -ErrorAction SilentlyContinue
}
```

## 回环测试页

在独立 PowerShell 窗口运行以下参考夹具，打开 `http://127.0.0.1:7457/`，结束后 Ctrl+C。它不是本项目已启动的服务。

```powershell
@'
const http = require('node:http');
const page = [
  '<!doctype html><meta charset="utf-8"><title>Cocos MCP Browser Fixture</title>',
  '<label>Search <input id="search"></label>',
  '<button id="count">Click</button><output id="result">0</output>',
  '<button id="warn">Warning</button><button id="throw">Throw</button>',
  '<button id="reject">Reject</button><button id="missing">Fetch 404</button>',
  '<canvas width="320" height="160" style="display:block;background:#ccd"></canvas>',
  '<div style="height:2000px">Scroll area</div>',
  '<script>',
  'let count = 0;',
  'document.querySelector("#count").onclick = () => {',
  '  document.querySelector("#result").textContent = String(++count);',
  '};',
  'document.querySelector("#warn").onclick = () => console.warn("fixture-warning");',
  'document.querySelector("#throw").onclick = () => { throw new Error("fixture-exception"); };',
  'document.querySelector("#reject").onclick = () => { Promise.reject(new Error("fixture-rejection")); };',
  'document.querySelector("#missing").onclick = () => { void fetch("/fixture-404"); };',
  '</script>',
].join('\n');
http.createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  if (request.url === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end('Fixture response');
}).listen(7457, '127.0.0.1');
'@ | node
```

HTML 夹具覆盖通用浏览器能力，不证明 Cocos 引擎数据正确；另需真实 Creator Browser Preview 验证场景与 Canvas。

## 完整系统实机矩阵

| 项目 | 通过标准 | 首版 |
| --- | --- | --- |
| MCP | 初始化、健康、实际端口、无效凭据拒绝 | 必测 |
| 权限 | 双会话工具及执行权限隔离，共享目标 | 必测 |
| Bridge | 两页选定目标，联通分层明确，断开保留页面 | 必测 |
| 竞态与恢复 | 旧请求不覆盖新目标、取消不复活、资源回收 | 必测 |
| 面板 | 双向同步、重复开关不叠加监听 | 必测 |
| GameView | 正确预览、截图、输入、监听 | 后续 |
| 原生共存 | 授权后 MCP 与 DevTools 同页 | 后续 |
| 专用 Chrome | 独立配置、实际端口、复用及所有权释放 | 后续 |
| 页面输入 | DOM、截图、拖拽、输入、滚动、批量失败 | 首版仅身份回读 |
| 监控证据 | 分类、游标、来源、完整记录回读 | 后续 |
| Trace | 完成确认、分析、DevTools 导入、失败不发布 | 后续 |

参考路由命令：

```powershell
node scripts/verify-browser-routing.cjs --only dedicated --report '../../reports/cocos-mcp-browser-acceptance/routing'
```

Bridge 用 `--only bridge`，按实际填写 bridge-url/bridge-port/bridge-target。参考脚本包含项目预览断言，不能对通用 HTML 测试页直接要求 Cocos 引擎证据。编译产物测试前先构建参考扩展。

## 构建与交付记录

参考项目使用 `npm.cmd run build`、`capabilities:check`、`release:metadata:check`、`release:verify`。新项目在开发时建立自己的构建及校验命令；现在这些命令尚不存在。

交付包需包含入口、面板、运行依赖与本期必要说明，不能依赖开发机全局 node_modules。独立 Creator 测试项目验证加载、菜单和 MCP。现成 Bridge 外部依赖需写明版本、安装和启动步骤；企业策略安装文件不属于首版必需产物。

记录模板：

| 项目 | 记录 |
| --- | --- |
| 环境 | OS、Creator、Chrome、插件、Bridge、relay 版本 |
| 通道 | 实际通道、绑定地址、端口、目标 ID、清理后的 URL |
| 验证 | 命令、通过/失败/跳过/未执行、失败原因 |
| 证据 | 清理后的结构化结果、报告及产物路径 |
| 所有权 | 谁启动服务/进程、退出后实际回收情况 |
| 未验证 | 缺少的版本、通道或实机条件 |

交付候选重新跑当前用例，不复用历史成绩。首版无需等待后续通道验收，但必须明确哪些通道没有实现。

参考：[历史基线](https://boke.feishu.cn/wiki/browser-connection-report.md)、[路由脚本](https://boke.feishu.cn/extensions/cocos_mcp/scripts/verify-browser-routing.cjs)、[测试夹具](https://boke.feishu.cn/extensions/cocos_mcp/scripts/browser-benchmark-fixture.cjs)、[发布包校验](https://boke.feishu.cn/extensions/cocos_mcp/scripts/release-package.cjs)。
