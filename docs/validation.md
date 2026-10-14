# 验证记录

验证日期：2026-10-14。环境：macOS、Node.js 24.16.0、npm 11.13.0。

- 17 项自动化测试全部通过。
- `npm run check` 通过。
- `npm run pack:dry-run` 通过，包文件列表仅含源码、示例配置和文档，没有实际 token、状态库或 node_modules。
- 依赖安装审计报告 0 个已知漏洞（此结论仅代表安装时的 npm audit 数据）。
- `docker compose --env-file .env.example config --no-env-resolution --quiet` 通过，Compose 配置可解析。
- 已尝试 `docker build`；Docker Hub 官方 Node 镜像的匿名鉴权服务网络超时，未完成构建。本机没有缓存 Node 基础镜像，因此没有容器运行验收。

测试覆盖标准协议的模拟端，包括正向 WS、反向通用 WS、HTTP API、HMAC/Bearer 事件鉴权、断线重连、群/私聊路由、CQ 解析、持久化、显式确认、重复发送保护、发送不确定状态、图片 base64、文件共享路径、错误账号发送拦截、CLI 子进程，以及官方 MCP SDK 客户端的 stdio 握手及工具调用。

## SnowLuma 真实账号联调

2026-10-14，使用用户提供的正向通用 WebSocket 和 Bearer 鉴权连接真实 SnowLuma（`1.14.21-node`，OneBot v11）：

- `get_login_info`、`get_status`、`get_version_info` 成功，账号在线。
- 同一 WebSocket 连接支持 API 调用和事件推送。
- 启动本地桥接器，通过带鉴权的 HTTP `/rpc` 完成查询和发送；没有公开本地 HTTP 端口。
- 经用户明确授权，只向指定私聊对象发送联调消息；共发送两条：测试请求及收到回复后的确认。
- 对方回复“桥接测试收到”，桥接器通过 `fetchMessages` 查询到对应真实私聊消息，并通过 `sendText` 回发确认，接口返回消息 ID。
- 同一发送请求使用相同 `requestId` 重试，返回缓存的同一消息 ID，`deduplicated: true`，没有重复发送。
- 回复成功后 `ackMessages` 确认一条消息；重复确认返回零条，随后查询该消息不再处于待处理队列。
- 测试结束已关闭临时桥接器。真实账号状态库、凭证和消息原始记录不包含在源码交付包内。

此结果验证了 SnowLuma 的真实私聊收发和本地桥接 RPC，不代表已经常驻部署或配置 Muse 的定时任务。真实 NapCat、群聊、真实媒体消息和容器运行尚未验收；部署时仍应按 [验收清单](live-checklist.md) 验证。
