import { renderTemplate, markdownToHtml } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";

export async function handleIssues(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const action = payload.action;
  // Only handle opened, closed, reopened
  if (!["opened", "closed", "reopened"].includes(action)) return;

  const issue = payload.issue;
  const repo = payload.repository;
  const sender = payload.sender;

  const subscribers = findSubscribers(repo.full_name, "issues");
  if (subscribers.length === 0) return;

  // Determine badge style
  let badgeClass = "badge-issue-open";
  let eventLabel = "Issue Opened";

  if (action === "closed") {
    badgeClass = issue.state_reason === "not_planned"
      ? "badge-pr-closed"
      : "badge-issue-closed";
    eventLabel = "Issue Closed";
  } else if (action === "reopened") {
    eventLabel = "Issue Reopened";
  }

  const actionTextMap: Record<string, string> = {
    opened: "创建了 Issue",
    closed: "关闭了 Issue",
    reopened: "重新打开了 Issue",
  };

  // Labels HTML
  let labelsHtml = "";
  if (issue.labels && issue.labels.length > 0) {
    const labelItems = issue.labels
      .map((l: any) => {
        const bg = l.color ? `#${l.color}` : "#30363d";
        return `<span class="label" style="background: ${bg}33; color: #${l.color || 'e6edf3'}; border-color: ${bg}55;">${l.name}</span>`;
      })
      .join("");
    labelsHtml = `<div class="labels">${labelItems}</div>`;
  }

  const bodyHtml = markdownToHtml(issue.body || "");
  const timestamp = new Date(issue.created_at).toLocaleString("zh-CN");

  const fallbackText =
    `[${eventLabel}] ${repo.full_name}#${issue.number}: ${issue.title}\n` +
    `作者: ${sender.login}\n` +
    `链接: ${issue.html_url}`;

  try {
    const image = await renderTemplate("issue", {
      badgeClass,
      eventIcon: "",
      eventLabel,
      repoFullName: repo.full_name,
      title: issue.title,
      number: issue.number,
      avatarUrl: getAvatarUrl(sender.login),
      authorName: sender.login,
      actionText: actionTextMap[action] || action,
      timestamp,
      labelsHtml,
      bodyHtml: bodyHtml || '<span style="color: #8b949e;">没有描述</span>',
      comments: issue.comments || 0,
      reactions: issue.reactions?.total_count || 0,
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error("[Handler:Issues] Render failed, sending text:", e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
