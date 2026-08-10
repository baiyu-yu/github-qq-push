import { renderTemplate } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";
import { escapeHtml } from "../utils";

export async function handleStar(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const action = payload.action;
  // Webhook "watch" events send action "started"; the Events API (polling)
  // is normalized to "created". Accept both so stars are not silently dropped.
  if (action !== "created" && action !== "started") return;

  const repo = payload.repository;
  const sender = payload.sender;

  const subscribers = findSubscribers(repo.full_name, "star");
  if (subscribers.length === 0) return;

  const timestamp = payload.created_at
    ? new Date(payload.created_at).toLocaleString("zh-CN")
    : new Date().toLocaleString("zh-CN");

  const fallbackText =
    `[Star] ${sender.login} starred ${repo.full_name}\n` +
    `Star: ${repo.stargazers_count}`;

  try {
    const image = await renderTemplate("star", {
      repoFullName: repo.full_name,
      repoDescription: escapeHtml(repo.description || "没有描述"),
      avatarUrl: getAvatarUrl(sender.login),
      senderName: sender.login,
      actionText: "starred 了仓库",
      timestamp,
      starCount: repo.stargazers_count,
      language: escapeHtml(repo.language || "未知"),
      forksCount: repo.forks_count || 0,
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error("[Handler:Star] Render failed, sending text:", e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
