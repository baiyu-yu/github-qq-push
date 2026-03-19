import { OneBotClient } from "../onebot/client";
import { getRepo, getAvatarUrl, getOctokit } from "../github/api";
import { renderTemplate, markdownToHtml } from "../renderer";
import { setGroupToggle } from "../state";
import { addSubscription, removeSubscription, listSubscriptions } from "../config";
import { serviceStartTime } from "../utils";

// Match GitHub repo URLs: https://github.com/owner/repo
const repoUrlRegex = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/;
// Remove any trailing .git
function cleanRepoName(name: string) {
  return name.replace(/\.git$/, "");
}

export async function handleMessage(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  // Only handle group and private messages
  const messageType = payload.message_type; // 'group' or 'private'
  if (!["group", "private"].includes(messageType)) return;

  const text = payload.raw_message || "";
  const targetId = messageType === "group" ? payload.group_id : payload.user_id;

  // 0. Status & Help Commands
  if (text.trim() === "/status" || text.trim() === "/github status") {
    const uptime = Math.floor((Date.now() - serviceStartTime) / 1000);
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const subsCount = listSubscriptions({ type: "group", id: String(targetId) }).length;

    let uptimeStr = "";
    if (days > 0) uptimeStr += `${days}天`;
    if (hours > 0) uptimeStr += `${hours}小时`;
    if (mins > 0) uptimeStr += `${mins}分钟`;
    if (!uptimeStr) uptimeStr = "<1分钟";

    const replyLines = [
      "[GitHub QQ Push] 运行状态",
      `已运行: ${uptimeStr}`,
      `Node 服务: 正常`,
      `当前群组订阅: ${subsCount} 个`,
    ];
    
    if (messageType === "group") {
      await bot.sendGroupText(targetId, replyLines.join('\n'));
    } else {
      await bot.sendPrivateText(targetId, replyLines.join('\n'));
    }
    return;
  }

  if (text.trim() === "/help" || text.trim() === "/github help") {
    const helpMsg = `[GitHub QQ Push] 可用指令列表:
/status - 查看运行状态和本群订阅数
/help - 查看帮助菜单
/github on/off - 开启或关闭本群所有推送
/github sub <owner/repo> [可选特殊事件用逗号分隔] - 添加仓库订阅
/github unsub <owner/repo> - 取消仓库订阅
/github list - 列出本群所有订阅的仓库
/readme <owner/repo> - 以长图形式发送仓库的 README 说明
/pr <owner/repo> <number> - 长图显示 PR 合并/变更详情
直接发送含有 GitHub 仓库的主页链接，即可自动解析为卡片。`;
    if (messageType === "group") await bot.sendGroupText(targetId, helpMsg);
    else await bot.sendPrivateText(targetId, helpMsg);
    return;
  }


  // 1. Group Admin Toggles (only in groups)
  if (messageType === "group") {
    const senderRole = payload.sender?.role; // 'owner', 'admin', 'member'
    const isAdmin = senderRole === "owner" || senderRole === "admin";

    if (text.startsWith("/github off")) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群管理员可以关闭推送。");
        return;
      }
      setGroupToggle(String(targetId), true);
      await bot.sendGroupText(targetId, "本群 GitHub 推送已关闭。");
      return;
    }

    if (text.startsWith("/github on")) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群管理员可以开启推送。");
        return;
      }
      setGroupToggle(String(targetId), false);
      await bot.sendGroupText(targetId, "本群 GitHub 推送已重新开启。");
      return;
    }

    if (text.startsWith("/github sub ")) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群管理员可以添加订阅。");
        return;
      }
      const parts = text.split(" ").filter(Boolean);
      const targetRepo = parts[2]; // e.g., owner/repo
      const eventsStr = parts[3]; // optional, e.g., push,issues

      if (!targetRepo || !targetRepo.includes("/")) {
        await bot.sendGroupText(targetId, "格式错误。用法: /github sub owner/repo [可选:事件列表用逗号分隔]");
        return;
      }

      const events = eventsStr ? eventsStr.split(",") : ["push", "issues", "pull_request", "release", "star", "fork"];
      addSubscription(cleanRepoName(targetRepo), events, { type: "group", id: String(targetId) });
      await bot.sendGroupText(targetId, `成功订阅 ${targetRepo} 的 ${events.length} 种事件。`);
      return;
    }

    if (text.startsWith("/github unsub ")) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群管理员可以取消订阅。");
        return;
      }
      const parts = text.split(" ").filter(Boolean);
      const targetRepo = parts[2];
      if (!targetRepo) {
        await bot.sendGroupText(targetId, "格式错误。用法: /github unsub owner/repo");
        return;
      }
      const removed = removeSubscription(cleanRepoName(targetRepo), { type: "group", id: String(targetId) });
      if (removed) {
        await bot.sendGroupText(targetId, `成功取消订阅 ${targetRepo}。`);
      } else {
        await bot.sendGroupText(targetId, `本群未订阅 ${targetRepo}。`);
      }
      return;
    }

    if (text === "/github list") {
      const subs = listSubscriptions({ type: "group", id: String(targetId) });
      if (subs.length === 0) {
        await bot.sendGroupText(targetId, "本群目前没有订阅任何 GitHub 仓库。");
        return;
      }
      const listText = subs.map(s => `- ${s.repo} (${s.events.join(", ")})`).join("\n");
      await bot.sendGroupText(targetId, `本群已订阅的仓库:\n${listText}`);
      return;
    }
  }

  // 2. /readme command
  if (text.startsWith("/readme")) {
    const parts = text.split(" ").filter(Boolean);
    let owner = "";
    let repo = "";
    if (parts.length > 1) {
      const target = parts[1];
      if (target.includes("/")) {
        [owner, repo] = target.split("/");
      } else {
        const urlMatch = target.match(repoUrlRegex);
        if (urlMatch) {
          owner = urlMatch[1];
          repo = cleanRepoName(urlMatch[2]);
        }
      }
    }

    if (owner && repo) {
      repo = cleanRepoName(repo);
      await handleReadmeCommand(owner, repo, targetId, messageType, bot);
      return;
    } else {
      const msg = "格式不正确。请使用 `/readme owner/repo` 或 `/readme https://github.com/owner/repo`。";
      if (messageType === "group") await bot.sendGroupText(targetId, msg);
      else await bot.sendPrivateText(targetId, msg);
      return;
    }
  }

  // 3. /pr command
  if (text.startsWith("/pr ")) {
    const parts = text.split(" ").filter(Boolean);
    let target = parts[1]; // owner/repo
    let prNumStr = parts[2];
    let owner = "";
    let repo = "";
    if (target && target.includes("/")) {
      [owner, repo] = target.split("/");
    }
    const prNumber = parseInt(prNumStr, 10);
    
    if (owner && repo && !isNaN(prNumber)) {
      await handlePrCommand(owner, cleanRepoName(repo), prNumber, targetId, messageType, bot);
      return;
    } else {
      const msg = "格式不正确。请使用 `/pr owner/repo <number>`。";
      if (messageType === "group") await bot.sendGroupText(targetId, msg);
      else await bot.sendPrivateText(targetId, msg);
      return;
    }
  }

  // 3. Auto-parse GitHub Repo URLs into cards
  const urlMatch = text.match(repoUrlRegex);
  if (urlMatch && !text.startsWith("/")) {
    const owner = urlMatch[1];
    const repo = cleanRepoName(urlMatch[2]);
    await handleRepoCard(owner, repo, targetId, messageType, bot);
  }
}

