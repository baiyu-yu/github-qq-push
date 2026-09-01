# GitHub QQ 推送服务

这是一个轻量且优雅的 Node.js 服务，旨在将 GitHub Webhooks 与 OneBot (v11) 无缝连接。它能将实时的 GitHub 仓库事件安全地推送至您的 QQ 群或私聊，并自动生成深色模式的精美图片卡片。

**代码来源: Vibe Coding** (由 AI 智能代理自主构建)。

## 核心特性

- **精美图片渲染**: 使用 Puppeteer 将 GitHub 事件（提交、Issue、PR、代码审查、版本发布、Star、Fork、评论等）渲染为精致的深色模式图片卡片。
- **Web 控制面板**: 内置响应式 Web UI（默认端口 `7890`），支持在线配置 OneBot 连接、多 GitHub Token 轮询池、查看实时日志以及可视化管理订阅关系。
- **无需手动编辑配置**: 所有的推送目标和配置更改均可通过网页端动态完成，支持热重连。
- **Webhook + 轮询双引擎**: 支持 GitHub Webhook 主动推送与 API 自动轮询双模式，内置多重指纹去重（Deduplication），保证消息不漏不重。
- **自动解析各类链接**: 在聊天中自动识别 GitHub 仓库、Pull Request、Issue、Commit 链接并生成概要卡片。
- **单仓库快捷查询**: 当当前群聊仅绑定 1 个仓库时，直接发送 `#数字`（例如 `#123`）即可秒查该 Issue 或 PR 的详情卡片！
- **代码变更深入查看**: 引用回复 PR 卡片并发送 `/detail`，可直接以长图查看该 PR 的文件修改与彩色 diff 代码变动。
- **丰富的指令支持**: 提供 `/status`、`/help`、`/readme`、`/pr`、`/issue`、`/commit` 以及管理员专用的 `/github` 系列订阅管理指令。

## 可用指令与交互

在 QQ 群或私聊中，机器人支持以下指令与快捷交互：

### 基础与管理指令
- `/help` 或 `/github help`: 显示完整帮助菜单。
- `/status` 或 `/github status`: 查看服务运行时间 (Uptime)、OneBot 连接状态、GitHub Token 配置情况及订阅统计。
- `/github sub <owner/repo> [事件...]`: 为当前群/私聊订阅指定仓库。事件可选（如 `push`, `issues`, `pull_request`），默认为全量订阅（仅限群主/管理员/Master）。
- `/github unsub <owner/repo> [事件...]`: 取消订阅全部或指定事件（仅限群主/管理员/Master）。
- `/github list`: 查看当前群/私聊已订阅的所有仓库及事件列表。
- `/github on` | `/github off`: 开启或关闭本群的 GitHub 推送通知（仅限群主/管理员/Master）。

### 内容查询与详情指令
- `#[数字]`（例如 `#123` 或 `＃123`）：
  - **单仓库群专属快捷方式**：当当前群聊仅绑定 1 个仓库时，直接发送 `#数字` 即可获取该 Issue 或 PR 的完整详情卡片。
- `/readme [owner/repo | url]`:
  - 获取仓库的 `README.md` 并生成高清长图卡片。
  - 单仓库群聊中可直接发送 `/readme`，自动获取当前绑定仓库的 README。
  - 支持直接引用回复仓库卡片/链接后发送 `/readme`。
- `/pr <owner/repo number | url | number>`:
  - 获取指定 PR 的详细信息卡片。
  - 单仓库群聊中可直接发送 `/pr 123`。
  - 支持直接引用回复 PR 卡片/链接后发送 `/pr`。
- `/issue <owner/repo number | url | number>`:
  - 获取指定 Issue 的详细信息卡片。
  - 单仓库群聊中可直接发送 `/issue 123`。
  - 支持直接引用回复 Issue 卡片/链接后发送 `/issue`。
- `/commit <owner/repo sha | url>`:
  - 获取指定 Commit 的提交信息与文件变更卡片。
  - 支持直接引用回复 Commit 卡片/链接后发送 `/commit`。
- `/detail`:
  - 引用回复任一 PR 卡片后发送 `/detail`，可调取查看包含每个文件增删统计与彩色 diff 代码片段的变更长图。

### 自动链接识别与防刷屏
- 直接发送 GitHub 仓库链接（如 `https://github.com/owner/repo`）、PR 链接、Issue 链接或 Commit 链接，机器人会自动识别并回复相应的卡片。
- 为防止刷屏与消耗 GitHub API 额度，同一会话内自动链接卡片有 10 秒冷却时间，且可通过 WebUI 细粒度配置群聊模式（全部启用/仅白名单/全部禁用）。

## 支持的订阅事件类型

