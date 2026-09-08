# GitHub QQ 推送服务

这是一个轻量且优雅的 Node.js 服务，旨在将 GitHub 与 QQ 机器人生态（支持 **QQ 官方机器人 (API v2)**、**OneBot v11** 与 **[Milky](https://milky.ntqqrev.org/) v1.3+**）无缝连接。它能将实时的 GitHub 仓库事件安全地推送至您的 QQ 群或私聊，并自动生成深色模式的精美图片卡片。

> [!TIP]
> **✨ 核心优势：配置超简单，只需要填一个 GitHub Token！**  
> - **无需公网 IP / 内网穿透**：内网电脑、家用 NAS、软路由均可直接部署；
> - **无需逐个配置 Webhook**：完全不必到每个 GitHub 仓库后台挨个设置回调地址与密钥；
> - **开箱即用**：只要在 Web 界面填入一个 GitHub Token，机器人即可借助内置的智能轮询引擎自动监听所有订阅仓库的最新事件，在群里直接发指令（如 `/github sub owner/repo`）即可完成推送订阅！

**代码来源: Vibe Coding** (由 AI 智能代理自主构建)。

## 核心特性

- **极简配置（只需填 GitHub Token）**: 零门槛开箱即用！无需独立公网 IP，无需配置域名与 SSL 证书。只要填入一个普通的 GitHub Personal Access Token（支持多 Token 轮询负载均衡），即可全自动轮询监听、精准去重并实时推送到群。
- **多协议适配 (QQ 官方机器人 / OneBot v11 / Milky)**: 原生支持 QQ 官方开放平台机器人（WebSocket 网关长连接与 Webhook 双模式）、经典 OneBot v11 (正向 WebSocket，如 NapCat、LLOneBot、Lagrange) 以及新一代 [Milky 协议](https://milky.ntqqrev.org/) (HTTP API + WebSocket，如 Milky.Net、Acidify)，支持在 Web 控制面板中自由切换与热重载。
- **精美图片渲染**: 使用 Puppeteer 将 GitHub 事件（提交、Issue、PR、代码审查、版本发布、Star、Fork、评论等）渲染为精致的深色模式图片卡片。
- **Web 控制面板**: 内置响应式 Web UI（默认端口 `7890`），支持在线配置机器人协议及连接、多 GitHub Token 轮询池、查看实时日志以及可视化管理订阅关系。
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
- `/status` 或 `/github status`: 查看服务运行时间 (Uptime)、机器人连接状态（OneBot / Milky / QQBot 协议与在线详情）、GitHub Token 配置情况及订阅统计。
- `/id` 或 `/myid`: 查看当前群聊 ID（或群 OpenID）与个人 ID（或用户 OpenID），方便在 WebUI 或配置文件中快速获取订阅目标 ID。
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

## 机器人协议接入指引

本项目支持 **OneBot v11** 与 **Milky (v1.3+)** 两种通信协议，可在 Web 控制面板中一键热切换，无需重启服务：

### 1. OneBot v11 协议
- **适用框架**: NapCat、LLOneBot、Lagrange、Trss-Yunzai 等兼容 OneBot v11 的客户端。
- **连接方式**: 正向 WebSocket 连接。
- **配置参数**:
  - `ws_url`: 机器人正向 WebSocket 服务地址（如 `ws://127.0.0.1:3001`）。
  - `access_token`: 鉴权 Token（若机器人端未配置可留空）。

### 2. Milky 协议 (v1.3+)
- **适用框架**: [Milky.Net](https://github.com/ProjectMilky/Milky.Net)、Acidify 等遵循 [Milky 官方标准](https://milky.ntqqrev.org/) 的现代 QQ 机器人框架。
- **连接方式**: HTTP API 调用 + WebSocket (`/event`) 事件推送流。
- **配置参数**:
  - `endpoint`: Milky 服务的根地址（如 `http://127.0.0.1:3000`）。服务将自动派生 HTTP API 请求路径与 `/event` WebSocket 事件监听。
  - `access_token`: 访问令牌（将以 `Authorization: Bearer <token>` 及 WebSocket 查询参数自动注入鉴权）。
- **图片传输**: 深度集成 Milky 的 `uri: "base64://..."` 规范，Puppeteer 渲染后的图片无需外部图床即可直推群聊与私聊。

### 3. QQ 机器人官方开放平台 (API v2)
- **官方文档**: [QQ 机器人文档 - 启动接入](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html) / [群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
- **连接方式**: 同时支持 **WebSocket (网关长连接)** 与 **Webhook (HTTP 回调推送)** 双模式：
  - **WebSocket 网关长连接**: 无需公网 IP 或独立域名，客户端自动通过 `/gateway` 获取 WSS 地址并建立长连接，完成 Hello 握手、Identify 鉴权与心跳保活，适合家庭或内网部署。
  - **Webhook HTTP 回调推送**: 腾讯开放平台主动 POST 回调推送事件，支持高并发。内置原生的 **Ed25519 签名算法**，在开放平台管理端配置并提交保存回调地址时，可自动完成 `OpCode 13` 回调地址安全校验，且无需任何第三方加密库依赖。
- **凭证管理**: 根据 `AppID` + `AppSecret` 自动请求并定时刷新 `access_token`（7200 秒自动续期）。
- **消息收发机制（主动消息 vs 被动消息）**:
  - **被动消息（指令触发与交互）**: 当收到用户发送的指令（如 `/status`、`/help`、`/readme`、`#123`）或触发链接卡片解析时，系统会自动提取触发消息的 `msg_id` 并维护自增序号 `msg_seq`（防止平台报 40054005 重复丢弃），以**被动消息**格式回复。富媒体图片采用合规的二段式上传（`/files` 获取 `file_info` 后通过 `/messages` 挂载），**完全不消耗机器人的每日主动消息配额**，有效避开主动推送限额。
  - **主动消息（GitHub 事件通知）**: 由 GitHub Webhook 或 Poller 轮询检测到的仓库变动事件（Push、PR、Issue、Release、Star 等）作为**主动消息**下发，受腾讯开放平台的频控规则管理（如已认证机器人每个群每日上限 1000 条）。
- **全量消息模式 vs @模式**:
  - **群消息全量模式 (`GROUP_MESSAGE_CREATE`)**：在 QQ 开放平台管理端申请并开通「接收所有消息」权限后，群内成员无需 @ 机器人即可直接发送 `/status`、`#123` 或分享 GitHub 链接，机器人均能自动接收并回复。
  - **群 @ 机器人模式 (`GROUP_AT_MESSAGE_CREATE`)**：若未开通全量权限，机器人仍可在群内被 @ 时自动接收指令与事件。
- **环境隔离**: 支持在 Web 控制台一键切换「正式环境」与「沙箱测试群环境」。

---

## 配置文件说明 (`config.json`)

除了在 WebUI 可视化修改外，您也可以直接编辑项目根目录的 `config.json`：

| 配置项 | 类型 | 说明 | 默认值 / 示例 |
| :--- | :--- | :--- | :--- |
| `protocol` | string | 机器人通信协议，可选 `"onebot"`、`"milky"` 或 `"qqbot"` | `"onebot"` |
| **`onebot`** | object | OneBot v11 协议配置 | |
| `onebot.ws_url` | string | OneBot 正向 WebSocket 连接地址 | `"ws://127.0.0.1:3001"` |
| `onebot.access_token` | string | OneBot Access Token（无则留空） | `""` |
| `onebot.command_prefix` | string | 聊天指令前缀 | `"/"` |
| `onebot.masters` | string[] | 管理员 QQ 号列表（不受群权限限制） | `["123456789"]` |
| **`milky`** | object | Milky 协议配置 | |
| `milky.endpoint` | string | Milky 服务根地址（HTTP URL） | `"http://127.0.0.1:3000"` |
| `milky.access_token` | string | Milky Bearer 鉴权 Token（无则留空） | `""` |
| `milky.command_prefix` | string | 聊天指令前缀 | `"/"` |
| `milky.masters` | string[] | 管理员 QQ 号列表 | `["123456789"]` |
| **`qqbot`** | object | QQ 机器人官方开放平台 (API v2) 配置 | |
| `qqbot.mode` | string | 接入模式：`"ws"` (WebSocket 长连接) 或 `"webhook"` (HTTP 回调推送) | `"ws"` |
| `qqbot.app_id` | string | QQ 开放平台机器人 AppID | `"102030405"` |
| `qqbot.app_secret` | string | QQ 开放平台机器人 AppSecret | `""` |
| `qqbot.sandbox` | boolean | 是否连接沙箱环境 (https://sandbox.api.sgroup.qq.com) | `false` |
| `qqbot.webhook_path` | string | Webhook 回调接收路径 | `"/qqbot/webhook"` |
| `qqbot.command_prefix` | string | 聊天指令前缀 | `"/"` |
| `qqbot.masters` | string[] | 管理员用户 OpenID 列表 | `[]` |
| **`github`** | object | GitHub 交互与推送配置 | |
| `github.webhook_port` | number | Webhook 与 WebUI 监听端口 | `7890` |
| `github.webhook_secret` | string | GitHub Webhook Secret 签名校验密钥 | `""` |
| `github.access_token` | string | GitHub Token，支持英文逗号分隔多个 Token 实现轮询池负载均衡 | `""` |
| `github.polling_enabled` | boolean | 是否开启 GitHub API 自动轮询降级引擎 | `true` |
| `github.polling_interval`| number | 轮询周期（秒） | `60` |
| `github.link_card_group_mode` | string | 群内识别 GitHub 链接卡片策略：`"all"` (全部启用)、`"whitelist"` (仅白名单)、`"disabled"` (禁用) | `"all"` |
| `github.link_card_enabled_groups` | string[] | 当策略为白名单时生效的群号列表 | `[]` |
| **`webui`** | object | Web 控制面板鉴权 | |
| `webui.username` | string | WebUI 登录用户名 | `"admin"` |
| `webui.password` | string | WebUI 登录密码（生产环境强烈建议设置） | `""` |
| **`render`** | object | 渲染引擎参数 | |
| `render.theme` | string | 卡片主题，支持 `"dark"` | `"dark"` |
| `render.concurrency` | number | 浏览器并发渲染页面数 | `2` |
| `render.max_screenshot_height` | number | 长图最大截取像素高度 | `30000` |

---

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
- 机器人接入方式（三选一）：
  - **QQ 机器人开放平台 (API v2)**: 官方官方机器人，支持 WebSocket 网关长连接或 Webhook 回调推送。
  - **OneBot v11**: 如 NapCat、LLOneBot、Lagrange 等，开启正向 WebSocket 服务。
  - **Milky (v1.3+)**: 如 Milky.Net、Acidify 等，开启 HTTP API 与 `/event` WebSocket 事件推送服务。
- 网络环境要求：
  - **极简轮询模式（推荐）**：**完全无需公网 IP 或内网穿透**（家用电脑、NAS、内网服务器即可平稳运行，仅需填入 GitHub Token）；
  - **Webhook 模式（可选）**：如需使用 GitHub Webhook 主动推送，需要一个公网 IP 或内网穿透地址（默认端口 `7890`）。

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

3. **启动服务**:
   复制 `config.example.json` 为 `config.json`，运行：
   ```bash
   npm start
   ```

4. **Web 控制台极简配置（只需 1 步）**:
   在浏览器访问 `http://localhost:7890`：
   - 在“全局配置”中填入您的 **GitHub Personal Access Token**（以及配置您的机器人连接）；
   - 点击浮动保存按钮保存生效；
   - 接下来在 QQ 群内直接发送 `/github sub 你的仓库名`（如 `/github sub vuejs/core`），内置轮询器就会全自动开始监听并推送更新！

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
