import { renderTemplate, markdownToHtml } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";

export async function handlePullRequest(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const action = payload.action;
  if (!["opened", "closed", "reopened"].includes(action)) return;

  const pr = payload.pull_request;
  const repo = payload.repository;
  const sender = payload.sender;

  const subscribers = findSubscribers(repo.full_name, "pull_request");
  if (subscribers.length === 0) return;

  let badgeClass = "badge-pr-open";
  let eventLabel = "PR Opened";

  if (action === "closed") {
    if (pr.merged) {
      badgeClass = "badge-pr-merged";
      eventLabel = "PR Merged";
    } else {
      badgeClass = "badge-pr-closed";
      eventLabel = "PR Closed";
    }
  } else if (action === "reopened") {
    eventLabel = "PR Reopened";
  }

  const actionTextMap: Record<string, string> = {
    opened: "创建了 Pull Request",
    closed: pr.merged ? "合并了 Pull Request" : "关闭了 Pull Request",
    reopened: "重新打开了 Pull Request",
  };

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

  const bodyHtml = markdownToHtml(pr.body || "");
  const timestamp = new Date(pr.created_at).toLocaleString("zh-CN");

  const fallbackText =
    `[${eventLabel}] ${repo.full_name}#${pr.number}: ${pr.title}\n` +
    `作者: ${sender.login}\n` +
    `${pr.head?.label || ""} → ${pr.base?.label || ""}\n` +
    `链接: ${pr.html_url}`;

  try {
    const image = await renderTemplate("issue", {
      badgeClass,
      eventIcon: "",
      eventLabel,
      repoFullName: repo.full_name,
      title: pr.title,
      number: pr.number,
      avatarUrl: getAvatarUrl(sender.login),
      authorName: sender.login,
      actionText: actionTextMap[action] || action,
      timestamp,
      labelsHtml,
      bodyHtml: bodyHtml || '<span style="color: #8b949e;">没有描述</span>',
      comments: pr.comments || 0,
      reactions: pr.reactions?.total_count || 0,
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error("[Handler:PR] Render failed, sending text:", e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
