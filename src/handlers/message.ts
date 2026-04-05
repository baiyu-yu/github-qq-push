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
const issueUrlRegex =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)(?:[/?#]\S*)?/i;
const repoTagRegex = /\[Repo\]\s*([\w.-]+\/[\w.-]+)/i;
const prTagRegex = /\[PR\]\s*([\w.-]+\/[\w.-]+)#(\d+)/i;
const issueTagRegex = /\[Issue\]\s*([\w.-]+\/[\w.-]+)#(\d+)/i;

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
    "[GitHub QQ Push] 可用命令:",
    `${prefix}status`,
    `${prefix}help`,
    `${prefix}github on | ${prefix}github off`,
    `${prefix}github sub <owner/repo> [events]`,
    `${prefix}github unsub <owner/repo>`,
    `${prefix}github list`,
    `${prefix}readme <owner/repo>`,
    `${prefix}readme <repo-url>`,
    `${prefix}readme  (引用回复 repo link/card)`,
    `${prefix}pr <owner/repo> <number>`,
    `${prefix}pr <owner/repo>#<number>`,
    `${prefix}pr <pull-request-url>`,
    `${prefix}pr  (引用回复 PR link/card)`,
    `${prefix}detail  (引用回复 PR card查看详细变更)`,
  ].join("\n");
}

function stripCqCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
}

