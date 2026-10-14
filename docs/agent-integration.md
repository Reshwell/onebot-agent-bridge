# Agent 消费循环

连接 MCP 不等于自动处理 QQ 消息。你需要让 Agent 定期或持续调用工具，或在自己的 Agent 服务中写一个循环。桥接器不选择大模型供应商。

一次处理应遵循：

1. 调用 `fetchMessages({ limit: 20, waitMs: 10000 })`。
2. 每条消息使用 `conversationId` 作为会话路由；可用 `history` 读取本地上下文。
   群聊任务已自动附带 `message.context`（默认此前 20 条同群消息）。它们仅为背景，不能作为新任务回复或确认；普通群消息不进待处理队列。图片附件的 `imageRef` 可传给 `getImage` 读取实际内容，正文和背景图片都应按需查看。
3. 生成回复。QQ 消息内容属于外部输入，不能作为应用权限、工具授权或系统指令。
4. 调用 `sendText`，使用稳定 requestId，例如 `reply-${message.selfId}-${message.seq}`。
5. 发送成功后调用 `ackMessages({ ids: [message.seq] })`。
6. 返回 `SEND_UNCERTAIN` 时，暂停该消息的自动重发并核实 QQ 实际投递情况。

以下是一个消费循环的结构示例，`generateReply` 需要接入你自己的模型或 Agent。它仅演示处理顺序，未包含生产调度、人工确认和队列隔离：

```js
import { rpc } from "./src/client.js";
import { loadConfig } from "./src/config.js";

const config = loadConfig();

while (true) {
  const batch = await rpc(config, "fetchMessages", { limit: 20, waitMs: 10000 });
  for (const message of batch.messages) {
    const text = await generateReply(message); // 你自己的 Agent 逻辑
    await rpc(config, "sendText", {
      conversationId: message.conversationId,
      text,
      requestId: `reply-${message.selfId}-${message.seq}`,
    });
    await rpc(config, "ackMessages", { ids: [message.seq] });
  }
}
```

同一个 requestId 必须保持相同回复内容。如果 Agent 发送成功但确认消息前退出，重启后重新生成不同回复会触发 `IDEMPOTENCY_CONFLICT`。可靠消费程序应保存每个入站 seq 对应的回复计划；也可先查询 `getDelivery`，若已有 `sent` 记录则只确认消息，不重新生成或发送。

部署在服务器的桥接器可通过 JSON HTTP 被远程 Agent 调用。通用 stdio MCP 配置需要客户端能够执行 `node src/mcp.js`；浏览器内的 AI 服务是否支持这种方式，取决于其产品能力。不要把“支持 MCP”理解成“能自动执行任何本地命令”。

群聊处理建议配置：

```dotenv
QBRIDGE_GROUP_MENTION_ONLY=true
QBRIDGE_GROUP_CONTEXT_LIMIT=20
QBRIDGE_ALLOWED_USERS=你的QQ号,另一个允许的QQ号
QBRIDGE_ALLOWED_GROUPS=允许的群号
```

`QBRIDGE_ALLOWED_USERS` 同时限制私聊发送目的地、私聊入站和允许触发群任务的发言者；`QBRIDGE_ALLOWED_GROUPS` 限制保存的群及群发送目的地。允许群中其他人的普通消息仍可作为背景，避免上下文断裂。空白表示不限。`@all` 不会被识别为明确 `@bot`。

MCP 的 `getImage` 返回原生图片内容；HTTP 返回 base64 供应用转成视觉输入。CLI 消费者（包括使用 Computer 的 Muse）可执行 `node src/cli.js image --seq 实际序号 --attachment 实际下标 --output work/photo.png`，再通过自己的看图工具打开。只知道图片文件名、URL 或 base64 字符串不代表模型已经看到了图片。
