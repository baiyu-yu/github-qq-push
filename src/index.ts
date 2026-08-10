import express from "express";
import * as path from "path";
import * as crypto from "crypto";
import { loadConfig, getConfig } from "./config";
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

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Consume equal time even on length mismatch
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Protect the WebUI/API (everything except /webhook and /health) with HTTP
 * Basic auth using config.webui.{username,password}. The webhook endpoint
 * stays unauthenticated because it is validated via HMAC signatures.
 */
function requireWebUIAuth(): express.RequestHandler {
  let warned = false;
  return (req, res, next) => {
    const cfg = getConfig().webui || { username: "admin", password: "" };
    const username = cfg.username || "admin";
    const password = cfg.password || "";

    if (!password) {
      if (!warned) {
        console.warn(
          "[WebUI] 未设置 webui.password，管理面板不受保护！请在 WebUI 或 config.json 中设置。"
        );
        warned = true;
      }
      return next();
    }

    const header = req.headers.authorization || "";
    const [scheme, cred] = header.split(" ");
    let ok = false;
    if (scheme === "Basic" && cred) {
      const decoded = Buffer.from(cred, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : "";
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      ok = user === username && safeEqualStrings(pass, password);
    }

    if (ok) return next();

    res.setHeader("WWW-Authenticate", 'Basic realm="GitHub QQ Push"');
    res.status(401).send("Unauthorized");
  };
}

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
  const webhookServer = new GitHubWebhookServer();

  // Attach WebUI routes and static files to the same Express app
  // @ts-ignore - access private app field since it's an internal server
  const app = webhookServer["app"];
  // Protect everything except the webhook/health endpoints (registered above).
  app.use(requireWebUIAuth());
  app.use(express.json());

  webhookServer.onEvent(async (event, payload) => {
    await routeEvent(event, payload, bot);
  });

  // 6. Start event poller if enabled
  const poller = new GitHubEventPoller(bot);

  app.use(getWebUIRouter({ bot, poller, webhookServer }));
  app.use(express.static(path.resolve(process.cwd(), "public")));

  webhookServer.start();

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
    poller.stop();
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