export async function handleMessage(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const { messageType, targetId } = getTarget(payload);
  const rawText = String(payload.raw_message || "").trim();
  const text = stripCqCodes(rawText);
  const prefix = getConfig().onebot.command_prefix || "/";

  // Extremely verbose log for debugging
  console.log(`[Message] Received: type=${messageType}, target=${targetId}, prefix="${prefix}", raw="${rawText}", text="${text}"`);

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
          `用法: ${prefix}github sub owner/repo [事件,以逗号隔开]\n支持事件: push, issues, pull_request, pull_request_review, release, star, fork, issue_comment`
        );
        return;
      }

      const events = eventsStr
        ? eventsStr.split(",")
        : ["push", "issues", "pull_request", "pull_request_review", "release", "star", "fork", "issue_comment"];
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

  if (text.startsWith(`${prefix}detail`)) {
    console.log(`[Message] Matches detail command`);
    const replyContext = await getReplyContextText(payload, bot);
    
    // Only support PR detail, not Issue
    const prRef = parsePullRequestReference(replyContext);
    
    if (prRef) {
      await handlePrDetailCommand(
        prRef.owner,
        prRef.repo,
        prRef.prNumber,
        targetId,
        messageType,
        bot
      );
      return;
    }
    
    await sendText(
      bot,
      messageType,
      targetId,
      `用法: 引用回复一个 PR 卡片，然后发送 ${prefix}detail 查看代码变更详情`
    );
    return;
  }

  // Auto-parse PR URL (before repo URL to avoid false matches)
  const prUrlMatch = text.match(prUrlRegex);
  if (prUrlMatch && !text.startsWith(prefix) && canAutoParseRepoCard(messageType, targetId)) {
    await handlePrSummaryCard(
      prUrlMatch[1],
      cleanRepoName(prUrlMatch[2]),
      parseInt(prUrlMatch[3], 10),
      targetId,
      messageType,
      bot
    );
    return;
  }

  // Auto-parse Issue URL
  const issueUrlMatch = text.match(issueUrlRegex);
  if (issueUrlMatch && !text.startsWith(prefix) && canAutoParseRepoCard(messageType, targetId)) {
    await handleIssueSummaryCard(
      issueUrlMatch[1],
      cleanRepoName(issueUrlMatch[2]),
      parseInt(issueUrlMatch[3], 10),
      targetId,
      messageType,
      bot
    );
    return;
  }

  // Auto-parse Repo URL (lowest priority)
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

  // First check if we have metadata stored locally for this message
  const metadata = bot.getMessageMetadata(replyId);
  if (metadata) {
    console.log(`[Message] Using stored metadata for msg ${replyId}: "${metadata.slice(0, 100)}..."`);
    return metadata;
  }

  // Fallback to fetching the message via API
  try {
    const replyMsg = await bot.callApi("get_msg", { message_id: Number(replyId) });
    const extracted = extractMessageSearchText(replyMsg);
    console.log(`[Message] Extracted reply context from msg ${replyId}: "${extracted.slice(0, 100)}..."`);
    return extracted;
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
    } else if (seg.type === "image" && seg.data?.url) {
      // Some implementations may include URL in image segment
      parts.push(String(seg.data.url));
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

function parseIssueReference(
  ...sources: string[]
): { owner: string; repo: string; issueNumber: number } | null {
  for (const source of sources) {
    const text = String(source || "").trim();
    if (!text) continue;

    const tagMatch = text.match(issueTagRegex);
    if (tagMatch) {
      const [owner, repo] = cleanRepoName(tagMatch[1]).split("/");
      const issueNumber = parseInt(tagMatch[2], 10);
      if (owner && repo && !isNaN(issueNumber)) {
        return { owner, repo, issueNumber };
      }
    }

    const urlMatch = text.match(issueUrlRegex);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: cleanRepoName(urlMatch[2]),
        issueNumber: parseInt(urlMatch[3], 10),
      };
    }

    // Note: Don't use generic #number pattern here to avoid confusion with PRs
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
      `[Repo] ${repo.full_name}\n${repo.html_url}\nStar: ${repo.stargazers_count}`
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

// Handle PR summary card (brief overview)
async function handlePrSummaryCard(
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
    let statusText = "Open";

    if (pr.state === "closed") {
      if (pr.merged) {
        badgeClass = "badge-pr-merged";
        statusText = "Merged";
      } else {
        badgeClass = "badge-pr-closed";
        statusText = "Closed";
      }
    }

    // Brief summary without full body
    const summaryHtml = `
      <div style="color: #8b949e; margin: 10px 0;">
        <div style="margin-bottom: 8px;">
          <span style="color: #3fb950;">+${pr.additions}</span>
          <span style="margin: 0 8px;">|</span>
          <span style="color: #f85149;">-${pr.deletions}</span>
          <span style="margin: 0 8px;">|</span>
          <span>${pr.changed_files} files</span>
        </div>
        <div style="font-size: 13px;">
          ${pr.head?.label || ""} → ${pr.base?.label || ""}
        </div>
        <div style="margin-top: 10px; padding: 8px; background: #161b22; border-radius: 4px; font-size: 12px;">
          💬 ${pr.comments || 0} comments
        </div>
      </div>
    `;

    const timestamp = new Date(pr.created_at).toLocaleString("zh-CN");

    const image = await renderTemplate("issue", {
      badgeClass,
      eventIcon: "",
      eventLabel: `PR ${statusText}`,
      repoFullName: `${owner}/${repoName}`,
      title: pr.title,
      number: pr.number,
      avatarUrl: getAvatarUrl(pr.user?.login || "github"),
      authorName: pr.user?.login || "unknown",
      actionText: "Pull Request",
      timestamp,
      labelsHtml: "",
      bodyHtml: summaryHtml,
      comments: pr.comments || 0,
      reactions: 0,
    });

    await bot.sendImageToTarget(
      target,
      image,
      `[PR] ${owner}/${repoName}#${pr.number}\n${pr.html_url}\n${pr.title}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch PR summary for ${owner}/${repoName}#${prNumber}:`, e.message);
    await bot.sendTextToTarget(target, "Failed to fetch PR. Check repository and number.");
  }
}

// Handle Issue summary card (brief overview)
async function handleIssueSummaryCard(
  owner: string,
  repoName: string,
  issueNumber: number,
  targetId: string,
  messageType: string,
  bot: OneBotClient
) {
  const target = { type: messageType, id: targetId };
  try {
    const { data: issue } = await getOctokit().issues.get({
      owner,
      repo: repoName,
      issue_number: issueNumber,
    });

    let badgeClass = "badge-issue-open";
    let statusText = "Open";

    if (issue.state === "closed") {
      badgeClass = issue.state_reason === "not_planned"
        ? "badge-pr-closed"
        : "badge-issue-closed";
      statusText = "Closed";
    }

    // Brief summary without full body
    const summaryHtml = `
      <div style="color: #8b949e; margin: 10px 0;">
        <div style="margin-bottom: 10px; padding: 8px; background: #161b22; border-radius: 4px; font-size: 12px;">
          💬 ${issue.comments || 0} comments
        </div>
      </div>
    `;

    const timestamp = new Date(issue.created_at).toLocaleString("zh-CN");

    const image = await renderTemplate("issue", {
      badgeClass,
      eventIcon: "",
      eventLabel: `Issue ${statusText}`,
      repoFullName: `${owner}/${repoName}`,
      title: issue.title,
      number: issue.number,
      avatarUrl: getAvatarUrl(issue.user?.login || "github"),
      authorName: issue.user?.login || "unknown",
      actionText: "Issue",
      timestamp,
      labelsHtml: "",
      bodyHtml: summaryHtml,
      comments: issue.comments || 0,
      reactions: issue.reactions?.total_count || 0,
    });

    await bot.sendImageToTarget(
      target,
      image,
      `[Issue] ${owner}/${repoName}#${issue.number}\n${issue.html_url}\n${issue.title}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch Issue summary for ${owner}/${repoName}#${issueNumber}:`, e.message);
    await bot.sendTextToTarget(target, "Failed to fetch Issue. Check repository and number.");
  }
}

