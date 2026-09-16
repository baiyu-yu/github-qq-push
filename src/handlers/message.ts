import { IBotClient } from "../bot/types";
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
const commitUrlRegex =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([a-f0-9]+)(?:[/?#]\S*)?/i;
const repoTagRegex = /\[(?:Repo|Repository)(?:[ \t]+[^\]]+)?\]\s*([\w.-]+\/[\w.-]+)/i;
const prTagRegex = /\[(?:PR|Pull\s*Request)(?:[ \t]+[^\]]+)?\]\s*([\w.-]+\/[\w.-]+)(?:[#\s]+)(\d+)/i;
const issueTagRegex = /\[Issue(?:[ \t]+[^\]]+)?\]\s*([\w.-]+\/[\w.-]+)(?:[#\s]+)(\d+)/i;
const commitTagRegex = /\[(?:Commit|Push)(?:[ \t]+[^\]]+)?\]\s*([\w.-]+\/[\w.-]+)(?:[@:]|\s+)([a-f0-9]{7,40})/i;

const VALID_EVENTS = [
  "push",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "release",
  "star",
  "fork",
  "issue_comment",
  "commit_comment",
  "edited",
];

const DEFAULT_EVENTS = [
  "push",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "release",
  "star",
  "fork",
  "issue_comment",
  "commit_comment",
  "edited",
];

// Cooldown between auto-replied GitHub link cards per target (10s)
const AUTO_CARD_COOLDOWN_MS = 10 * 1000;
const autoCardCooldowns = new Map<string, number>();

function isValidRepoName(name: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(name);
}

function canAutoReply(targetId: string): boolean {
  const now = Date.now();
  const last = autoCardCooldowns.get(targetId) || 0;
  if (now - last < AUTO_CARD_COOLDOWN_MS) return false;
  autoCardCooldowns.set(targetId, now);
  return true;
}

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
    `${prefix}id  (查看当前群ID和个人ID)`,
    `${prefix}help`,
    `${prefix}github on | ${prefix}github off`,
    `${prefix}github sub <owner/repo> [events]`,
    `${prefix}github unsub <owner/repo> [events]`,
    `${prefix}github list`,
    `${prefix}readme <owner/repo>`,
    `${prefix}readme  (单仓库群直接发送，或引用回复 repo link/card)`,
    `${prefix}pr <owner/repo> <number>`,
    `${prefix}pr <number>  (单仓库群直接发送)`,
    `${prefix}pr <pull-request-url>`,
    `${prefix}pr  (引用回复 PR link/card)`,
    `${prefix}issue <owner/repo> <number>`,
    `${prefix}issue <number>  (单仓库群直接发送)`,
    `${prefix}issue <issue-url>`,
    `${prefix}issue  (引用回复 Issue link/card)`,
    `#<number>  (单仓库群直接发送 #数字 查看详情)`,
    `${prefix}commit <owner/repo> <sha>`,
    `${prefix}commit <owner/repo>@<sha>`,
    `${prefix}commit <commit-url>`,
    `${prefix}commit  (引用回复 Commit link/card)`,
    `${prefix}diff <owner/repo> <number|sha>`,
    `${prefix}diff <number>  (单仓库群直接发送)`,
    `${prefix}diff  (引用回复 PR/Commit 查看代码变更)`,
  ].join("\n");
}

function stripCqCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
}

function getBotSettings(bot: IBotClient) {
  const cfg = getConfig();
  const instance = cfg.bots?.find((b) => b.id === bot.id);
  if (instance) {
    if (instance.protocol === "milky" && instance.milky) {
      return {
        command_prefix: instance.milky.command_prefix || "/",
        masters: instance.milky.masters || [],
      };
    }
    if (instance.protocol === "qqbot" && instance.qqbot) {
      return {
        command_prefix: instance.qqbot.command_prefix || "/",
        masters: instance.qqbot.masters || [],
      };
    }
    if (instance.protocol === "onebot" && instance.onebot) {
      return {
        command_prefix: instance.onebot.command_prefix || "/",
        masters: instance.onebot.masters || [],
      };
    }
  }

  if (bot.protocol === "milky" && cfg.milky) {
    return {
      command_prefix: cfg.milky.command_prefix || "/",
      masters: cfg.milky.masters || [],
    };
  }
  if (bot.protocol === "qqbot" && cfg.qqbot) {
    return {
      command_prefix: cfg.qqbot.command_prefix || "/",
      masters: cfg.qqbot.masters || [],
    };
  }
  return {
    command_prefix: cfg.onebot.command_prefix || "/",
    masters: cfg.onebot.masters || [],
  };
}

