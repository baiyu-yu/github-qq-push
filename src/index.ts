import express from "express";
import * as path from "path";
import * as crypto from "crypto";
import { loadConfig, getConfig } from "./config";
import { initState } from "./state";
import { IBotClient } from "./bot/types";
import { createBotClient } from "./bot/factory";
import { BotManager } from "./bot/manager";
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
    // Exempt static files, health check, webhooks, and auth check/login endpoints
    const path = req.path;
    if (
      path === "/" ||
      path === "/index.html" ||
      path.startsWith("/icon.") ||
      path === "/health" ||
      path === "/webhook" ||
      path.startsWith("/qqbot/") ||
      path === "/api/auth/status" ||
      path === "/api/auth/login"
    ) {
      return next();
    }

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

    // Return JSON 401 without WWW-Authenticate header to prevent browser native dialog
    res.status(401).json({ success: false, error: "Unauthorized", authRequired: true });
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

  // 4. Create and connect Bot Manager (Multi-instance concurrent bots)
  const botManager = new BotManager(config.bots);
  botManager.setMessageHandler(async (msg, clientBot) => {
    await handleMessage(msg, clientBot);
  });
  botManager.connect();

  // 5. Create and start webhook server (also serves WebUI)
  const webhookServer = new GitHubWebhookServer();

  const updateBotWebhookRouting = () => {
    webhookServer.onQQBotWebhook(async (req, res) => {
      const pathParts = req.path.split("/").filter(Boolean);
      let targetBotId: string | undefined;
      if (pathParts[0] === "qqbot" && pathParts[1] === "webhook" && pathParts[2]) {
        targetBotId = pathParts[2];
      }
      if (!targetBotId && req.query.bot) {
        targetBotId = String(req.query.bot);
      }

      const allBots = botManager.getAllBots().filter((b) => b.protocol === "qqbot");
      if (allBots.length === 0) {
        return res.status(503).json({ error: "No active QQBot instances" });
      }

      if (targetBotId) {
        const targetBot = botManager.getBot(targetBotId);
        // @ts-ignore
        if (targetBot && typeof targetBot.handleWebhookRequest === "function") {
          // @ts-ignore
          return targetBot.handleWebhookRequest(req, res);
        }
        return res.status(404).json({ error: `QQBot instance ${targetBotId} not found` });
      }

      if (allBots.length === 1) {
        // @ts-ignore
        return allBots[0].handleWebhookRequest(req, res);
      }

      // Match by payload app_id
      try {
        const bodyBuf = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));
        const json = JSON.parse(bodyBuf.toString("utf8"));
        const appId = json.d?.bot_appid || json.d?.app_id || json.app_id;
        if (appId) {
          const matched = botManager.getAllConfigs().find(
            (c) => c.protocol === "qqbot" && c.qqbot?.app_id === String(appId)
          );
          if (matched) {
            const client = botManager.getBot(matched.id);
            // @ts-ignore
            if (client && typeof client.handleWebhookRequest === "function") {
              // @ts-ignore
              return client.handleWebhookRequest(req, res);
            }
          }
        }
      } catch (e) {}

      // Fallback: first active QQBot
      // @ts-ignore
      return allBots[0].handleWebhookRequest(req, res);
    });
  };
  updateBotWebhookRouting();

  // Attach WebUI routes and static files to the same Express app
  // @ts-ignore - access private app field since it's an internal server
  const app = webhookServer["app"];
  // Protect everything except the webhook/health endpoints (registered above).
  app.use(requireWebUIAuth());
  app.use(express.json());

  webhookServer.onEvent(async (event, payload) => {
    await routeEvent(event, payload, botManager);
  });

  // 6. Start event poller if enabled
  const poller = new GitHubEventPoller(botManager);

  app.use(
    getWebUIRouter({
      bot: botManager,
      botManager,
      poller,
      webhookServer,
    })
  );
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
  console.log(`[Main] Active Bot Instances: ${botManager.getAllBots().length}`);
  for (const b of botManager.getAllConfigs()) {
    console.log(`  - [${b.protocol.toUpperCase()}] ${b.name} (${b.id}) [${b.enabled !== false ? '已启用' : '已停用'}]`);
  }
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
    botManager.disconnect();
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
