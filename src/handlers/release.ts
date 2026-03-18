import { renderTemplate, markdownToHtml } from "../renderer";
import { getAvatarUrl } from "../github/api";
import { findSubscribers } from "../config";
import { OneBotClient } from "../onebot/client";

export async function handleRelease(
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const action = payload.action;
  if (action !== "published") return;

  const release = payload.release;
  const repo = payload.repository;
  const sender = payload.sender;

  const subscribers = findSubscribers(repo.full_name, "release");
  if (subscribers.length === 0) return;

  const bodyHtml = markdownToHtml(release.body || "");
  const timestamp = new Date(release.published_at || release.created_at).toLocaleString("zh-CN");
  const assetsCount = release.assets ? release.assets.length : 0;
  const assetsText = assetsCount > 0 ? `${assetsCount} 个附件` : "无附件";

  const fallbackText =
    `[Release] ${repo.full_name} ${release.tag_name}\n` +
    `${release.name || release.tag_name}\n` +
    `作者: ${sender.login}\n` +
    `链接: ${release.html_url}`;

  try {
    const image = await renderTemplate("release", {
      repoFullName: repo.full_name,
      releaseName: release.name || release.tag_name,
      avatarUrl: getAvatarUrl(sender.login),
      authorName: sender.login,
      timestamp,
      tagName: release.tag_name,
      bodyHtml: bodyHtml || '<span style="color: #8b949e;">没有释出说明</span>',
      assetsText,
    });

    for (const target of subscribers) {
      await bot.sendImageToTarget(target, image, fallbackText);
    }
  } catch (e) {
    console.error("[Handler:Release] Render failed, sending text:", e);
    for (const target of subscribers) {
      await bot.sendTextToTarget(target, fallbackText);
    }
  }
}