async function handleRepoCard(
  owner: string,
  repoName: string,
  targetId: string | number,
  messageType: string,
  bot: OneBotClient
) {
  try {
    const repo = await getRepo(owner, repoName);
    const timestamp = new Date(repo.updated_at).toLocaleString("zh-CN");

    const image = await renderTemplate("star", {
      repoFullName: repo.full_name,
      repoDescription: repo.description || "没有描述",
      avatarUrl: getAvatarUrl(repo.owner.login),
      senderName: repo.owner.login,
      actionText: "拥有仓库",
      timestamp,
      starCount: repo.stargazers_count,
      language: repo.language || "未知",
      forksCount: repo.forks_count,
    });

    const target = { type: messageType, id: String(targetId) };
    const fbText = `[Repo] ${repo.full_name}\nStar: ${repo.stargazers_count}`;
    await bot.sendImageToTarget(target, image, fbText);
  } catch (e: any) {
    console.error(`[Message] Failed to fetch repo info for ${owner}/${repoName}:`, e.message);
    if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
      const target = { type: messageType, id: String(targetId) };
      await bot.sendTextToTarget(target, "[GitHub API] 请求频率超限 (受限于 60次/小时)，请联系管理员在 WebUI 配置 GitHub Token 以提升至 5000次/小时。");
    }
  }
}

