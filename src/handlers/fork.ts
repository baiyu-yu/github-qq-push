import { renderTemplate } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";

export async function handleFork(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const repo = payload.repository;
  const forkee = payload.forkee;
  const sender = payload.sender;

  const subscribers = findSubscribers(repo.full_name, "fork");
  if (subscribers.length === 0) return;

  const timestamp = new Date().toLocaleString("zh-CN");

  const fallbackText =
    `[Fork] ${sender.login} forked ${repo.full_name}\n` +
    `→ ${forkee.full_name}\n` +
    `Fork: ${repo.forks_count}`;

  try {
    const image = await renderTemplate("fork", {
      repoFullName: repo.full_name,
      forkFullName: forkee.full_name,
      avatarUrl: getAvatarUrl(sender.login),
      senderName: sender.login,
      timestamp,
      forksCount: repo.forks_count || 0,
      starsCount: repo.stargazers_count || 0,
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error("[Handler:Fork] Render failed, sending text:", e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
