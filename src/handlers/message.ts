import { OneBotClient } from "../onebot/client";
import { getRepo, getAvatarUrl, getOctokit } from "../github/api";
import { renderTemplate, markdownToHtml } from "../renderer";
import { setGroupToggle } from "../state";
import {
  addSubscription,
  removeSubscription,
  listSubscriptions,
  getConfig,
} from "../config";
import { serviceStartTime } from "../utils";

const repoUrlRegex =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/)?(?=$|[?#\s])/i;
const prUrlRegex =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]\S*)?/i;
const repoTagRegex = /\[Repo\]\s*([\w.-]+\/[\w.-]+)/i;
const prTagRegex = /\[PR\]\s*([\w.-]+\/[\w.-]+)#(\d+)/i;

function cleanRepoName(name: string) {
  return name.replace(/\.git$/, "");
}

function getTarget(payload: any) {
  const messageType = payload.message_type;
  const targetId =
    messageType === "group" ? String(payload.group_id) : String(payload.user_id);
  return { messageType, targetId };
}

function buildHelpMessage(prefix: string) {
  return [
    "[GitHub QQ Push] Available commands:",
    `${prefix}status`,
    `${prefix}help`,
    `${prefix}github on | ${prefix}github off`,
    `${prefix}github sub <owner/repo> [events]`,
    `${prefix}github unsub <owner/repo>`,
    `${prefix}github list`,
    `${prefix}readme <owner/repo>`,
    `${prefix}readme <repo-url>`,
    `${prefix}readme  (reply to a repo link/card)`,
    `${prefix}pr <owner/repo> <number>`,
    `${prefix}pr <owner/repo>#<number>`,
    `${prefix}pr <pull-request-url>`,
    `${prefix}pr  (reply to a PR link/card)`,
  ].join("\n");
}