async function handleReadmeCommand(
  owner: string,
  repoName: string,
  targetId: string | number,
  messageType: string,
  bot: OneBotClient
) {
  const target = { type: messageType, id: String(targetId) };
  try {
    const { data: readme } = await getOctokit().repos.getReadme({
      owner,
      repo: repoName,
    });

    // Content is base64 encoded
    const content = Buffer.from(readme.content, "base64").toString("utf-8");
    const bodyHtml = markdownToHtml(content);
    
    // We reuse the 'release' template structure for a generic long-form layout
    const image = await renderTemplate("release", {
      repoFullName: `${owner}/${repoName}`,
      releaseName: "README.md",
      avatarUrl: getAvatarUrl(owner),
      authorName: owner,
      timestamp: new Date().toLocaleString("zh-CN"),
      tagName: "DOCUMENT",
      bodyHtml,
      assetsText: "由 GitHub QQ Push 提供",
    }, { fullPage: true });

    await bot.sendImageToTarget(target, image, "无法发送 README 图片");
  } catch (e: any) {
    console.error(`[Message] Failed to render README for ${owner}/${repoName}:`, e.message);
    let errorMsg = "获取 README 失败。";
    if (e.status === 404) {
      errorMsg = "未找到该仓库的 README 文件。";
    } else if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
      errorMsg = "[GitHub API] 请求频率超限 (受限于 60次/小时)，请联系管理员配置 GitHub Token。";
    }
    await bot.sendTextToTarget(target, errorMsg);
  }
}

async function handlePrCommand(
  owner: string,
  repoName: string,
  prNumber: number,
  targetId: string | number,
  messageType: string,
  bot: OneBotClient
) {
  const target = { type: messageType, id: String(targetId) };
  try {
    const { data: pr } = await getOctokit().pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    let badgeClass = "badge-pr-open";
    let eventLabel = "PR Opened";

    if (pr.state === "closed") {
      if (pr.merged) {
        badgeClass = "badge-pr-merged";
        eventLabel = "PR Merged";
      } else {
        badgeClass = "badge-pr-closed";
        eventLabel = "PR Closed";
      }
    }

    // Labels HTML
    let labelsHtml = "";
    if (pr.labels && pr.labels.length > 0) {
      const labelItems = pr.labels
        .map((l: any) => {
          const bg = l.color ? `#${l.color}` : "#30363d";
          return `<span class="label" style="background: ${bg}33; color: #${l.color || 'e6edf3'}; border-color: ${bg}55;">${l.name}</span>`;
        })
        .join("");
      labelsHtml = `<div class="labels">${labelItems}</div>`;
    }

    const prStats = `
      <div style="margin: 10px 0; padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
        <span style="color: #3fb950;">+${pr.additions} 增加</span>
        <span style="color: #8b949e; margin: 0 10px;">|</span>
        <span style="color: #f85149;">-${pr.deletions} 删除</span>
        <span style="color: #8b949e; margin: 0 10px;">|</span>
        <span style="color: #e6edf3;">${pr.changed_files} 个文件变更</span>
      </div>
    `;

    // Append stats to body
    const bodyHtml = markdownToHtml(pr.body || "", 50000) + prStats;
    const timestamp = new Date(pr.created_at).toLocaleString("zh-CN");

    const image = await renderTemplate("issue", {
      badgeClass,
      eventIcon: "",
      eventLabel,
      repoFullName: `${owner}/${repoName}`,
      title: pr.title,
      number: pr.number,
      avatarUrl: getAvatarUrl(pr.user?.login || "github"),
      authorName: pr.user?.login || "unknown",
      actionText: `查看了 Pull Request`,
      timestamp,
      labelsHtml,
      bodyHtml,
      comments: pr.comments || 0,
      reactions: 0,
    }, { fullPage: true });

    await bot.sendImageToTarget(target, image, "无法发送 PR 图片");
  } catch (e: any) {
    console.error(`[Message] Failed to fetch PR for ${owner}/${repoName}#${prNumber}:`, e.message);
    await bot.sendTextToTarget(target, "获取 PR 详细信息失败。请检查仓库或编号是否正确。");
  }
}
