# 02 MCP 服务与工具契约

## HTTP 与会话

1. 监听地址限定 `127.0.0.1`，参考端口从 `8765` 顺延至 `8785`；公布实际端口，全部占用时明确失败。
2. `GET /health` 公开经过清理的健康信息；`/mcp` 校验 Host、Origin 和 Bearer token，再交给 SDK 的 `StreamableHTTPServerTransport`。
3. 初始化请求建立对应的 MCP server 与 transport，记录真实会话 ID、活动请求、最近访问时间；后续请求复用会话。
4. 显式终止、空闲回收或服务关闭时释放 transport。活动请求如何影响回收、阈值与关闭等待上限需要配置并验证。
5. 结束一个 MCP 会话不会隐式销毁扩展实例共享的浏览器目标。

MCP 的 Bearer token 不保护外部 relay。relay 网络边界见 [04](04-browser-bridge.md)。

## 注册与权限

- 每个 MCP 会话建立独立访问控制上下文，默认 profile 为 `core`。
- 使用真实 Zod schema 生成输入结构；执行阶段再次验证参数和权限。
- 核心工具包含 `system` 的 `health` 动作与 `manage_tools`。
- `manage_tools` 支持 `list_groups`，以及 `activate` 时传 `profile:"runtime"` 或 `groups:["runtime"]`。profile 和 group 不可混为一谈。
- 以实际 `tools/list` 为准，并在执行时再次拒绝越权调用。客户端激活工具不能提升服务端授予的权限上限。
- MCP annotations 是提示信息，不能替代权限执行规则。只读能力按真实风险策略判断。
- 判别联合 Schema 必须保留动作字段、参数类型及分支约束；避免 SDK 处理后退化成空对象。

## 完整工具目录

下表为参考系统全集，均在 `runtime` 组，不代表首版全部实现。

| 工具 | 动作 | 风险 |
| --- | --- | --- |
| `browser_connect` | list / connect / adopt / current / launch / status / disconnect | process |
| `browser_page` | status / screenshot / dom / find / inspect | read |
| `browser_interact` | click / drag / type / key / scroll / wait / batch | execute |
| `browser_monitor` | start / status / snapshot / clear / stop | process |
| `browser_investigate` | observe / reproduce | execute |
| `browser_performance` | start / sample / stop / status / mark / analyze | process |

首版连接工具整体按 `process` 控制；不能仅因 `list/status` 看起来只读便绕过策略。首版额外实现 `browser_page status` 的最小子集用于验证目标身份，其他动作不注册。

## 结果与错误层级

业务使用统一 `McpResult`。客户端同时检查 MCP `isError` 和结构化 `ok`，两者需一致。截图作为 MCP image content，结构化数据保留路径、尺寸和来源，不重复携带 Base64。

分别验证 HTTP 鉴权错误、MCP 协议错误、输入参数校验错误、工具权限拒绝和浏览器业务失败。不能要求 HTTP 鉴权失败也返回工具级 `McpResult`。

`McpResult` 的精确字段、profile 矩阵和错误映射尚待参考源码或实施契约确认。

## 客户端配置与会话复用

```toml
[mcp_servers.cocos-mcp]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "COCOS_MCP_AUTH_TOKEN"
```

端口按面板替换，令牌通过 Codex 进程环境变量提供，不写入日志或报告。以下脚本属于参考仓库：

```powershell
$env:COCOS_MCP_URL = 'http://127.0.0.1:8765/mcp'
@'
{"name":"system","arguments":{"action":"health"}}
{"name":"manage_tools","arguments":{"action":"list_groups"}}
{"name":"browser_connect","arguments":{"action":"status"}}
'@ | node scripts/mcp-session.cjs --profile runtime
```

## 验收

- 两条真实 HTTP 会话，仅更改其中一条 profile，比较双方工具列表和执行权限。
- 面板选页后，两条有权限的会话读到同一目标；关闭其中一条不影响另一条。
- 覆盖无效凭据、Host/Origin、参数缺失、会话终止及服务清理。
- 空闲回收不能关闭尚有活动请求的会话；最终规则在实现时固定。

参考：[HTTP 宿主](https://boke.feishu.cn/extensions/cocos_mcp/src/access/http/http-host.ts)、[HTTP 校验](https://boke.feishu.cn/extensions/cocos_mcp/src/access/http/security.ts)、[MCP 注册](https://boke.feishu.cn/extensions/cocos_mcp/src/access/mcp/runtime.ts)、[权限](https://boke.feishu.cn/extensions/cocos_mcp/src/domain/capability/profile-policy.ts)、[配置](https://boke.feishu.cn/extensions/cocos_mcp/src/bootstrap/config.ts)、[会话测试](https://boke.feishu.cn/extensions/cocos_mcp/tests/e2e/mcp-session.test.ts)。
