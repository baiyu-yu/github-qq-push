import { OneBotClient } from "../onebot/client";
import { handleIssues } from "./issues";
import { handlePullRequest } from "./pull_request";
import { handlePush } from "./push";
import { handleRelease } from "./release";
import { handleStar } from "./star";
import { handleFork } from "./fork";
import { handleComment } from "./comment";
import {
  getEventFingerprint,
  isEventProcessed,
  markEventProcessed,
  deleteProcessedEvent,
} from "../github/dedup";

/**
 * Route GitHub webhook events to their handlers.
 */
export async function routeEvent(
  event: string,
  payload: any,
  bot: OneBotClient
): Promise<void> {
  const repoName = payload.repository?.full_name || "unknown";

  // Check event fingerprint for deduplication
  const fingerprint = getEventFingerprint(event, payload);
  if (fingerprint) {
    if (isEventProcessed(fingerprint)) {
      console.log(`[Router] Duplicate event ignored (fingerprint: ${fingerprint})`);
      return;
    }
    markEventProcessed(fingerprint);
  }

  try {
    console.log(
      `[Router] Routing event: ${event}${payload.action ? `/${payload.action}` : ""} from ${repoName}`
    );

    switch (event) {
      case "issues":
        await handleIssues(payload, bot);
        break;

      case "pull_request":
        await handlePullRequest(payload, bot);
        break;

      case "push":
        await handlePush(payload, bot);
        break;

      case "release":
        await handleRelease(payload, bot);
        break;

      case "star":
      case "watch":
        await handleStar(payload, bot);
        break;

      case "fork":
        await handleFork(payload, bot);
        break;

      case "issue_comment":
      case "commit_comment":
      case "pull_request_review":
      case "pull_request_review_comment":
        await handleComment(event, payload, bot);
        break;

      case "ping":
        console.log(
          `[Router] Ping received from ${repoName}: ${payload.zen || ""}`
        );
        break;

      default:
        console.log(
          `[Router] Unhandled event: ${event}${payload.action ? `/${payload.action}` : ""}`
        );
        break;
    }
  } catch (e) {
    // Roll back the dedup mark so a transient failure does not swallow the
    // event until the 30-minute TTL expires (poller will retry on next round).
    if (fingerprint) {
      deleteProcessedEvent(fingerprint);
      console.warn(
        `[Router] Event failed, removed dedup mark (fingerprint: ${fingerprint})`
      );
    }
    throw e;
  }
}
