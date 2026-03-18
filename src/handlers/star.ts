import { renderTemplate } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";

export async function handleStar(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const action = payload.action;
  // Only handle "created" (starred). Optionally also "deleted" (unstarred)
  if (action !== "created") return;

  const repo = payload.repository;
  const sender = payload.sender;

  const subscribers = findSubscribers(repo.full_name, "star");
  if (subscribers.length === 0) return;

  const timestamp = new Date().toLocaleString("zh-CN");

  const fallbackText =
    `[Star] ${sender.login} starred ${repo.full_name}\n` +
    `Star: ${repo.stargazers_count}`;

  try {
    const image = await renderTemplate("star", {
      repoFullName: repo.full_name,
      repoDescription: repo.description || "没有描述",
      avatarUrl: getAvatarUrl(sender.login),
      senderName: sender.login,
      actionText: "starred 了仓库",
      timestamp,
      starCount: repo.stargazers_count,
      language: repo.language || "未知",
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
