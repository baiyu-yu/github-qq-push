import { OneBotClient } from "../onebot/client";
import { handleIssues } from "./issues";
import { handlePullRequest } from "./pull_request";
import { handlePush } from "./push";
import { handleRelease } from "./release";
import { handleStar } from "./star";
import { handleFork } from "./fork";

/**
 * Route GitHub webhook events to their handlers.
 */
export async function routeEvent(
  event: string,
  payload: any,
  bot: OneBotClient
): Promise<void> {
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

    case "ping":
      console.log(
        `[Router] Ping received from ${payload.repository?.full_name || "unknown"}: ${payload.zen || ""}`
      );
      break;

    default:
      console.log(
        `[Router] Unhandled event: ${event}${payload.action ? `/${payload.action}` : ""}`
      );
      break;
  }
}