| 事件名称 | 说明 |
| :--- | :--- |
| `push` | 代码推送与提交记录 |
| `issues` | Issue 的创建、关闭、重新打开与编辑 |
| `pull_request` | PR 的创建、合并、关闭与编辑 |
| `pull_request_review` | PR 审查（Approve / Request Changes 等） |
| `pull_request_review_comment` | PR 代码行内评论与审查讨论 |
| `issue_comment` | Issue 与 PR 下方的讨论回复 |
| `commit_comment` | Commit 提交上的讨论评论 |
| `release` | 新版本/Release 发布通知 |
| `star` | 仓库获得新 Star |
| `fork` | 仓库被 Fork |
| `edited` | Issue / PR / 评论的编辑修改历史通知 |

## GitHub Webhook 配置

如需使用 Webhook 实时推送功能，请在您的 GitHub 仓库中进行配置：

1. 进入仓库页面，点击顶部导航栏的 **Settings**。
2. 在左侧菜单中点击 **Webhooks**，然后点击 **Add webhook** 按钮。
3. 填写参数：
   - **Payload URL**: 填写您的服务器地址和端口，格式为 `http://你的公网IP:7890/webhook`。
   - **Content type**: 务必选择 `application/json`。
   - **Secret**: 填写您在 `config.json` 或 WebUI 中配置的 `webhook_secret`。
   - **SSL verification**: 根据您的证书情况选择开启。
4. **选择事件**: 可选择 **Send me everything** 或自定义勾选事件。
5. 点击 **Add webhook** 保存即可。

## 环境要求

- [Node.js](https://nodejs.org/) v18+
- 运行中的兼容 OneBot v11 的客户端（如 NapCat、LLOneBot 等），并开启正向 WebSocket。
- 一个公网 IP 或内网穿透地址（默认 Webhook 端口 `7890`）。

## 安装与部署

### 源码部署

1. **克隆代码**:
   ```bash
   git clone <你的代码库地址>
   cd github-qq-push
   ```

2. **安装依赖与编译**:
   ```bash
   npm install
   npm run build
   ```

3. **准备配置**:
   复制 `config.example.json` 为 `config.json` 并填写基础配置。

4. **启动服务**:
   ```bash
   npm start
   ```

5. **Web 控制台配置**:
   在浏览器访问 `http://localhost:7890`。在“全局配置”中输入 GitHub Token、OneBot 连接地址等。

> [!IMPORTANT]
> **请务必在 WebUI 中设置管理密码**（全局配置 → WebUI 管理认证）。WebUI 使用 HTTP Basic Auth 进行权限拦截（默认用户名为 `admin`），防止公网环境下凭据泄露。

---

### Docker 部署 (推荐)

本项目已提供现成的 Docker 镜像与 `docker-compose.yml`，推荐优先使用 Docker Compose 部署。

#### 方法 A: 使用 Docker Compose (最简单)

1. **准备配置文件与目录**:
   创建并进入工作目录，准备好 `config.json`（可从 `config.example.json` 复制改名）与 `data` 目录：
   ```bash
   mkdir -p data
   # 准备 config.json 并根据需要修改配置
   ```

2. **创建或使用 `docker-compose.yml`**:
   项目内置的 `docker-compose.yml` 已配置官方发布的镜像 `baiyuyuyu/github-qq-push:latest` 与 Puppeteer 内存优化：
   ```yaml
   version: '3.8'

   services:
     github-qq-push:
       image: ${GITHUB_QQ_PUSH_IMAGE:-baiyuyuyu/github-qq-push:latest}
       container_name: github-qq-push
       restart: unless-stopped
       ports:
         - "7890:7890"
       volumes:
         # 将宿主机的配置文件挂载到容器内，保证配置持久化
         - ./config.json:/app/config.json
         # 持久化运行时状态（群推送开关、轮询基线）
         - ./data:/app/data
       environment:
         - NODE_ENV=production
       # 针对 Puppeteer 的共享内存优化
       shm_size: '2gb'
   ```

3. **一键启动**:
   ```bash
   docker compose up -d
   ```

4. **查看运行日志与状态**:
   ```bash
   docker compose logs -f
   ```

---

#### 方法 B: 直接使用 Docker CLI

1. **使用官方预构建镜像运行**:
   ```bash
   docker run -d \
     --name github-qq-push \
     --restart unless-stopped \
     -p 7890:7890 \
     --shm-size=2gb \
     -v $(pwd)/config.json:/app/config.json \
     -v $(pwd)/data:/app/data \
     baiyuyuyu/github-qq-push:latest
   ```

2. **或从源码本地构建镜像**:
   ```bash
   docker build -t github-qq-push .
   docker run -d \
     --name github-qq-push \
     --restart unless-stopped \
     -p 7890:7890 \
     --shm-size=2gb \
     -v $(pwd)/config.json:/app/config.json \
     -v $(pwd)/data:/app/data \
     github-qq-push
   ```

> [!NOTE]
> - `./data` 目录用于持久化运行时状态（群推送开关联动、轮询事件基线），请务必保持挂载。
> - `shm_size: '2gb'` 用于确保 Chromium 生成长图/高并发卡片时有足够的共享内存。

---

## 开发与测试

```bash
# 运行单元测试（包含模板渲染测试、事件路由测试、引用解析测试等）
npm test

# 本地开发监听
npm run dev
```

---

> 由 Antigravity 构建。
