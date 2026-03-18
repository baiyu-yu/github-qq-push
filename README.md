# GitHub QQ 推送服务

这是一个轻量且优雅的 Node.js 服务，旨在将 GitHub Webhooks 与 NapCat / OneBot (v11) 无缝连接。它能将实时的 GitHub 仓库事件安全地推送至您的 QQ 群或私聊，并自动生成深色模式的精美图片卡片。

**代码来源: Vibe Coding** (由 AI 智能代理自主构建)。

## 核心特性

- **精美图片渲染**: 使用 Puppeteer 将 GitHub 事件（提交、Issue、PR、发布、星标等）渲染为精致的图片卡片。
- **Web 控制面板**: 内置响应式 Web UI（默认端口 `7890`），支持在线配置 OneBot 连接、管理 GitHub Token、查看实时日志以及可视化管理订阅关系。
- **无需手动编辑配置**: 所有的推送目标和配置更改均可通过网页端动态完成，支持热重连。
- **智能重连机制**: 采用指数退避算法进行 WebSocket 重连，并严格限制 5 次尝试，防止异常情况下的资源浪费。
- **自动解析链接**: 在群聊中自动识别 GitHub 仓库链接并回复仓库概要卡片。
- **丰富的指令支持**: 提供 `/status`、`/help`、`/readme` 以及管理员专用的 `/github` 系列指令。

## 环境要求

- [Node.js](https://nodejs.org/) v18+
- 运行中的 [NapCat](https://github.com/NapNeko/NapCatQQ) 或其他兼容 OneBot v11 的客户端，并开启正向 WebSocket。
- 一个公网 IP 或内网穿透地址（如 Nginx、ngrok，默认端口 `7890`）用于接收 GitHub Webhook。

## 安装与部署

1. **克隆代码**:
   ```bash
   git clone <你的代码库地址>
   cd github-qq-push
   ```

2. **安装依赖**:
   ```bash
   npm install
   ```

3. **启动服务**:
   ```bash
   npm start
   ```

4. **通过网页配置**:
   在浏览器访问 `http://localhost:7890`。在“全局配置”选项卡中输入您的 GitHub 个人访问令牌 (PAT) 和 NapCat 的 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。

## 可用指令

在 QQ 群内，机器人支持以下指令：

- `/help` 或 `/github help`: 显示帮助菜单。
- `/status` 或 `/github status`: 显示运行状态、连通情况及订阅统计。
- `/github sub owner/repo [事件]`: 订阅指定仓库。事件可选，默认为全量订阅（仅限管理员）。
- `/github unsub owner/repo`: 取消订阅（仅限管理员）。
- `/github list`: 查看当前群组的所有订阅规则。
- `/github on` | `/github off`: 开启或关闭本群的推送功能（仅限管理员）。
- `/readme owner/repo`: 获取仓库的 README 并以长图形式发送。

直接粘贴如 `https://github.com/owner/repo` 的链接，机器人会自动回复 Star 等信息的概览卡片。

## Webhook 配置

在 GitHub 仓库设置中，将 Payload URL 指向：
`http://你的服务器IP:7890/webhook`

请确保 Content-Type 设置为 `application/json`，如果配置了 Secret，请确保与 Web UI 中的设置一致。

---

> 由 Antigravity 通过 Vibe Coding 流程构建。