export async function handleMessage(
  payload: any,
  rawBot: IBotClient
): Promise<void> {
  const msgId = String(payload.message_id || "");
  const bot: IBotClient = msgId
    ? Object.assign(Object.create(rawBot), {
        sendGroupText: (groupId: string, text: string, options?: any) =>
          rawBot.sendGroupText(groupId, text, { msgId, ...options }),
        sendGroupImage: (
          groupId: string,
          imageBase64: string,
          fallbackText?: string,
          options?: any
        ) =>
          rawBot.sendGroupImage(groupId, imageBase64, fallbackText, {
            msgId,
            ...options,
          }),
        sendPrivateText: (userId: string, text: string, options?: any) =>
          rawBot.sendPrivateText(userId, text, { msgId, ...options }),
        sendPrivateImage: (
          userId: string,
          imageBase64: string,
          fallbackText?: string,
          options?: any
        ) =>
          rawBot.sendPrivateImage(userId, imageBase64, fallbackText, {
            msgId,
            ...options,
          }),
        sendImageToTarget: (
          target: any,
          imageBase64: string,
          fallbackText?: string,
          options?: any
        ) =>
          rawBot.sendImageToTarget(target, imageBase64, fallbackText, {
            msgId,
            ...options,
          }),
        sendTextToTarget: (target: any, text: string, options?: any) =>
          rawBot.sendTextToTarget(target, text, { msgId, ...options }),
      })
    : rawBot;

  const { messageType, targetId } = getTarget(payload);
  const rawText = String(payload.raw_message || "").trim();
  const text = stripCqCodes(rawText);
  const { command_prefix: prefix, masters } = getBotSettings(bot);

  // Truncated log to avoid dumping full chat content into logs/WebUI
  const preview = rawText.length > 120 ? rawText.slice(0, 120) + "..." : rawText;
  console.log(`[Message] Received: type=${messageType}, target=${targetId}, text="${preview}" (msgId=${msgId || "none"})`);

  if (!["group", "private"].includes(messageType)) {
    console.log(`[Message] Ignoring non-group/private message type: ${messageType}`);
    return;
  }

  const senderId = String(payload.user_id || payload.sender?.user_id || "");
  const isMaster = masters.includes(senderId);
  const senderRole = messageType === "group" ? payload.sender?.role : undefined;
  const isAdmin = isMaster || senderRole === "owner" || senderRole === "admin";

  if (text === `${prefix}status` || text === `${prefix}github status`) {
    console.log(`[Message] Matches status command`);
    const uptime = Math.floor((Date.now() - serviceStartTime) / 1000);
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const subsCount = listSubscriptions({
      type: messageType === "group" ? "group" : "private",
      id: targetId,
    }).length;

    let uptimeStr = "";
    if (days > 0) uptimeStr += `${days}天 `;
    if (hours > 0) uptimeStr += `${hours}小时 `;
    if (mins > 0) uptimeStr += `${mins}分 `;
    if (!uptimeStr) uptimeStr = "<1分";

    const conn = bot.getConnectionState();
    let connText = "未知";
    if (conn.connected) {
      connText = "已连接";
    } else if (conn.stopped) {
      connText = `未连接（已停止重试 ${conn.attempts}/${conn.maxAttempts}）`;
    } else {
      connText = `连接中（重试 ${conn.attempts}/${conn.maxAttempts}）`;
    }

    const tokenCount = (getConfig().github.access_tokens || []).length;
    const protoLabel =
      bot.protocol === "milky"
        ? "Milky"
        : bot.protocol === "qqbot"
          ? `QQBot (${(getConfig().qqbot?.mode || "ws").toUpperCase()})`
          : "OneBot";

    const reply = [
      "[GitHub QQ Push] 运行状态",
      `运行时间 (Uptime): ${uptimeStr.trim()}`,
      `机器人服务 (${protoLabel}): ${connText}`,
      `GitHub Token: ${tokenCount > 0 ? `已配置 ${tokenCount} 个` : "未配置（轮询可能受匿名限流）"}`,
      `当前订阅数: ${subsCount}`,
    ].join("\n");
    await sendText(bot, messageType, targetId, reply);
    return;
  }

  if (text === `${prefix}help` || text === `${prefix}github help`) {
    console.log(`[Message] Matches help command`);
    await handleHelpCommand(targetId, messageType, prefix, bot);
    return;
  }

  const isAtBot =
    payload.sub_type === "at" ||
    (Boolean(payload.self_id) &&
      (rawText.includes(`[CQ:at,qq=${payload.self_id}]`) ||
        rawText.startsWith(`<@!${payload.self_id}>`)));

  const isIdCommand =
    text === `${prefix}id` ||
    text === "/id" ||
    text === `${prefix}myid` ||
    text === "/myid" ||
    text === `${prefix}whoami` ||
    text === "/whoami" ||
    text === `${prefix}github id` ||
    text === "/github id" ||
    (messageType === "private" && (text === "id" || text === "myid" || text === "whoami")) ||
    (isAtBot && (text === "id" || text === "myid" || text === "whoami"));

  if (isIdCommand) {
    console.log(`[Message] Matches id command`);
    const protoLabel =
      bot.protocol === "milky"
        ? "Milky"
        : bot.protocol === "qqbot"
          ? `QQBot (${(getConfig().qqbot?.mode || "ws").toUpperCase()})`
          : "OneBot";

    const isGroup = messageType === "group";
    const currentGroupId = isGroup
      ? String(payload.group_id || targetId)
      : "无 (私聊会话)";
    const currentUserId = senderId || "未知";
    const senderNick = payload.sender?.nickname
      ? ` (${payload.sender.nickname})`
      : "";
    const selfId = payload.self_id || bot.getBotInfo()?.user_id || "";

    const isQQBot = bot.protocol === "qqbot";
    const groupLabel = isQQBot ? "群 OpenID" : "群号 (Group ID)";
    const userLabel = isQQBot ? "个人 OpenID" : "个人 QQ (User ID)";

    const reply = [
      `[ID 查询] 协议: ${protoLabel}`,
      `当前场景: ${isGroup ? "群聊 (Group)" : "私聊 (Private)"}`,
      `${groupLabel}: ${currentGroupId}`,
      `${userLabel}: ${currentUserId}${senderNick}`,
      ...(selfId ? [`机器人 ID: ${selfId}`] : []),
      `订阅目标配置 (Target): ${targetId} (${messageType})`,
    ].join("\n");

    await sendText(bot, messageType, targetId, reply);
    return;
  }

  if (messageType === "group") {
    if (text.startsWith(`${prefix}github off`)) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有 Master、群主或管理员可以禁用推送。");
        return;
      }
      setGroupToggle(targetId, true);
      await bot.sendGroupText(targetId, "本群 GitHub 推送已禁用。");
      return;
    }

    if (text.startsWith(`${prefix}github on`)) {
      if (!isAdmin) {
        await bot.sendGroupText(targetId, "只有 Master、群主或管理员可以启用推送。");
        return;
      }
      setGroupToggle(targetId, false);
      await bot.sendGroupText(targetId, "本群 GitHub 推送已启用。");
      return;
    }
  } else if (text.startsWith(`${prefix}github off`) || text.startsWith(`${prefix}github on`)) {
    await bot.sendPrivateText(targetId, "开/关推送命令仅支持群聊使用。");
    return;
  }

  if (messageType === "group" || isMaster) {
    if (text.startsWith(`${prefix}github sub `)) {
      if (!isAdmin) {
        await sendText(bot, messageType, targetId, "只有 Master、群主或管理员可以管理订阅。");
        return;
      }
      const parts = text.split(/\s+/).filter(Boolean);
      const targetRepo = cleanRepoName(parts[2] || "");
      if (!targetRepo || !isValidRepoName(targetRepo)) {
        await sendText(
          bot,
          messageType,
          targetId,
          `仓库格式不正确，应为 owner/repo（例如 octocat/Hello-World）。\n用法: ${prefix}github sub owner/repo [事件]`
        );
        return;
      }

      const rawEvents = parts.slice(3).join(",").split(/[\s,]+/).filter(Boolean);
      const events = rawEvents.length > 0 ? rawEvents : DEFAULT_EVENTS;
      const invalid = events.filter((e) => !VALID_EVENTS.includes(e));
      if (invalid.length > 0) {
        await sendText(
          bot,
          messageType,
          targetId,
          `未知事件: ${invalid.join(", ")}\n支持的事件: ${VALID_EVENTS.join(", ")}`
        );
        return;
      }

      // Verify the repository exists before subscribing, so typos do not
      // silently create dead subscriptions.
      const [owner, repoName] = targetRepo.split("/");
      let canonicalName = targetRepo;
      try {
        const repo = await getRepo(owner, repoName);
        canonicalName = repo.full_name;
      } catch (e: any) {
        if (e.status === 404) {
          await sendText(bot, messageType, targetId, `仓库 ${targetRepo} 不存在或无权访问。`);
        } else if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
          await sendText(bot, messageType, targetId, "[GitHub API] 已达到限流，请稍后再试或在 WebUI 配置 Token。");
        } else {
          await sendText(bot, messageType, targetId, `验证仓库 ${targetRepo} 失败，请稍后再试。`);
        }
        return;
      }

      addSubscription(canonicalName, events, {
        type: messageType === "group" ? "group" : "private",
        id: targetId,
        botId: bot.id,
      });
      await sendText(
        bot,
        messageType,
        targetId,
        `订阅成功: ${canonicalName}\n绑定协议端: ${bot.name || bot.id}\n已订阅事件: ${events.join(", ")}`
      );
      return;
    }

    if (text.startsWith(`${prefix}github unsub `)) {
      if (!isAdmin) {
        await sendText(bot, messageType, targetId, "只有 Master、群主或管理员可以管理订阅。");
        return;
      }
      const parts = text.split(/\s+/).filter(Boolean);
      const targetRepo = cleanRepoName(parts[2] || "");
      if (!targetRepo || !isValidRepoName(targetRepo)) {
        await sendText(bot, messageType, targetId, `仓库格式不正确，应为 owner/repo。\n用法: ${prefix}github unsub owner/repo [事件]`);
        return;
      }

      const eventsToRemove = parts.slice(3).join(",").split(/[\s,]+/).filter(Boolean);
      const result = removeSubscription(
        targetRepo,
        { type: messageType === "group" ? "group" : "private", id: targetId, botId: bot.id },
        eventsToRemove.length > 0 ? eventsToRemove : undefined
      );

      if (!result.success) {
        await sendText(bot, messageType, targetId, `尚未订阅仓库 ${targetRepo}，或未包含指定的取消事件。`);
      } else if (eventsToRemove.length > 0) {
        const removedStr = (result.removedEvents || []).join(", ");
        const remainingStr = (result.remainingEvents || []).length > 0
          ? (result.remainingEvents || []).join(", ")
          : "无 (已完全取消该仓库订阅)";
        await sendText(
          bot,
          messageType,
          targetId,
          `已从 ${targetRepo} 移除事件: ${removedStr}\n当前剩余订阅事件: ${remainingStr}`
        );
      } else {
        await sendText(bot, messageType, targetId, `已取消订阅仓库: ${targetRepo}`);
      }
      return;
    }

  }

  if (text === `${prefix}github list` && (messageType === "group" || messageType === "private")) {
    console.log(`[Message] Matches list command`);
    const subs = listSubscriptions({
      type: messageType === "group" ? "group" : "private",
      id: targetId,
      botId: bot.id,
    });
    if (subs.length === 0) {
      await sendText(bot, messageType, targetId, `[${bot.name || bot.id}] 暂无 GitHub 订阅。`);
      return;
    }
    const listText = subs
      .map((s) => `- ${s.repo} (${s.events.join(", ")})`)
      .join("\n");
    await sendText(bot, messageType, targetId, `[${bot.name || bot.id}] 当前订阅列表:\n${listText}`);
    return;
  }

  // Shortcut: #123 directly fetches Issue/PR details if exactly 1 repo is bound
  const sharpNumberMatch = text.match(/^[#＃]\s*(\d+)$/);
  if (sharpNumberMatch) {
    const subs = listSubscriptions({
      type: messageType === "group" ? "group" : "private",
      id: targetId,
      botId: bot.id,
    });
    if (subs.length === 1) {
      console.log(`[Message] Matches #number shortcut for bound repo ${subs[0].repo}`);
      const [owner, repo] = subs[0].repo.split("/");
      const number = parseInt(sharpNumberMatch[1], 10);
      await handleIssueCommand(owner, repo, number, targetId, messageType, bot);
      return;
    }
  }

  if (text.startsWith(`${prefix}readme`)) {
    console.log(`[Message] Matches readme command`);
    const replyContext = await getReplyContextText(payload, bot);
    const readmeArg = text.slice(`${prefix}readme`.length).trim();
    let repoRef = parseRepoReference(readmeArg, replyContext);

    // Fallback: if no repo given and target has exactly 1 subscription
    if (!repoRef && !readmeArg) {
      const subs = listSubscriptions({
        type: messageType === "group" ? "group" : "private",
        id: targetId,
      });
      if (subs.length === 1) {
        const [owner, repo] = subs[0].repo.split("/");
        repoRef = { owner, repo };
      }
    }

    if (!repoRef) {
      await sendText(
        bot,
        messageType,
        targetId,
        `用法:\n${prefix}readme owner/repo\n${prefix}readme <repo-url>\n${prefix}readme (单仓库群直接发送)\n或者直接回复一个代码仓库链接/卡片发送 ${prefix}readme`
      );
      return;
    }
    await handleReadmeCommand(repoRef.owner, repoRef.repo, targetId, messageType, bot);
    return;
  }

  if (text.startsWith(`${prefix}pr`)) {
    console.log(`[Message] Matches pr command`);
    const replyContext = await getReplyContextText(payload, bot);
    const prArg = text.slice(`${prefix}pr`.length).trim();
    let prRef = parsePullRequestReference(prArg, replyContext);

    // Fallback: if prArg is just a number (e.g. /pr 123) and target has exactly 1 subscription
    if (!prRef && /^\d+$/.test(prArg)) {
      const subs = listSubscriptions({
        type: messageType === "group" ? "group" : "private",
        id: targetId,
      });
      if (subs.length === 1) {
        const [owner, repo] = subs[0].repo.split("/");
        prRef = { owner, repo, prNumber: parseInt(prArg, 10) };
      }
    }

    if (!prRef) {
      await sendText(
        bot,
        messageType,
        targetId,
        `用法:\n${prefix}pr owner/repo 123\n${prefix}pr owner/repo#123\n${prefix}pr <pull-request-url>\n${prefix}pr <number> (单仓库群直接发送)\n或者直接回复一个 PR 链接/卡片发送 ${prefix}pr`
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

  if (text.startsWith(`${prefix}issue`)) {
    console.log(`[Message] Matches issue command`);
    const replyContext = await getReplyContextText(payload, bot);
    const issueArg = text.slice(`${prefix}issue`.length).trim();
    let issueRef = parseIssueReference(issueArg, replyContext);

    // Fallback: if issueArg is just a number (e.g. /issue 123) and target has exactly 1 subscription
    if (!issueRef && /^\d+$/.test(issueArg)) {
      const subs = listSubscriptions({
        type: messageType === "group" ? "group" : "private",
        id: targetId,
      });
      if (subs.length === 1) {
        const [owner, repo] = subs[0].repo.split("/");
        issueRef = { owner, repo, issueNumber: parseInt(issueArg, 10) };
      }
    }

    if (!issueRef) {
      await sendText(
        bot,
        messageType,
        targetId,
        `用法:\n${prefix}issue owner/repo 123\n${prefix}issue owner/repo#123\n${prefix}issue <issue-url>\n${prefix}issue <number> (单仓库群直接发送)\n或者直接回复一个 Issue 链接/卡片发送 ${prefix}issue`
      );
      return;
    }
    await handleIssueCommand(
      issueRef.owner,
      issueRef.repo,
      issueRef.issueNumber,
      targetId,
      messageType,
      bot
    );
    return;
  }

  const isDiffCmd = text.startsWith(`${prefix}diff`);
  const isDetailCmd = text.startsWith(`${prefix}detail`);
  if (isDiffCmd || isDetailCmd) {
    const cmdName = isDiffCmd ? "diff" : "detail";
    console.log(`[Message] Matches ${cmdName} command`);
    const replyContext = await getReplyContextText(payload, bot);
    const cmdArg = text.slice(`${prefix}${cmdName}`.length).trim();

    // 1. Try parsing PR reference from args or reply context
    let prRef = parsePullRequestReference(cmdArg, replyContext);

    // Fallback: if cmdArg is a number (e.g. /diff 123 or /diff #123) and target has exactly 1 subscription
    if (!prRef && (/^\d+$/.test(cmdArg) || /^#\d+$/.test(cmdArg))) {
      const subs = listSubscriptions({
        type: messageType === "group" ? "group" : "private",
        id: targetId,
      });
      if (subs.length === 1) {
        const [owner, repo] = subs[0].repo.split("/");
        const num = parseInt(cmdArg.replace(/^#/, ""), 10);
        prRef = { owner, repo, prNumber: num };
      }
    }

    if (prRef) {
      await handlePrDiffCommand(
        prRef.owner,
        prRef.repo,
        prRef.prNumber,
        targetId,
        messageType,
        bot
      );
      return;
    }

    // 2. Try parsing Commit reference from args or reply context
    let commitRef = parseCommitReference(cmdArg, replyContext);

    // Fallback: if cmdArg is a commit SHA (7-40 hex chars) and target has exactly 1 subscription
    if (!commitRef && /^[a-f0-9]{7,40}$/i.test(cmdArg)) {
      const subs = listSubscriptions({
        type: messageType === "group" ? "group" : "private",
        id: targetId,
      });
      if (subs.length === 1) {
        const [owner, repo] = subs[0].repo.split("/");
        commitRef = { owner, repo, commitSha: cmdArg };
      }
    }

    if (commitRef) {
      await handleCommitDiffCommand(
        commitRef.owner,
        commitRef.repo,
        commitRef.commitSha,
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
      `用法:\n` +
      `${prefix}diff <owner/repo> <PR编号>\n` +
      `${prefix}diff <PR链接>\n` +
      `${prefix}diff <PR编号>  (单仓库群直接发送)\n` +
      `${prefix}diff <owner/repo> <Commit哈希>\n` +
      `${prefix}diff <Commit链接>\n` +
      `或者直接引用回复一个 PR / Commit 卡片发送 ${prefix}diff`
    );
    return;
  }

  if (text.startsWith(`${prefix}commit`)) {
    console.log(`[Message] Matches commit command`);
    const replyContext = await getReplyContextText(payload, bot);
    const commitRef = parseCommitReference(
      text.slice(`${prefix}commit`.length).trim(),
      replyContext
    );
    if (!commitRef) {
      await sendText(
        bot,
        messageType,
        targetId,
        `用法:\n${prefix}commit owner/repo <sha>\n${prefix}commit owner/repo@<sha>\n${prefix}commit <commit-url>\n或者直接回复一个 Commit 链接/卡片发送 ${prefix}commit`
      );
      return;
    }
    await handleCommitSummaryCard(
      commitRef.owner,
      commitRef.repo,
      commitRef.commitSha,
      targetId,
      messageType,
      bot
    );
    return;
  }

  // Auto-parse Commit URL (before repo URL to avoid false matches)
  const commitUrlMatch = text.match(commitUrlRegex);
  if (
    commitUrlMatch &&
    !text.startsWith(prefix) &&
    canAutoParseRepoCard(messageType, targetId) &&
    canAutoReply(targetId)
  ) {
    await handleCommitSummaryCard(
      commitUrlMatch[1],
      cleanRepoName(commitUrlMatch[2]),
      commitUrlMatch[3],
      targetId,
      messageType,
      bot
    );
    return;
  }

  // Auto-parse PR URL (before repo URL to avoid false matches)
  const prUrlMatch = text.match(prUrlRegex);
  if (
    prUrlMatch &&
    !text.startsWith(prefix) &&
    canAutoParseRepoCard(messageType, targetId) &&
    canAutoReply(targetId)
  ) {
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
  if (
    issueUrlMatch &&
    !text.startsWith(prefix) &&
    canAutoParseRepoCard(messageType, targetId) &&
    canAutoReply(targetId)
  ) {
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
  if (
    urlMatch &&
    !text.startsWith(prefix) &&
    canAutoParseRepoCard(messageType, targetId) &&
    canAutoReply(targetId)
  ) {
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
  bot: IBotClient
): Promise<string> {
  const replyId = extractReplyMessageId(payload);
  if (!replyId) {
    return "";
  }

  // First check if we have metadata stored locally for this message
  if (typeof bot.getMessageMetadata === "function") {
    try {
      const metadata = bot.getMessageMetadata(replyId);
      if (metadata) {
        console.log(`[Message] Using stored metadata for msg ${replyId}: "${metadata.slice(0, 100)}..."`);
        return metadata;
      }
    } catch (e: any) {
      console.warn(`[Message] getMessageMetadata error for ${replyId}:`, e.message);
    }
  }

  // Fallback to fetching the message via API
  if (typeof bot.callApi === "function") {
    try {
      const paramId = !isNaN(Number(replyId)) ? Number(replyId) : replyId;
      const replyMsg = await bot.callApi("get_msg", { message_id: paramId });
      const extracted = extractMessageSearchText(replyMsg);
      console.log(`[Message] Extracted reply context from msg ${replyId}: "${extracted.slice(0, 100)}..."`);
      return extracted;
    } catch (e: any) {
      console.warn(`[Message] Failed to fetch replied message ${replyId}:`, e.message);
      return "";
    }
  }

  return "";
}

function extractReplyMessageId(payload: any): string | undefined {
  if (Array.isArray(payload.message)) {
    const replySeg = payload.message.find(
      (seg: any) => seg?.type === "reply" && (seg?.data?.id !== undefined || seg?.data?.message_seq !== undefined)
    );
    if (replySeg) {
      const id = replySeg.data?.id ?? replySeg.data?.message_seq;
      if (id !== undefined && id !== null && String(id).trim()) {
        return String(id).trim();
      }
    }
  }

  const raw = String(payload.raw_message || "");
  const match = raw.match(/\[CQ:reply,id=([^,\]]+)/i);
  return match?.[1]?.trim();
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

export function parseRepoReference(...sources: string[]): { owner: string; repo: string } | null {
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

export function parsePullRequestReference(
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

export function parseIssueReference(
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

export function parseCommitReference(
  ...sources: string[]
): { owner: string; repo: string; commitSha: string } | null {
  for (const source of sources) {
    const text = String(source || "").trim();
    if (!text) continue;

    const tagMatch = text.match(commitTagRegex);
    if (tagMatch) {
      const [owner, repo] = cleanRepoName(tagMatch[1]).split("/");
      const commitSha = tagMatch[2];
      if (owner && repo && commitSha) {
        return { owner, repo, commitSha };
      }
    }

    const urlMatch = text.match(commitUrlRegex);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: cleanRepoName(urlMatch[2]),
        commitSha: urlMatch[3],
      };
    }

    const atMatch = text.match(/\b([\w.-]+)\/([\w.-]+)@([a-f0-9]{7,40})\b/i);
    if (atMatch) {
      return {
        owner: atMatch[1],
        repo: cleanRepoName(atMatch[2]),
        commitSha: atMatch[3],
      };
    }

    const splitMatch = text.match(/\b([\w.-]+)\/([\w.-]+)\b\s+([a-f0-9]{7,40})\b/i);
    if (splitMatch) {
      return {
        owner: splitMatch[1],
        repo: cleanRepoName(splitMatch[2]),
        commitSha: splitMatch[3],
      };
    }
  }
  return null;
}

async function sendText(
  bot: IBotClient,
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

// Handle Help command (render full help card image with sharp, minimalist design)
async function handleHelpCommand(
  targetId: string,
  messageType: string,
  prefix: string,
  bot: IBotClient
): Promise<void> {
  const target = { type: messageType, id: targetId };
  const fallbackText = buildHelpMessage(prefix);

  try {
    const contentHtml = `
      <div class="section-title">
        <span>基础与状态</span>
        <span class="section-tag">通用</span>
      </div>
      <div class="cmd-grid">
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}status</span>
          </div>
          <div class="cmd-desc">查看服务运行时间、机器人连接状态与订阅统计</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}id</span>
            <span class="cmd-badge">/myid</span>
          </div>
          <div class="cmd-desc">查询当前群聊 ID（群 OpenID）与个人用户 ID</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}help</span>
          </div>
          <div class="cmd-desc">呼出此 GitHub QQ 推送指令手册卡片</div>
        </div>
      </div>

      <div class="section-title">
        <span>仓库订阅管理</span>
        <span class="section-tag admin">管理员 / Master</span>
      </div>
      <div class="cmd-grid">
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}github sub &lt;owner/repo&gt; [事件...]</span>
          </div>
          <div class="cmd-desc">为当前群订阅仓库（支持指定事件，默认全量）</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}github unsub &lt;owner/repo&gt;</span>
          </div>
          <div class="cmd-desc">取消订阅全部或指定事件通知</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}github list</span>
          </div>
          <div class="cmd-desc">查看当前群聊/私聊已绑定的所有仓库与事件</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}github on / off</span>
          </div>
          <div class="cmd-desc">一键开启或暂停本群的 GitHub 推送通知</div>
        </div>
      </div>

      <div class="section-title">
        <span>内容查询与详情卡片</span>
        <span class="section-tag">查询</span>
      </div>
      <div class="cmd-grid">
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}readme &lt;owner/repo | url&gt;</span>
          </div>
          <div class="cmd-desc">获取仓库 README 渲染长图（单仓库群可直接发）</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}pr &lt;repo&gt; &lt;num&gt; / &lt;num&gt;</span>
          </div>
          <div class="cmd-desc">查看 PR 详情卡片（单仓库群直接发编号，或引用回复）</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}issue &lt;repo&gt; &lt;num&gt; / &lt;num&gt;</span>
          </div>
          <div class="cmd-desc">查看 Issue 详情卡片（单仓库群直接发编号，或引用回复）</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}commit &lt;repo&gt; &lt;sha&gt;</span>
          </div>
          <div class="cmd-desc">查看 Commit 提交信息卡片（支持引用回复）</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">${escapeHtml(prefix)}diff &lt;repo&gt; &lt;num|sha&gt;</span>
            <span class="cmd-badge alias">别名 /detail</span>
          </div>
          <div class="cmd-desc">调取 PR 或 Commit 的彩色代码变动与 diff 长图</div>
        </div>
      </div>

      <div class="section-title">
        <span>快捷方式与自动识别</span>
        <span class="section-tag">快捷交互</span>
      </div>
      <div class="cmd-grid">
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">#&lt;number&gt;</span>
          </div>
          <div class="cmd-desc">单仓库绑定群直接发送例如 #123 快捷调出 Issue/PR</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">引用回复卡片</span>
          </div>
          <div class="cmd-desc">引用任意卡片发送 ${escapeHtml(prefix)}diff、${escapeHtml(prefix)}pr 查看更多详情</div>
        </div>
        <div class="cmd-item">
          <div class="cmd-left">
            <span class="cmd-syntax">链接自动识别</span>
          </div>
          <div class="cmd-desc">聊天中发送 GitHub 仓库 / PR / Issue / Commit 链接自动转卡片</div>
        </div>
      </div>
    `;

    const image = await renderTemplate(
      "help",
      {
        prefix,
        contentHtml,
      },
      { fullPage: true, width: 760 }
    );

    await bot.sendImageToTarget(target, image, fallbackText);
  } catch (e: any) {
    console.error("[Message] Failed to render help image card, falling back to text:", e.message);
    await bot.sendTextToTarget(target, fallbackText);
  }
}

async function handleRepoCard(
  owner: string,
  repoName: string,
  targetId: string,
  messageType: string,
  bot: IBotClient
) {
  try {
    const repo = await getRepo(owner, repoName);
    const timestamp = new Date(repo.updated_at).toLocaleString("zh-CN");

    const image = await renderTemplate("star", {
      repoFullName: repo.full_name,
      repoDescription: escapeHtml(repo.description || "没有描述"),
      avatarUrl: getAvatarUrl(repo.owner?.login, repo.owner?.avatar_url),
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
    if (e.status === 404) {
      await bot.sendTextToTarget(
        { type: messageType, id: targetId },
        `仓库 ${owner}/${repoName} 不存在或无权访问。`
      );
    } else if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
      await bot.sendTextToTarget(
        { type: messageType, id: targetId },
        "[GitHub API] 已达到限流，请在 WebUI 配置 Token 后重试。"
      );
    } else {
      await bot.sendTextToTarget(
        { type: messageType, id: targetId },
        `获取仓库 ${owner}/${repoName} 信息失败，请稍后再试。`
      );
    }
  }
}

async function handleReadmeCommand(
  owner: string,
  repoName: string,
  targetId: string,
  messageType: string,
  bot: IBotClient
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
    let errorMsg = "获取 README 失败，请稍后再试。";
    if (e.status === 404) {
      errorMsg = "该仓库没有 README 文件。";
    } else if (e.status === 403 && e.response?.headers?.["x-ratelimit-remaining"] === "0") {
      errorMsg = "[GitHub API] 已达到限流，请在 WebUI 配置 Token 后重试。";
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
  bot: IBotClient
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
          return `<span class="label" style="background: ${bg}33; color: #${l.color || "e6edf3"}; border-color: ${bg}55;">${escapeHtml(l.name)}</span>`;
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
        title: escapeHtml(pr.title || ""),
        number: pr.number,
        avatarUrl: getAvatarUrl(pr.user?.login, pr.user?.avatar_url),
        authorName: pr.user?.login || "unknown",
        actionText: "Pull Request details",
        timestamp,
        editInfo: "",
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
    await bot.sendTextToTarget(
      target,
      "获取 PR 信息失败，请检查仓库和编号是否正确。"
    );
  }
}

// Handle PR summary card (brief overview)
async function handlePrSummaryCard(
  owner: string,
  repoName: string,
  prNumber: number,
  targetId: string,
  messageType: string,
  bot: IBotClient
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
      title: escapeHtml(pr.title || ""),
      number: pr.number,
      avatarUrl: getAvatarUrl(pr.user?.login || "github"),
      authorName: pr.user?.login || "unknown",
      actionText: "Pull Request",
      timestamp,
      editInfo: "",
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
    await bot.sendTextToTarget(
      target,
      "获取 PR 信息失败，请检查仓库和编号是否正确。"
    );
  }
}

// Handle Issue full details command
async function handleIssueCommand(
  owner: string,
  repoName: string,
  issueNumber: number,
  targetId: string,
  messageType: string,
  bot: IBotClient
) {
  const target = { type: messageType, id: targetId };
  try {
    const { data: issue } = await getOctokit().issues.get({
      owner,
      repo: repoName,
      issue_number: issueNumber,
    });

    // If GitHub issue has a pull_request object, it is actually a PR
    if (issue.pull_request) {
      await handlePrCommand(owner, repoName, issueNumber, targetId, messageType, bot);
      return;
    }

    let badgeClass = "badge-issue-open";
    let eventLabel = "Issue Opened";

    if (issue.state === "closed") {
      badgeClass =
        issue.state_reason === "not_planned"
          ? "badge-pr-closed"
          : "badge-issue-closed";
      eventLabel =
        issue.state_reason === "not_planned"
          ? "Issue Closed (Not Planned)"
          : "Issue Closed";
    }

    let labelsHtml = "";
    if (issue.labels && issue.labels.length > 0) {
      const labelItems = issue.labels
        .map((l: any) => {
          const color = typeof l === "object" ? l.color : "";
          const name = typeof l === "object" ? l.name : String(l);
          const bg = color ? `#${color}` : "#30363d";
          return `<span class="label" style="background: ${bg}33; color: #${color || "e6edf3"}; border-color: ${bg}55;">${escapeHtml(name)}</span>`;
        })
        .join("");
      labelsHtml = `<div class="labels">${labelItems}</div>`;
    }

    const bodyHtml = markdownToHtml(issue.body || "", 50000);
    const timestamp = new Date(issue.created_at).toLocaleString("zh-CN");

    const image = await renderTemplate(
      "issue",
      {
        badgeClass,
        eventIcon: "",
        eventLabel,
        repoFullName: `${owner}/${repoName}`,
        title: escapeHtml(issue.title || ""),
        number: issue.number,
        avatarUrl: getAvatarUrl(issue.user?.login, issue.user?.avatar_url),
        authorName: issue.user?.login || "unknown",
        actionText: "Issue details",
        timestamp,
        editInfo: "",
        labelsHtml,
        bodyHtml,
        comments: issue.comments || 0,
        reactions: issue.reactions?.total_count || 0,
      },
      { fullPage: true }
    );

    await bot.sendImageToTarget(
      target,
      image,
      `[Issue] ${owner}/${repoName}#${issue.number}\n${issue.html_url}\n${issue.title}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch Issue for ${owner}/${repoName}#${issueNumber}:`, e.message);
    if (e.status === 404) {
      await bot.sendTextToTarget(
        target,
        `仓库 ${owner}/${repoName} 中未找到 #${issueNumber} 的 Issue 或 PR。`
      );
    } else {
      await bot.sendTextToTarget(
        target,
        "获取 Issue 信息失败，请检查仓库和编号是否正确。"
      );
    }
  }
}

// Handle Issue summary card (brief overview)
async function handleIssueSummaryCard(
  owner: string,
  repoName: string,
  issueNumber: number,
  targetId: string,
  messageType: string,
  bot: IBotClient
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
      title: escapeHtml(issue.title || ""),
      number: issue.number,
      avatarUrl: getAvatarUrl(issue.user?.login || "github"),
      authorName: issue.user?.login || "unknown",
      actionText: "Issue",
      timestamp,
      editInfo: "",
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
    await bot.sendTextToTarget(
      target,
      "获取 Issue 信息失败，请检查仓库和编号是否正确。"
    );
  }
}

// Handle PR diff command (show code changes/diff)
async function handlePrDiffCommand(
  owner: string,
  repoName: string,
  prNumber: number,
  targetId: string,
  messageType: string,
  bot: IBotClient
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
    let eventLabel = "PR Diff";

    if (pr.state === "closed") {
      if (pr.merged) {
        badgeClass = "badge-pr-merged";
        eventLabel = "PR Merged - Diff";
      } else {
        badgeClass = "badge-pr-closed";
        eventLabel = "PR Closed - Diff";
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

      const patch = file.patch || "";
      const diffHtml = renderGitHubDiffHtml(patch, 500);

      filesHtml += `
        <div style="margin: 12px 0; padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
          <div style="margin-bottom: 8px; font-family: monospace; font-size: 13px; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <span style="color: ${statusColor}; font-weight: bold;">${statusIcon}</span>
              <span style="color: #e6edf3; margin-left: 8px; font-weight: 500;">${escapeHtml(file.filename)}</span>
            </div>
            <span style="color: #8b949e; font-size: 11px;">
              <span style="color: #3fb950;">+${file.additions}</span>
              <span style="color: #f85149; margin-left: 4px;">-${file.deletions}</span>
            </span>
          </div>
          ${diffHtml || `<div style="color: #8b949e; font-style: italic; font-size: 11px; padding: 4px 8px;">（二进制文件或改动过大，未提供 diff）</div>`}
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

    const bodyHtml = prStats + (filesHtml || '<div style="color: #8b949e; padding: 10px;">无代码文件改动</div>');
    const timestamp = new Date(pr.created_at).toLocaleString("zh-CN");

    const image = await renderTemplate(
      "issue",
      {
        badgeClass,
        eventIcon: "",
        eventLabel,
        repoFullName: `${owner}/${repoName}`,
        title: escapeHtml(pr.title || ""),
        number: pr.number,
        avatarUrl: getAvatarUrl(pr.user?.login || "github"),
        authorName: pr.user?.login || "unknown",
        actionText: "代码变更详情 (Diff)",
        timestamp,
        editInfo: "",
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
      `[PR Diff] ${owner}/${repoName}#${pr.number}\n${pr.html_url}\n${pr.title}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch PR diff for ${owner}/${repoName}#${prNumber}:`, e.message);
    await bot.sendTextToTarget(
      target,
      "获取 PR 代码变更失败，请检查仓库和编号是否正确。"
    );
  }
}

// Backward-compatible alias
const handlePrDetailCommand = handlePrDiffCommand;

// Handle Commit diff command (show code changes/diff for commit)
async function handleCommitDiffCommand(
  owner: string,
  repoName: string,
  commitSha: string,
  targetId: string,
  messageType: string,
  bot: IBotClient
) {
  const target = { type: messageType, id: targetId };
  try {
    const octokit = getOctokit();
    const { data: commit } = await octokit.repos.getCommit({
      owner,
      repo: repoName,
      ref: commitSha,
    });

    const shortSha = commit.sha.substring(0, 7);
    const commitMsg = commit.commit?.message || "";
    const firstLine = commitMsg.split("\n")[0] || shortSha;
    const commitBody = commitMsg.slice(firstLine.length).trim();
    const authorLogin = commit.author?.login;
    const authorName = authorLogin || commit.commit?.author?.name || "unknown";
    const avatarUrl = getAvatarUrl(authorLogin, commit.author?.avatar_url);

    const files = commit.files || [];
    const displayFiles = files.slice(0, 10);
    let filesHtml = "";

    for (const file of displayFiles) {
      const statusColor =
        file.status === "added" ? "#3fb950" :
        file.status === "removed" ? "#f85149" :
        file.status === "modified" ? "#d29922" : "#8b949e";

      const statusIcon =
        file.status === "added" ? "+" :
        file.status === "removed" ? "-" :
        file.status === "modified" ? "M" : "•";

      const patch = file.patch || "";
      const diffHtml = renderGitHubDiffHtml(patch, 500);

      filesHtml += `
        <div style="margin: 12px 0; padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
          <div style="margin-bottom: 8px; font-family: monospace; font-size: 13px; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <span style="color: ${statusColor}; font-weight: bold;">${statusIcon}</span>
              <span style="color: #e6edf3; margin-left: 8px; font-weight: 500;">${escapeHtml(file.filename)}</span>
            </div>
            <span style="color: #8b949e; font-size: 11px;">
              <span style="color: #3fb950;">+${file.additions}</span>
              <span style="color: #f85149; margin-left: 4px;">-${file.deletions}</span>
            </span>
          </div>
          ${diffHtml || `<div style="color: #8b949e; font-style: italic; font-size: 11px; padding: 4px 8px;">（二进制文件或改动过大，未提供 diff）</div>`}
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

    const stats = commit.stats || { additions: 0, deletions: 0, total: 0 };
    const commitStats = `
      <div style="margin: 10px 0; padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
        <span style="color: #3fb950;">+${stats.additions} additions</span>
        <span style="color: #8b949e; margin: 0 10px;">|</span>
        <span style="color: #f85149;">-${stats.deletions} deletions</span>
        <span style="color: #8b949e; margin: 0 10px;">|</span>
        <span style="color: #e6edf3;">${files.length} files changed</span>
      </div>
    `;

    const commitBodyHtml = commitBody
      ? `<div style="margin: 10px 0; padding: 10px 12px; background: #161b22; border-radius: 6px; border: 1px solid #30363d; color: #adbac7; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">${escapeHtml(commitBody)}</div>`
      : "";

    const bodyHtml = commitStats + commitBodyHtml + (filesHtml || '<div style="color: #8b949e; padding: 10px;">无文件变更</div>');
    const timestamp = commit.commit?.author?.date
      ? new Date(commit.commit.author.date).toLocaleString("zh-CN")
      : "";

    const image = await renderTemplate(
      "comment",
      {
        badgeClass: "badge-push",
        eventLabel: "Commit Diff",
        repoFullName: `${owner}/${repoName}`,
        title: escapeHtml(firstLine),
        number: `@${shortSha}`,
        avatarUrl,
        authorName,
        actionText: "提交了代码变更 (Diff)",
        timestamp,
        editInfo: "",
        bodyHtml,
      },
      { fullPage: true }
    );

    await bot.sendImageToTarget(
      target,
      image,
      `[Commit Diff] ${owner}/${repoName}@${shortSha}\n${commit.html_url}\n${firstLine}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch Commit diff for ${owner}/${repoName}@${commitSha}:`, e.message);
    await bot.sendTextToTarget(
      target,
      "获取 Commit 代码变更失败，请检查仓库和 commit SHA 是否正确。"
    );
  }
}

// Handle Commit summary card
async function handleCommitSummaryCard(
  owner: string,
  repoName: string,
  commitSha: string,
  targetId: string,
  messageType: string,
  bot: IBotClient
) {
  const target = { type: messageType, id: targetId };
  try {
    const { data: commit } = await getOctokit().repos.getCommit({
      owner,
      repo: repoName,
      ref: commitSha,
    });

    const shortSha = commit.sha.substring(0, 7);
    const commitMsg = commit.commit?.message || "";
    const firstLine = commitMsg.split("\n")[0] || shortSha;
    const commitBody = commitMsg.slice(firstLine.length).trim();
    const authorLogin = commit.author?.login;
    const authorName = authorLogin || commit.commit?.author?.name || "unknown";
    const avatarUrl = getAvatarUrl(authorLogin, commit.author?.avatar_url);

    const commitItem = `
      <div class="commit-item">
        <span class="commit-sha">${shortSha}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="commit-message">${escapeHtml(firstLine)}</div>
          ${commitBody ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 4px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(commitBody)}</div>` : ""}
        </div>
        <span class="commit-author">${escapeHtml(authorName)}</span>
      </div>
    `;

    const statsHtml = `
      <div class="stats">
        <span class="stat-add">+${commit.stats?.additions || 0}</span>
        <span class="stat-del">-${commit.stats?.deletions || 0}</span>
      </div>
    `;

    const image = await renderTemplate("push", {
      repoFullName: `${owner}/${repoName}`,
      pusherName: authorName,
      avatarUrl,
      commitCount: 1,
      branch: shortSha,
      commitsHtml: commitItem,
      statsHtml,
      compareText: `${commit.files?.length || 0} files changed`,
    });

    await bot.sendImageToTarget(
      target,
      image,
      `[Commit] ${owner}/${repoName}@${shortSha}\n${commit.html_url}\n${firstLine}`
    );
  } catch (e: any) {
    console.error(`[Message] Failed to fetch Commit for ${owner}/${repoName}@${commitSha}:`, e.message);
    await bot.sendTextToTarget(
      target,
      "获取 Commit 信息失败，请检查仓库和 commit SHA 是否正确。"
    );
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

/**
 * Render GitHub-style colored diff HTML for PR patch lines.
 * Additions: Green (+), Deletions: Red (-), Hunks: Blue (@@)
 */
function renderGitHubDiffHtml(patch: string, maxLines: number = 500): string {
  if (!patch) return "";

  const lines = patch.split("\n");
  const displayLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;

  const renderedLines = displayLines.map((line) => {
    const escaped = escapeHtml(line);
    const content = escaped || "&nbsp;";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return `<div style="background: rgba(46, 160, 67, 0.15); color: #3fb950; padding: 1px 8px; border-left: 3px solid #3fb950; font-family: 'Consolas', 'Monaco', monospace;">${content}</div>`;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return `<div style="background: rgba(248, 81, 73, 0.15); color: #f85149; padding: 1px 8px; border-left: 3px solid #f85149; font-family: 'Consolas', 'Monaco', monospace;">${content}</div>`;
    }
    if (line.startsWith("@@")) {
      return `<div style="background: rgba(56, 139, 253, 0.15); color: #58a6ff; font-weight: bold; padding: 2px 8px; margin: 2px 0; font-family: 'Consolas', 'Monaco', monospace;">${content}</div>`;
    }
    return `<div style="color: #8b949e; padding: 1px 8px; border-left: 3px solid transparent; font-family: 'Consolas', 'Monaco', monospace;">${content}</div>`;
  });

  if (lines.length > maxLines) {
    renderedLines.push(
      `<div style="color: #6e7681; font-style: italic; padding: 4px 8px; background: #161b22; text-align: center; font-size: 11px;">... (省略 ${lines.length - maxLines} 行代码变动)</div>`
    );
  }

  return `
    <div style="margin-top: 8px; border-radius: 6px; overflow: hidden; background: #0d1117; border: 1px solid #30363d; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;">
      ${renderedLines.join("")}
    </div>
  `;
}
