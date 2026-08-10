import { renderTemplate, markdownToHtml } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";
import { escapeHtml } from "../utils";

export async function handleIssues(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const action = payload.action;
  // Only handle opened, closed, reopened, edited
  if (!["opened", "closed", "reopened", "edited"].includes(action)) return;

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
  } else if (action === "edited") {
    eventLabel = "Issue Edited";
  }

  const actionTextMap: Record<string, string> = {
    opened: "创建了 Issue",
    closed: "关闭了 Issue",
    reopened: "重新打开了 Issue",
    edited: "编辑了 Issue",
  };

  // Title/body change context for edited events
  let editNotes: string[] = [];
  if (action === "edited") {
    const changes = payload.changes || {};
    if (
      changes.title &&
      changes.title.from !== undefined &&
      changes.title.from !== issue.title
    ) {
      editNotes.push(`标题：${changes.title.from} → ${issue.title}`);
    }
    if (changes.body) {
      editNotes.push("正文已修改");
    }
  }
  let editInfo = "";
  if (editNotes.length > 0) {
    editInfo = `<div class="edit-info">${editNotes
      .map(escapeHtml)
      .join("<br>")}</div>`;
  }

  // Labels HTML
  let labelsHtml = "";
  if (issue.labels && issue.labels.length > 0) {
    const labelItems = issue.labels
      .map((l: any) => {
        const bg = l.color ? `#${l.color}` : "#30363d";
        return `<span class="label" style="background: ${bg}33; color: #${l.color || 'e6edf3'}; border-color: ${bg}55;">${escapeHtml(l.name)}</span>`;
      })
      .join("");
    labelsHtml = `<div class="labels">${labelItems}</div>`;
  }

  const bodyHtml = markdownToHtml(issue.body || "");
  const timestamp = new Date(
    issue.updated_at || issue.created_at
  ).toLocaleString("zh-CN");

  const editText =
    editNotes.length > 0 ? `\n修改: ${editNotes.join("；")}` : "";
  const fallbackText =
    `[${eventLabel}] ${repo.full_name}#${issue.number}: ${issue.title}\n` +
    `作者: ${sender.login} ${actionTextMap[action] || action}\n` +
    `链接: ${issue.html_url}` + editText;

  try {
    const image = await renderTemplate("issue", {
      badgeClass,
      eventIcon: "",
      eventLabel,
      repoFullName: repo.full_name,
      title: escapeHtml(issue.title || ""),
      number: issue.number,
      avatarUrl: getAvatarUrl(sender.login),
      authorName: sender.login,
      actionText: actionTextMap[action] || action,
      timestamp,
      labelsHtml,
      editInfo,
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