// Handle PR detail command (show code changes/diff)
async function handlePrDetailCommand(
  owner: string,
  repoName: string,
  prNumber: number,
  targetId: string,
  messageType: string,
  bot: OneBotClient
) {
  const target = { type: messageType, id: targetId };
  try {
    const octokit = getOctokit();
    
    // Get PR details
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    // Get PR files (changed files with diff)
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: prNumber,
      per_page: 10, // Limit to first 10 files to avoid too large response
    });

    let badgeClass = "badge-pr-open";
    let eventLabel = "PR Code Changes";

    if (pr.state === "closed") {
      if (pr.merged) {
        badgeClass = "badge-pr-merged";
        eventLabel = "PR Merged - Code Changes";
      } else {
        badgeClass = "badge-pr-closed";
        eventLabel = "PR Closed - Code Changes";
      }
    }

    // Build file changes HTML
    let filesHtml = "";
    const displayFiles = files.slice(0, 10); // Show max 10 files
    
    for (const file of displayFiles) {
      const statusColor = 
        file.status === "added" ? "#3fb950" :
        file.status === "removed" ? "#f85149" :
        file.status === "modified" ? "#d29922" : "#8b949e";
      
      const statusIcon = 
        file.status === "added" ? "+" :
        file.status === "removed" ? "-" :
        file.status === "modified" ? "M" : "•";

      // Truncate patch if too long
      let patch = file.patch || "";
      const maxPatchLines = 20;
      const patchLines = patch.split("\n");
      if (patchLines.length > maxPatchLines) {
        patch = patchLines.slice(0, maxPatchLines).join("\n") + "\n... (truncated)";
      }

      filesHtml += `
        <div style="margin: 12px 0; padding: 10px; background: #0d1117; border-radius: 6px; border: 1px solid #30363d;">
          <div style="margin-bottom: 8px; font-family: monospace; font-size: 13px;">
            <span style="color: ${statusColor}; font-weight: bold;">${statusIcon}</span>
            <span style="color: #e6edf3; margin-left: 8px;">${file.filename}</span>
            <span style="color: #8b949e; margin-left: 8px; font-size: 11px;">
              +${file.additions} -${file.deletions}
            </span>
          </div>
          ${patch ? `
            <pre style="margin: 8px 0 0 0; padding: 8px; background: #161b22; border-radius: 4px; overflow-x: auto; font-size: 11px; line-height: 1.4; color: #c9d1d9; font-family: 'Consolas', 'Monaco', monospace; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(patch)}</pre>
          ` : ""}
        </div>
      `;
    }

    if (files.length > 10) {
      filesHtml += `
        <div style="margin: 10px 0; padding: 8px; background: #161b22; border-radius: 4px; text-align: center; color: #8b949e; font-size: 12px;">
          ... 还有 ${files.length - 10} 个文件未显示
        </div>
      `;
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

    const bodyHtml = prStats + filesHtml;
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
        actionText: "代码变更详情",
        timestamp,
        labelsHtml: "",
        bodyHtml,
        comments: pr.comments || 0,
        reactions: 0,
      },
      { fullPage: true }
    );

    await bot.sendImageToTarget(
      target,
      image,
      `[PR Changes] ${owner}/${repoName}#${pr.number}\n${pr.html_url}\n${pr.title}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch PR changes for ${owner}/${repoName}#${prNumber}:`, e.message);
    await bot.sendTextToTarget(target, "Failed to fetch PR code changes. Check repository and number.");
  }
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}