export async function handleMessage(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const { messageType, targetId } = getTarget(payload);
  const text = String(payload.raw_message || "").trim();
  const prefix = getConfig().onebot.command_prefix || "/";

  // Extremely verbose log for debugging
  console.log(`[Message] Received: type=${messageType}, target=${targetId}, prefix="${prefix}", text="${text}"`);

  if (!["group", "private"].includes(messageType)) {
    console.log(`[Message] Ignoring non-group/private message type: ${messageType}`);
    return;
  }

  if (text === `${prefix}status` || text === `${prefix}github status`) {
    console.log(`[Message] Matches status command`);
    const uptime = Math.floor((Date.now() - serviceStartTime) / 1000);
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const subsCount = listSubscriptions({ type: "group", id: targetId }).length;

    let uptimeStr = "";
    if (days > 0) uptimeStr += `${days}天 `;
    if (hours > 0) uptimeStr += `${hours}小时 `;
    if (mins > 0) uptimeStr += `${mins}分 `;
    if (!uptimeStr) uptimeStr = "<1分";

    const reply = [
      "[GitHub QQ Push] 运行状态",
      `运行时间 (Uptime): ${uptimeStr.trim()}`,
      "服务状态 (Service): OK",
      `当前群组订阅数: ${subsCount}`,
    ].join("\n");
    await sendText(bot, messageType, targetId, reply);
    return;
  }

  if (text === `${prefix}help` || text === `${prefix}github help`) {
    console.log(`[Message] Matches help command`);
    await sendText(bot, messageType, targetId, buildHelpMessage(prefix));
    return;
  }

  if (messageType === "group") {
    const senderRole = payload.sender?.role;
    const isAdmin = senderRole === "owner" || senderRole === "admin";

    if (text.startsWith(`${prefix}github off`)) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群主或管理员可以禁用推送。");
        return;
      }
      setGroupToggle(targetId, true);
      await bot.sendGroupText(targetId, "本群 GitHub 推送已禁用。");
      return;
    }

    if (text.startsWith(`${prefix}github on`)) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群主或管理员可以启用推送。");
        return;
      }
      setGroupToggle(targetId, false);
      await bot.sendGroupText(targetId, "本群 GitHub 推送已启用。");
      return;
    }

    if (text.startsWith(`${prefix}github sub `)) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群主或管理员可以管理订阅。");
        return;
      }
      const parts = text.split(/\s+/).filter(Boolean);
      const targetRepo = parts[2];
      const eventsStr = parts[3];
      if (!targetRepo || !targetRepo.includes("/")) {
        await bot.sendGroupText(
          targetId,
          `用法: ${prefix}github sub owner/repo [事件,以逗号隔开]\n支持事件: push, issues, pull_request, release, star, fork`
        );
        return;
      }

      const events = eventsStr
        ? eventsStr.split(",")
        : ["push", "issues", "pull_request", "release", "star", "fork", "issue_comment"];
      addSubscription(cleanRepoName(targetRepo), events, {
        type: "group",
        id: targetId,
      });
      await bot.sendGroupText(
        targetId,
        `订阅成功: ${targetRepo}\n已订阅事件: ${events.join(", ")}`
      );
      return;
    }

    if (text.startsWith(`${prefix}github unsub `)) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有群主或管理员可以管理订阅。");
        return;
      }
      const parts = text.split(/\s+/).filter(Boolean);
      const targetRepo = parts[2];
      if (!targetRepo) {
        await bot.sendGroupText(targetId, `用法: ${prefix}github unsub owner/repo`);
        return;
      }
      const removed = removeSubscription(cleanRepoName(targetRepo), {
        type: "group",
        id: targetId,
      });
      await bot.sendGroupText(
        targetId,
        removed
          ? `已取消订阅: ${targetRepo}`
          : `本群尚未订阅仓库 ${targetRepo}`
      );
      return;
    }

    if (text === `${prefix}github list`) {
      console.log(`[Message] Matches list command`);
      const subs = listSubscriptions({ type: "group", id: targetId });
      if (subs.length === 0) {
        await bot.sendGroupText(targetId, "本群暂无 GitHub 订阅。");
        return;
      }
      const listText = subs
        .map((s) => `- ${s.repo} (${s.events.join(", ")})`)
        .join("\n");
      await bot.sendGroupText(targetId, `当前订阅列表:\n${listText}`);
      return;
    }
  }

  if (text.startsWith(`${prefix}readme`)) {
    console.log(`[Message] Matches readme command`);
    const replyContext = await getReplyContextText(payload, bot);
    const repoRef = parseRepoReference(
      text.slice(`${prefix}readme`.length).trim(),
      replyContext
    );
    if (!repoRef) {
      await sendText(
        bot,
        messageType,
        targetId,
        `用法:\n${prefix}readme owner/repo\n${prefix}readme <repo-url>\n或者直接回复一个代码仓库链接/卡片发送 ${prefix}readme`
      );
      return;
    }
    await handleReadmeCommand(repoRef.owner, repoRef.repo, targetId, messageType, bot);
    return;
  }

  if (text.startsWith(`${prefix}pr`)) {
    console.log(`[Message] Matches pr command`);
    const replyContext = await getReplyContextText(payload, bot);
    const prRef = parsePullRequestReference(
      text.slice(`${prefix}pr`.length).trim(),
      replyContext
    );
    if (!prRef) {
      await sendText(
        bot,
        messageType,
        targetId,
        `用法:\n${prefix}pr owner/repo 123\n${prefix}pr owner/repo#123\n${prefix}pr <pull-request-url>\n或者直接回复一个 PR 链接/卡片发送 ${prefix}pr`
      );
      return;
    }
    await handlePrCommand(
      prRef.owner,
      prRef.repo,
      prRef.prNumber,
      targetId,
      messageType,
      bot
    );
    return;
  }

  const urlMatch = text.match(repoUrlRegex);
  if (urlMatch && !text.startsWith(prefix) && canAutoParseRepoCard(messageType, targetId)) {
    await handleRepoCard(
      urlMatch[1],
      cleanRepoName(urlMatch[2]),
      targetId,
      messageType,
      bot
    );
  }
}

function canAutoParseRepoCard(messageType: string, targetId: string): boolean {
  if (messageType !== "group") {
    return true;
  }

  const githubConfig = getConfig().github;
  const mode = githubConfig.link_card_group_mode || "all";
  if (mode === "all") return true;
  if (mode === "none") return false;
  return (githubConfig.link_card_enabled_groups || []).includes(targetId);
}

