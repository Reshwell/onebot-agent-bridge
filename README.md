# OneBot Agent Bridge

把 QQ 的 OneBot v11 收发能力封装成 CLI、JSON HTTP 接口和 stdio MCP 工具。面向需要自己决定如何处理消息的 AI Agent，适配 NapCat / SnowLuma 的标准 OneBot 接口。

本项目参考 [wechat-ilink-bridge](https://github.com/DONGH4O/wechat-ilink-bridge) 的 CLI + 本地状态 + MCP 设计，独立实现 QQ 传输层。微信版通过 iLink 长轮询收消息；QQ 版需要一个常驻进程接收 OneBot 事件，并把事件保存到 SQLite，再交给 Agent 拉取。

```text
QQ ↔ NapCat / SnowLuma ↔ OneBot v11 ↔ qbridge 常驻进程
                                        ↕ SQLite 消息队列
                                    CLI / HTTP / MCP
                                        ↕
                                你的 AI Agent 或应用
```

部署后可以收发 QQ 消息。自动生成回复需要另一个 Agent 或应用调用这些工具；此桥接器不内置模型或模型 API Key。MCP 工具提供调用能力，本身不会唤醒关闭的客户端，也不会把 QQ 消息自动注入当前聊天。持续自动回复需要一个持续运行的消费循环，见 [Agent 接入说明](docs/agent-integration.md)。

如果使用有独立 Computer 和定时任务的 Muse，见 [Muse 拉取与定时查询说明](docs/muse-quickstart.md)。真实连接凭证需单独提供，不包含在这个仓库里。

## 首版范围

| 能力 | 状态 |
| --- | --- |
| OneBot v11 正向通用 WebSocket | 已实现，断线自动重连 |
| OneBot v11 反向通用 WebSocket | 已实现，支持 Bearer / query token |
| HTTP API + HTTP POST 事件 | 已实现，支持 HMAC-SHA1 签名验证 |
| QQ 私聊 / 群聊收发文本 | 已实现 |
| CQ 字符串 / 数组格式入站消息 | 已实现 |
| @ / 引用回复 / 群聊只处理 @bot | 已实现 |
| 标准 OneBot 图片发送 | 已实现，本地图片转 base64 |
| 文件发送 | 扩展接口；要求后端支持和共享路径 |
| 入站图片、语音、视频、文件 | 首版仅返回类型和元数据，不下载 / 转写 |
| 本地消息历史、去重、处理确认 | 已实现，SQLite 持久化 |
| 发送 requestId 去重 | 已实现；无法确认的发送不会自动补发 |
| CLI / stdio MCP / JSON HTTP | 已实现 |
| Docker / Compose 配置 | 已提供 |
| 多 QQ 账号 | 每个账号单独运行一个桥接进程和状态目录 |
| QQ 扫码登录 | 由 NapCat / SnowLuma 完成 |

标准文本、图片不依赖 NapCat 专属接口。文件使用 `upload_private_file` / `upload_group_file`，不属于 OneBot v11 的标准 API，实际可用性由你部署的后端版本决定。

## 从源码运行

需要 Node.js 24+，使用内置 SQLite。

```bash
git clone https://github.com/Reshwell/onebot-agent-bridge.git
cd onebot-agent-bridge
npm ci
cp .env.example .env
mkdir -p shared
```

编辑 `.env`，至少设置这三项：

```dotenv
QBRIDGE_TOKEN=填入你自己的随机桥接密钥至少16字符
ONEBOT_WS_URL=ws://127.0.0.1:3001/
ONEBOT_ACCESS_TOKEN=填入NapCat或SnowLuma的OneBot密钥
```

`QBRIDGE_TOKEN` 用来保护本工具的 CLI / HTTP / MCP 接口；`ONEBOT_ACCESS_TOKEN` 是 QQ 协议端的密钥，两者用途不同。桥接器不会接受示例占位密钥。

然后启动常驻接收进程：

```bash
npm start
```

保持这个进程运行。在另一终端进入同一个目录：

```bash
node src/cli.js status
node src/cli.js fetch --wait 10000
node src/cli.js send --user 123456789 --text "收到" --request-id reply-001
node src/cli.js send --group 987654321 --text "群内回复" --request-id reply-002
node src/cli.js ack --ids 1,2
```

示例 QQ 号、群号和序号需要换成你自己的。`status.data.accountReady: true` 表示已经通过 `get_login_info` 校验当前 QQ 账号。没有连接成功时，检查 OneBot 服务是否开启、地址、端口和密钥是否一致。

可选安装本地全局命令：

```bash
npm install -g .
qbridge status
qbridge-mcp
```

这只是从本地源码安装；本项目尚未发布到 npm，不能直接使用 `npx onebot-agent-bridge` 从 registry 安装。

## NapCat / SnowLuma 配置

首选正向 WebSocket。后端打开一个**同时提供 API 和事件的通用 WebSocket 服务**，把地址和 token 填入 `.env`。标准 OneBot 路径通常是 `/`，仅 `/event` 的连接无法调用 API；仅 `/api` 的连接无法收新消息。如果使用事件专用 WS，则还须配置 `ONEBOT_HTTP_URL` 作为 API 出口。

SnowLuma 文档默认 OneBot WS 端口为 `3001`；NapCat 使用你在管理界面里配置的 WS 端口，不必设成相同的数字。

使用反向 WebSocket 时设置：

```dotenv
ONEBOT_MODE=reverse
ONEBOT_ACCESS_TOKEN=与QQ协议端一致的密钥
```

然后在 NapCat / SnowLuma 填通用反向 WS 地址：

```text
ws://桥接器地址:8787/onebot/v11/ws
```

首版只接受通用连接（`X-Client-Role: Universal`），不接受分开的 API / Event 双连接。反向连接由 OneBot 端负责重连。需要从另一台机器接入时，设置监听地址为 `QBRIDGE_HOST=0.0.0.0`，并让该机器能够访问配置的端口。

HTTP 方式设置：

```dotenv
ONEBOT_MODE=http
ONEBOT_HTTP_URL=http://QQ协议端地址:3000/
ONEBOT_ACCESS_TOKEN=QQ协议端密钥
ONEBOT_HTTP_SECRET=事件上报签名密钥
```

OneBot 事件上报地址设置为 `http://桥接器地址:8787/events`，使用相同签名 secret。若后端仅支持带 Bearer token 的 HTTP 事件，则留空 `ONEBOT_HTTP_SECRET`，用 `ONEBOT_ACCESS_TOKEN` 鉴权。HTTP API token 与 WS / 事件 token 不同时，通过 `ONEBOT_HTTP_ACCESS_TOKEN` 单独配置。

## Docker 部署

先编辑 `.env`，准备 `shared/`。如果 QQ 协议端运行在宿主机，Docker 内的 `127.0.0.1` 指向容器，应改成：

```dotenv
ONEBOT_WS_URL=ws://host.docker.internal:3001/
```

QQ 协议端须监听容器能访问的地址。Docker Desktop 通常支持 `host.docker.internal`；在 Linux 上只监听 `127.0.0.1` 的后端通常不能通过 host-gateway 访问，需要改为可访问的监听地址。

```bash
docker compose up -d --build
docker compose logs -f qbridge
docker compose exec qbridge node src/cli.js status
docker compose exec qbridge node src/cli.js fetch --wait 10000
```

Compose 把本地 `8787` 映射到容器并用命名卷保存 SQLite，重建容器保留消息。`QBRIDGE_URL` 默认 `http://127.0.0.1:8787`，适用于容器内 CLI 和宿主机客户端。

如果 NapCat / SnowLuma 也在 Docker 中，把它和 qbridge 加入同一个 Docker network，并设置 `ONEBOT_WS_URL=ws://napcat:端口/` 或 `ws://snowluma:3001/`。不同 Compose 项目之间需要显式共享 network；服务名不能自动跨 network 解析。

Compose 默认只把端口映射到宿主机回环地址。来自其他容器的反向 WS 可走共享 network 到 `qbridge:8787`；来自其他机器的反向 WS 需要按你的网络环境调整端口绑定。

## 接入 MCP

把 [examples/mcp-config.json](examples/mcp-config.json) 中的绝对路径和桥接器 token 改成你的值。MCP 进程只充当工具客户端，**常驻接收进程需要另行启动**。

```json
{
  "mcpServers": {
    "qq-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/onebot-agent-bridge/src/mcp.js"],
      "env": {
        "QBRIDGE_URL": "http://127.0.0.1:8787",
        "QBRIDGE_TOKEN": "与常驻进程一致的桥接密钥"
      }
    }
  }
}
```

具体导入方式由你的 MCP 客户端决定。这里只提供通用 stdio 配置，不保证每个 AI 产品都允许本地 stdio MCP 或后台自动轮询。

工具包括 `fetchMessages`、`ackMessages`、`sendText`、`sendImage`、`sendFile`、`listUsers`、`listGroups`、`listConversations`、`history`、`status`、`getDelivery`。

## 消息处理与防重复

`fetchMessages` / `qbridge fetch` 读取待处理消息，不自动消费。回复完成后调用 `ackMessages` / `qbridge ack`。只取走消息就自动确认，可能在 Agent 中断时遗漏未处理内容。

```json
{
  "ok": true,
  "data": {
    "messages": [
      {
        "seq": 1,
        "conversationId": "group:987654321",
        "messageId": "456",
        "userId": "123456789",
        "groupId": "987654321",
        "text": "你好",
        "pending": true
      }
    ],
    "ackIds": [1]
  }
}
```

群消息应回到 `conversationId` / `groupId`，而不是把发言者 `userId` 当成私聊目的地。每条回复使用稳定 `requestId`，例如 `reply-10001-1`：重试同一 ID 和内容不会发送第二遍。相同 ID 配不同内容会被拒绝。

如果返回 `SEND_UNCERTAIN`，表示断线、超时或响应异常导致无法确定消息是否已经发送。先在 QQ 检查，不要直接换一个 ID 重发。`getDelivery` 可查看本地记录，但不能证明远端最终是否收到。程序崩溃留下的 `sending` 记录同样需要人工核实。

同一消息队列默认面向一个消费循环；多个 Agent 同时读取会得到相同未确认消息，首版没有消费者租约。已确认及发送历史最多保留 `QBRIDGE_MAX_HISTORY` 条；未确认消息不会被这个上限清理。去重键和发送记录持续保留，需要为长期运行的状态目录预留磁盘空间。

OneBot v11 的事件没有可靠历史回放协议。桥接器离线期间的 QQ 消息、已经发出但未写入 SQLite 就断电的事件，不保证补齐。这个桥接器提供收到并落盘后的本地持久化，不承诺端到端恰好一次投递。

## 图片和文件

图片放进 `shared/` 后发送，协议端无需访问桥接器本地路径，因为桥接器会转成 base64：

```bash
node src/cli.js send --user 123456789 --image photo.png --request-id image-001
```

普通文件上传使用后端扩展接口，后端读取 `file` 对应的文件路径。需要把同一个文件夹挂到两个容器，并用 `ONEBOT_FILE_ROOT` 配置后端看到的目录。例如两边都挂到 `/shared`：

```bash
docker compose exec qbridge node src/cli.js send --group 987654321 --file report.pdf --request-id file-001
```

仅桥接器能访问该文件、而 QQ 协议端看不到对应路径时，文件上传无法成功。`sendImage` / `sendFile` 的 `filePath` 都是**桥接器服务端**的路径，不是远程 MCP 客户端的路径。

## HTTP JSON 接口

所有 Agent 操作统一为 `POST /rpc`，Bearer token 为 `QBRIDGE_TOKEN`：

```http
POST /rpc
Authorization: Bearer YOUR_BRIDGE_TOKEN
Content-Type: application/json

{"method":"fetchMessages","params":{"limit":20,"waitMs":10000}}
```

方法名与 MCP 工具一致。`GET /healthz` 仅检查进程能否应答，不等同于 QQ 账号在线；连接状态应查询 `status`。如通过跨机器网络使用 HTTP，请按你的部署环境配置 TLS 或私有网络。

## 验证

```bash
npm test
npm run check
npm run pack:dry-run
```

测试使用模拟 OneBot 服务，覆盖三种传输、重连、签名、持久化、路由、发送去重、媒体发送和官方 MCP 客户端 stdio 调用。已通过真实 SnowLuma 正向 WS 的私聊收发联调，见 [验证记录](docs/validation.md)。其他后端、群聊、媒体和具体部署环境仍需按 [真实环境验收清单](docs/live-checklist.md) 验证。

协议依据：[OneBot v11](https://github.com/botuniverse/onebot-11)、[NapCat 请求接口](https://doc.napneko.icu/develop/api)、[SnowLuma 接入指南](https://snowluma.github.io/zh/docs/guide/connect-bot)。
