import { renderTemplate } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";
import { escapeHtml } from "../utils";

export async function handlePush(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const repo = payload.repository;
  const sender = payload.sender;
  const commits = payload.commits || [];

  // Ignore empty pushes (e.g., branch deletion)
  if (commits.length === 0) return;

  const subscribers = findSubscribers(repo.full_name, "push");
  if (subscribers.length === 0) return;

  // Extract branch from ref (refs/heads/main -> main)
  const branch = (payload.ref || "").replace("refs/heads/", "");

  // Build commits HTML (show max 8 commits)
  const displayCommits = commits.slice(0, 8);
  const commitsHtml = displayCommits
    .map((c: any) => {
      const sha = c.id.substring(0, 7);
      const message = escapeHtml(c.message.split("\n")[0]); // first line only
      const author = c.author?.username || c.author?.name || "unknown";
      return `<div class="commit-item">
        <span class="commit-sha">${sha}</span>
        <span class="commit-message">${message}</span>
        <span class="commit-author">${author}</span>
      </div>`;
    })
    .join("");

  const moreCommits =
    commits.length > 8
      ? `<div class="commit-item" style="color: #8b949e; justify-content: center;">... 还有 ${commits.length - 8} 个提交</div>`
      : "";

  // Stats (aggregate additions/deletions from commits)
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalModified = 0;
  for (const c of commits) {
    totalAdded += (c.added || []).length;
    totalRemoved += (c.removed || []).length;
    totalModified += (c.modified || []).length;
  }

  const statsHtml =
    totalAdded + totalRemoved + totalModified > 0
      ? `<div class="stats">
          <span class="stat"><span class="stat-icon stat-add">+</span> ${totalAdded} 新增</span>
          <span class="stat"><span class="stat-icon stat-del">−</span> ${totalRemoved} 删除</span>
          <span class="stat"><span class="stat-icon stat-files">⚡</span> ${totalModified} 修改</span>
        </div>`
      : "";

  const compareUrl = payload.compare || "";
  const compareText = compareUrl ? `查看完整对比 →` : "";

  const fallbackText =
    `[Push] ${repo.full_name}:${branch}\n` +
    `推送者: ${sender.login}\n` +
    `提交数: ${commits.length}\n` +
    displayCommits
      .map((c: any) => `  ${c.id.substring(0, 7)} ${c.message.split("\n")[0]}`)
      .join("\n") +
    (compareUrl ? `\n对比: ${compareUrl}` : "");

  try {
    const image = await renderTemplate("push", {
      repoFullName: repo.full_name,
      avatarUrl: getAvatarUrl(sender.login),
      pusherName: sender.login,
      commitCount: commits.length,
      branch,
      commitsHtml: commitsHtml + moreCommits,
      statsHtml,
      compareText,
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error("[Handler:Push] Render failed, sending text:", e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