async function getReplyContextText(
  payload: any,
  bot: OneBotClient
): Promise<string> {
  const replyId = extractReplyMessageId(payload);
  if (!replyId) {
    return "";
  }

  try {
    const replyMsg = await bot.callApi("get_msg", { message_id: Number(replyId) });
    return extractMessageSearchText(replyMsg);
  } catch (e: any) {
    console.warn(`[Message] Failed to fetch replied message ${replyId}:`, e.message);
    return "";
  }
}

function extractReplyMessageId(payload: any): string | undefined {
  if (Array.isArray(payload.message)) {
    const replySeg = payload.message.find(
      (seg: any) => seg?.type === "reply" && seg?.data?.id
    );
    if (replySeg?.data?.id) {
      return String(replySeg.data.id);
    }
  }

  const raw = String(payload.raw_message || "");
  return raw.match(/\[CQ:reply,id=(\d+)/i)?.[1];
}

function extractMessageSearchText(message: any): string {
  const parts = [String(message?.raw_message || "")];
  if (!Array.isArray(message?.message)) {
    return parts.join("\n");
  }

  for (const seg of message.message) {
    if (!seg || typeof seg !== "object") continue;
    if (seg.type === "text" && seg.data?.text) {
      parts.push(String(seg.data.text));
    } else if (seg.type === "share") {
      if (seg.data?.title) parts.push(String(seg.data.title));
      if (seg.data?.url) parts.push(String(seg.data.url));
    } else if ((seg.type === "json" || seg.type === "xml") && seg.data?.data) {
      parts.push(String(seg.data.data));
    }
  }

  return parts.join("\n");
}

function parseRepoReference(...sources: string[]): { owner: string; repo: string } | null {
  for (const source of sources) {
    const text = String(source || "").trim();
    if (!text) continue;

    const tagMatch = text.match(repoTagRegex);
    if (tagMatch) {
      const [owner, repo] = cleanRepoName(tagMatch[1]).split("/");
      if (owner && repo) return { owner, repo };
    }

    const urlMatch = text.match(repoUrlRegex);
    if (urlMatch) {
      return { owner: urlMatch[1], repo: cleanRepoName(urlMatch[2]) };
    }

    const directMatch = text.match(/\b([\w.-]+)\/([\w.-]+)\b/);
    if (directMatch) {
      return { owner: directMatch[1], repo: cleanRepoName(directMatch[2]) };
    }
  }
  return null;
}

function parsePullRequestReference(
  ...sources: string[]
): { owner: string; repo: string; prNumber: number } | null {
  for (const source of sources) {
    const text = String(source || "").trim();
    if (!text) continue;

    const tagMatch = text.match(prTagRegex);
    if (tagMatch) {
      const [owner, repo] = cleanRepoName(tagMatch[1]).split("/");
      const prNumber = parseInt(tagMatch[2], 10);
      if (owner && repo && !isNaN(prNumber)) {
        return { owner, repo, prNumber };
      }
    }

    const urlMatch = text.match(prUrlRegex);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: cleanRepoName(urlMatch[2]),
        prNumber: parseInt(urlMatch[3], 10),
      };
    }

    const hashMatch = text.match(/\b([\w.-]+)\/([\w.-]+)#(\d+)\b/);
    if (hashMatch) {
      return {
        owner: hashMatch[1],
        repo: cleanRepoName(hashMatch[2]),
        prNumber: parseInt(hashMatch[3], 10),
      };
    }

    const splitMatch = text.match(/\b([\w.-]+)\/([\w.-]+)\b\s+(\d+)\b/);
    if (splitMatch) {
      return {
        owner: splitMatch[1],
        repo: cleanRepoName(splitMatch[2]),
        prNumber: parseInt(splitMatch[3], 10),
      };
    }
  }
  return null;
}

async function sendText(
  bot: OneBotClient,
  messageType: string,
  targetId: string,
  text: string
) {
  if (messageType === "group") {
    await bot.sendGroupText(targetId, text);
  } else {
    await bot.sendPrivateText(targetId, text);
  }
}

