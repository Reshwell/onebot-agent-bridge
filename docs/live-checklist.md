# 真实 QQ 环境验收

本项目的自动测试用模拟服务验证协议，没有使用真实账号。部署后逐项验证：

1. NapCat / SnowLuma 已登录 QQ，并已开启 OneBot 服务。
2. `qbridge status` 返回正确 `account.userId` 和 `accountReady: true`。
3. 从另一个账号给机器人发一条私聊，`fetch` 返回正确用户、文本和 `conversationId`。
4. 用相同 conversationId 发出回复，QQ 收到一次；用相同 requestId 重试不重复发送。
5. `ack` 对应 seq 后，该消息不再出现在待处理队列，但可从 `history` 查看。
6. 群聊测试中，回复回到原群；@ 和引用格式由真实客户端验证。
7. 重启桥接器，未确认消息仍在；手动断开 OneBot 后恢复，正向连接能自动恢复。
8. 开启 `QBRIDGE_GROUP_MENTION_ONLY=true`，确认普通群消息只入历史、`fetch` 无新任务；随后 @bot，确认返回该条任务及此前同群 `context`，其他群和后续消息不混入。测试上下文条数和用户 / 群白名单符合需求。
9. 用一张小 PNG / JPEG 测试 `sendImage`，确认协议端接受 base64 图片。
10. 如需要普通文件，确认后端存在 upload_private_file / upload_group_file，并能读取共享目录中的文件。
11. MCP 客户端发现工具并完成 fetch → sendText → ack；持续消费由你的 Agent 服务驱动。
12. 给机器人发一张小图片（私聊及群聊背景各测一次），用 `imageRef` 调用 `getImage`，确认 MCP 客户端收到原生图片；CLI `image --output` 保存后能被 Computer 看图工具打开。看图本身不应确认消息，也不应另行触发背景消息的回复。
13. 在 Muse 中验证有视觉能力的实际客户端能描述测试图片；普通群聊不通知，@ 消息能结合此前背景回答。模拟服务测试不代替客户端能力验收。

若某项失败，先看 `status.lastError` / `status.lastIngressError` 和命令返回的结构化错误。桥接器不会返回协议端原始错误文本，以避免把可能包含密钥或媒体 URL 的内容暴露给 Agent。

当前未覆盖入站语音/视频/文件下载、语音转写、合并转发展开、群管理、好友请求处理、分离反向 API/Event 连接和多消费者租约。
