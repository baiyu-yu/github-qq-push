import express from "express";
import * as path from "path";
import { loadConfig } from "./config";
import { initState } from "./state";
import { OneBotClient } from "./onebot/client";
import { GitHubWebhookServer } from "./github/webhook";
import { initGitHubApi } from "./github/api";
import { GitHubEventPoller } from "./github/poller";
import { initRenderer, closeRenderer } from "./renderer";
import { routeEvent } from "./handlers";
import { handleMessage } from "./handlers/message";
import { getWebUIRouter } from "./webui";
import { initLogger } from "./logger";
import { serviceStartTime } from "./utils";

async function main() {
  initLogger();
  console.log("=== GitHub QQ Push Service ===");
  console.log();

  // 1. Load configuration and state
  const config = loadConfig();
  initState();

  // 2. Initialize GitHub API client
  initGitHubApi(config.github);

  // 3. Initialize renderer (Puppeteer)
  console.log("[Main] Initializing renderer...");
  await initRenderer();

  // 4. Create and connect OneBot client
  const bot = new OneBotClient(config.onebot);
  bot.onMessageCallback = async (msg) => {
    await handleMessage(msg, bot);
  };
  bot.connect();

  // 5. Create and start webhook server (also serves WebUI)
  const webhookServer = new GitHubWebhookServer(config.github);
  
  // Attach WebUI routes and static files to the same Express app
  // @ts-ignore - access private app field since it's an internal server
  const app = webhookServer["app"];
  app.use(express.json());
  app.use(getWebUIRouter(bot));
  app.use(express.static(path.resolve(process.cwd(), "public")));

  webhookServer.onEvent(async (event, payload) => {
    await routeEvent(event, payload, bot);
  });
  webhookServer.start();

  // 6. Start event poller if enabled
  const poller = new GitHubEventPoller(bot);
  if (config.github.polling_enabled !== false) {
    await poller.start();
  }

  console.log();
  console.log("[Main] Service is running!");
  console.log(
    `[Main] Webhook: http://0.0.0.0:${config.github.webhook_port}/webhook`
  );
  console.log(
    `[Main] WebUI Control Panel: http://localhost:${config.github.webhook_port}/`
  );
  console.log(`[Main] OneBot WS: ${config.onebot.ws_url}`);
  console.log(
    `[Main] Subscriptions: ${config.subscriptions.length} repo(s) configured`
  );
  console.log(
    `[Main] Polling: ${config.github.polling_enabled !== false ? `enabled (${config.github.polling_interval || 60}s)` : "disabled"}`
  );
  console.log();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Main] Shutting down...");
    bot.disconnect();
    await closeRenderer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