async function handleRepoCard(
  owner: string,
  repoName: string,
  targetId: string,
  messageType: string,
  bot: OneBotClient
) {
  try {
    const repo = await getRepo(owner, repoName);
    const timestamp = new Date(repo.updated_at).toLocaleString("zh-CN");

    const image = await renderTemplate("star", {
      repoFullName: repo.full_name,
      repoDescription: repo.description || "No description",
      avatarUrl: getAvatarUrl(repo.owner.login),
      senderName: repo.owner.login,
      actionText: "Repository overview",
      timestamp,
      starCount: repo.stargazers_count,
      language: repo.language || "Unknown",
      forksCount: repo.forks_count,
    });

    await bot.sendImageToTarget(
      { type: messageType, id: targetId },
      image,
      `[Repo] ${repo.full_name}\nStar: ${repo.stargazers_count}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch repo info for ${owner}/${repoName}:`, e.message);
    if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
      await bot.sendTextToTarget(
        { type: messageType, id: targetId },
        "[GitHub API] Rate limit exceeded. Configure a GitHub token in WebUI."
      );
    }
  }
}

async function handleReadmeCommand(
  owner: string,
  repoName: string,
  targetId: string,
  messageType: string,
  bot: OneBotClient
) {
  const target = { type: messageType, id: targetId };
  try {
    const { data: readme } = await getOctokit().repos.getReadme({
      owner,
      repo: repoName,
    });

    const content = Buffer.from(readme.content, "base64").toString("utf-8");
    const bodyHtml = markdownToHtml(content);

    const image = await renderTemplate(
      "release",
      {
        repoFullName: `${owner}/${repoName}`,
        releaseName: "README.md",
        avatarUrl: getAvatarUrl(owner),
        authorName: owner,
        timestamp: new Date().toLocaleString("zh-CN"),
        tagName: "DOCUMENT",
        bodyHtml,
        assetsText: "Powered by GitHub QQ Push",
      },
      { fullPage: true }
    );

    await bot.sendImageToTarget(target, image, `[Repo] ${owner}/${repoName}\nREADME`);
  } catch (e: any) {
    console.error(`[Message] Failed to render README for ${owner}/${repoName}:`, e.message);
    let errorMsg = "Failed to fetch README.";
    if (e.status === 404) {
      errorMsg = "README not found for this repository.";
    } else if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
      errorMsg = "[GitHub API] Rate limit exceeded. Configure a GitHub token in WebUI.";
    }
    await bot.sendTextToTarget(target, errorMsg);
  }
}

async function handlePrCommand(
  owner: string,
  repoName: string,
  prNumber: number,
  targetId: string,
  messageType: string,
  bot: OneBotClient
) {
  const target = { type: messageType, id: targetId };
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

    let labelsHtml = "";
    if (pr.labels && pr.labels.length > 0) {
      const labelItems = pr.labels
        .map((l: any) => {
          const bg = l.color ? `#${l.color}` : "#30363d";
          return `<span class="label" style="background: ${bg}33; color: #${l.color || "e6edf3"}; border-color: ${bg}55;">${l.name}</span>`;
        })
        .join("");
      labelsHtml = `<div class="labels">${labelItems}</div>`;
    }

    const prStats = `
      <div style="margin: 10px 0; padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
        <span style="color: #3fb950;">+${pr.additions} additions</span>
        <span style="color: #8b949e; margin: 0 10px;">|</span>
        <span style="color: #f85149;">-${pr.deletions} deletions</span>
        <span style="color: #8b949e; margin: 0 10px;">|</span>
        <span style="color: #e6edf3;">${pr.changed_files} files changed</span>
      </div>
    `;

    const bodyHtml = markdownToHtml(pr.body || "", 50000) + prStats;
    const timestamp = new Date(pr.created_at).toLocaleString("zh-CN");

    const image = await renderTemplate(
      "issue",
      {
        badgeClass,
        eventIcon: "",
        eventLabel,
        repoFullName: `${owner}/${repoName}`,
        title: pr.title,
        number: pr.number,
        avatarUrl: getAvatarUrl(pr.user?.login || "github"),
        authorName: pr.user?.login || "unknown",
        actionText: "Pull Request details",
        timestamp,
        labelsHtml,
        bodyHtml,
        comments: pr.comments || 0,
        reactions: 0,
      },
      { fullPage: true }
    );

    await bot.sendImageToTarget(
      target,
      image,
      `[PR] ${owner}/${repoName}#${pr.number}\n${pr.title}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch PR for ${owner}/${repoName}#${prNumber}:`, e.message);
    await bot.sendTextToTarget(target, "Failed to fetch PR details. Check repository and number.");
  }
}
