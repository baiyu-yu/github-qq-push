# 优化说明

## 已完成的优化

### 1. Docker 镜像大小优化（从 1.3GB 优化）

#### 优化措施：
- **精简系统依赖**：移除了不必要的系统包，只保留 Puppeteer 运行所需的最小依赖
- **优化 Chromium 安装**：
  - 使用 `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` 跳过 npm 安装时的自动下载
  - 使用 `npx puppeteer browsers install chrome` 只安装必需的 Chrome 浏览器
  - 设置 `PUPPETEER_EXECUTABLE_PATH` 环境变量指定浏览器路径
- **添加 emoji 字体支持**：安装 `fonts-noto-color-emoji` 确保 emoji 正确渲染
- **改进 .dockerignore**：排除更多不必要的文件（测试图片、文档等）

#### 预期效果：
镜像大小应该从 1.3GB 减少到约 600-800MB

### 2. Linux 系统图标渲染问题修复

#### 问题原因：
模板中使用了 emoji 字符（⭐🍴），在某些 Linux 系统中可能缺少 emoji 字体支持

#### 解决方案：
- 将所有 emoji 图标替换为 SVG 图标（使用 GitHub Octicons）
- 修改的模板：
  - `src/renderer/templates/star.html` - 星标图标
  - `src/renderer/templates/fork.html` - Fork 图标
- 更新 CSS 样式以适配 SVG 图标
- 在 Dockerfile 中添加 `fonts-noto-color-emoji` 作为备用方案

### 3. 缓存机制完善

#### 问题原因：
`pollRepo` 方法在首次轮询时没有正确设置 baseline，导致可能推送历史事件

#### 解决方案：
- 在 `pollRepo` 方法中添加明确的初始化逻辑
- 当 `lastId` 不存在时，只设置 baseline 而不处理事件
- 确保 `initializeBaseline` 方法在启动时正确执行
- 改进日志输出，明确区分初始化和正常轮询

#### 修改的文件：
- `src/github/poller.ts` - 改进了 `pollRepo` 方法的逻辑

## 构建和部署

### 重新构建镜像：
```bash
docker-compose build
```

### 启动服务：
```bash
docker-compose up -d
```

### 检查镜像大小：
```bash
docker images | grep github-qq-push
```

## 验证

### 1. 验证图标渲染：
- 触发 star 或 fork 事件
- 检查生成的图片中图标是否正确显示

### 2. 验证缓存机制：
- 清空 `data/state.json` 中的 `lastEventIds`
- 重启服务
- 观察日志，应该看到 "initializing baseline" 消息
- 不应该收到历史事件的推送

### 3. 验证镜像大小：
- 检查新镜像大小是否显著减小
- 确保服务正常运行

## 注意事项

1. 首次部署后，服务会为每个仓库设置 baseline，不会推送历史事件
2. SVG 图标在所有系统上都能正确渲染，无需依赖 emoji 字体
3. 如果需要进一步减小镜像大小，可以考虑使用 Alpine Linux 基础镜像
