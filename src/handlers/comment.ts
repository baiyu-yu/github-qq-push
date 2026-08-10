import { renderTemplate, markdownToHtml } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";
import { escapeHtml } from "../utils";

/**
 * Unified handler for comment-related events:
 * - issue_comment
 * - commit_comment
 * - pull_request_review
 * - pull_request_review_comment
 */
export async function handleComment(
  eventType: string,
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const repo = payload.repository;
  const sender = payload.sender;

  if (!repo || !sender) {
    console.warn(`[Handler:Comment] Missing repo or sender in payload for ${eventType}`);
    return;
  }

  const subscribers = findSubscribers(repo.full_name, eventType);
  if (subscribers.length === 0) return;

  let badgeClass = "badge-issue-open";
  let eventLabel = "";
  let title = "";
  let number: number | string = "";
  let commentBody = "";
  let actionText = "";
  let timestamp = "";
  let url = "";
  let editNotes: string[] = [];

  switch (eventType) {
    case "issue_comment": {
      const action = payload.action;
      if (!["created", "edited"].includes(action)) return;

      const issue = payload.issue;
      const comment = payload.comment;
      if (!issue || !comment) return;

      const isPR = !!issue.pull_request;
      badgeClass = isPR ? "badge-pr-open" : "badge-issue-open";
      eventLabel = isPR ? "PR Comment" : "Issue Comment";
      title = issue.title;
      number = issue.number;
      commentBody = comment.body || "";
      actionText = action === "created" ? "评论了" : "编辑了评论";
      timestamp = new Date(
        comment.updated_at || comment.created_at
      ).toLocaleString("zh-CN");
      url = comment.html_url || issue.html_url || "";
      if (action === "edited" && payload.changes?.body) {
        editNotes.push("评论已修改");
      }
      break;
    }

    case "commit_comment": {
      const action = payload.action;
      if (!["created", "edited"].includes(action)) return;

      const comment = payload.comment;
      if (!comment) return;

      badgeClass = "badge-pr-merged";
      eventLabel = "Commit Comment";
      const commitId = comment.commit_id || "";
      title = `Commit ${commitId.substring(0, 7)}`;
      number = "";
      commentBody = comment.body || "";
      actionText =
        action === "created" ? "评论了 Commit" : "编辑了 Commit 评论";
      timestamp = new Date(
        comment.updated_at || comment.created_at
      ).toLocaleString("zh-CN");
      url = comment.html_url || "";
      if (action === "edited" && payload.changes?.body) {
        editNotes.push("评论已修改");
      }
      break;
    }

    case "pull_request_review": {
      const action = payload.action;
      if (action !== "submitted") return;

      const pr = payload.pull_request;
      const review = payload.review;
      if (!pr || !review) return;

      // Skip reviews with no body (approval-only)
      if (!review.body && review.state === "approved") {
        // Still notify for approvals, but with a default message
        commentBody = "✅ Approved this pull request";
      } else {
        commentBody = review.body || "";
      }

      const stateMap: Record<string, string> = {
        approved: "badge-pr-merged",
        changes_requested: "badge-pr-closed",
        commented: "badge-pr-open",
      };
      badgeClass = stateMap[review.state] || "badge-pr-open";

      const labelMap: Record<string, string> = {
        approved: "PR Approved",
        changes_requested: "PR Changes Requested",
        commented: "PR Review",
      };
      eventLabel = labelMap[review.state] || "PR Review";
      title = pr.title;
      number = pr.number;

      const actionMap: Record<string, string> = {
        approved: "批准了 Pull Request",
        changes_requested: "请求修改 Pull Request",
        commented: "审查了 Pull Request",
      };
      actionText = actionMap[review.state] || "审查了 Pull Request";
      timestamp = new Date(review.submitted_at || review.created_at).toLocaleString("zh-CN");
      url = review.html_url || pr.html_url || "";
      break;
    }

    case "pull_request_review_comment": {
      const action = payload.action;
      if (!["created", "edited"].includes(action)) return;

      const pr = payload.pull_request;
      const comment = payload.comment;
      if (!pr || !comment) return;

      badgeClass = "badge-pr-open";
      eventLabel = "PR Review Comment";
      title = pr.title;
      number = pr.number;

      // Include file path context if available
      const filePath = comment.path ? `\`${comment.path}\`\n\n` : "";
      commentBody = filePath + (comment.body || "");
      actionText =
        action === "created" ? "在代码审查中评论了" : "编辑了审查评论";
      timestamp = new Date(
        comment.updated_at || comment.created_at
      ).toLocaleString("zh-CN");
      url = comment.html_url || pr.html_url || "";
      if (action === "edited" && payload.changes?.body) {
        editNotes.push("评论已修改");
      }
      break;
    }

    default:
      console.warn(`[Handler:Comment] Unknown comment event type: ${eventType}`);
      return;
  }

  const bodyHtml = markdownToHtml(commentBody);
  const numberStr = number ? `#${number}` : "";

  let editInfo = "";
  if (editNotes.length > 0) {
    editInfo = `<div class="edit-info">${editNotes
      .map(escapeHtml)
      .join("<br>")}</div>`;
  }
  const editText =
    editNotes.length > 0 ? `\n修改: ${editNotes.join("；")}` : "";
  const fallbackText =
    `[${eventLabel}] ${repo.full_name}${numberStr ? ` ${numberStr}` : ""}: ${title}\n` +
    `${sender.login} ${actionText}\n` +
    (url ? `链接: ${url}` : "") + editText;

  try {
    const image = await renderTemplate("comment", {
      badgeClass,
      eventLabel,
      repoFullName: repo.full_name,
      title: escapeHtml(title || ""),
      number: numberStr,
      avatarUrl: getAvatarUrl(sender.login),
      authorName: sender.login,
      actionText,
      timestamp,
      editInfo,
      bodyHtml: bodyHtml || '<span style="color: #8b949e;">没有内容</span>',
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error(`[Handler:Comment] Render failed for ${eventType}, sending text:`, e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
