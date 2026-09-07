import { Router } from "express";
import { getConfig } from "../config";
import { getState, saveConfig } from "../state";
import { IBotClient } from "../bot/types";
import { createBotClient } from "../bot/factory";
import { handleMessage } from "../handlers/message";
import { getLogs } from "../logger";
import { serviceStartTime } from "../utils";
import { initGitHubApi } from "../github/api";
import { GitHubEventPoller } from "../github/poller";
import { GitHubWebhookServer } from "../github/webhook";

export interface WebUIDeps {
  bot?: IBotClient;
  getBot?: () => IBotClient;
  setBot?: (bot: IBotClient) => void;
  poller: GitHubEventPoller;
  webhookServer: GitHubWebhookServer;
}

export function getWebUIRouter(deps: WebUIDeps) {
  const router = Router();
  let localBot = deps.bot;
  const getCurrentBot = (): IBotClient | undefined =>
    deps.getBot ? deps.getBot() : localBot;
  const setCurrentBot = (b: IBotClient) => {
    if (deps.setBot) {
      deps.setBot(b);
    } else {
      localBot = b;
    }
  };

  // Get whole config
  router.get("/api/config", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      config: getConfig(),
      state: getState(),
    });
  });

  // Update configuration
  router.post("/api/config", async (req, res) => {
    try {
      const newConfig = req.body;
      const proto = (newConfig.protocol || "onebot") as "onebot" | "milky";

      // Validate the essential shape BEFORE writing to disk, so a malformed
      // request cannot corrupt config.json.
      if (
        !newConfig ||
        typeof newConfig !== "object" ||
        !newConfig.github ||
        typeof newConfig.github.webhook_port !== "number" ||
        (proto === "onebot" &&
          (!newConfig.onebot || typeof newConfig.onebot.ws_url !== "string")) ||
        (proto === "milky" &&
          (!newConfig.milky || typeof newConfig.milky.endpoint !== "string"))
      ) {
        res.status(400).json({
          success: false,
          error:
            proto === "milky"
              ? "配置结构不完整：需要 milky.endpoint 和 github.webhook_port。"
              : "配置结构不完整：需要 onebot.ws_url 和 github.webhook_port。",
        });
        return;
      }

      // Normalize optional sections to prevent undefined access later
      newConfig.subscriptions = Array.isArray(newConfig.subscriptions)
        ? newConfig.subscriptions
        : [];
      newConfig.webui = newConfig.webui || { username: "admin", password: "" };
      newConfig.render = newConfig.render || {
        image_quality: 90,
        max_height: 8000,
        theme: "dark",
        concurrency: 2,
        max_queue_size: 50,
        max_screenshot_height: 30000,
      };
      if (
        newConfig.render.concurrency === undefined ||
        Number.isNaN(Number(newConfig.render.concurrency))
      ) {
        newConfig.render.concurrency = 2;
      }
      if (
        newConfig.render.max_queue_size === undefined ||
        Number.isNaN(Number(newConfig.render.max_queue_size))
      ) {
        newConfig.render.max_queue_size = 50;
      }
      if (
        newConfig.render.max_screenshot_height === undefined ||
        Number.isNaN(Number(newConfig.render.max_screenshot_height))
      ) {
        newConfig.render.max_screenshot_height = 30000;
      }
      newConfig.github.access_tokens = Array.isArray(
        newConfig.github.access_tokens
      )
        ? newConfig.github.access_tokens
        : newConfig.github.access_token
          ? [newConfig.github.access_token]
          : [];

      const oldConfig = getConfig();
      const oldProto = (oldConfig.protocol || "onebot") as "onebot" | "milky";
      const oldGithub = oldConfig.github;
      const oldPollingEnabled = oldGithub.polling_enabled !== false;
      const oldPollingInterval = oldGithub.polling_interval || 60;
      const oldPort = oldGithub.webhook_port;

      saveConfig(newConfig);

      // Re-initialize GitHub API to apply new tokens dynamically
      initGitHubApi(newConfig.github);

      // Handle Bot client update or hot-swap protocol
      const currentBot = getCurrentBot();
      if (proto !== oldProto) {
        console.log(`[WebUI] Switching bot protocol from ${oldProto} to ${proto}...`);
        if (currentBot) {
          currentBot.disconnect();
        }
        const newBot = createBotClient(newConfig);
        newBot.onMessageCallback = async (msg) => {
          await handleMessage(msg, newBot);
        };
        newBot.connect();
        setCurrentBot(newBot);
        if (deps.poller) {
          deps.poller.updateBot(newBot);
        }
      } else if (currentBot) {
        currentBot.updateConfig(
          proto === "milky" ? newConfig.milky : newConfig.onebot
        );
      }

      const newPollingEnabled = newConfig.github?.polling_enabled !== false;
      const newPollingInterval = newConfig.github?.polling_interval || 60;
      const newPort = newConfig.github?.webhook_port;

      const pollingChanged =
        oldPollingEnabled !== newPollingEnabled ||
        oldPollingInterval !== newPollingInterval;
      const portChanged = oldPort !== newPort;

      if (pollingChanged && deps.poller) {
        deps.poller.restart();
      }

      if (portChanged && deps.webhookServer) {
        deps.webhookServer.restart();
      }

      res.json({
        success: true,
        restartRequired: { polling: pollingChanged, port: portChanged },
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get("/api/status", (req, res) => {
    const currentBot = getCurrentBot();
    const botState = currentBot ? currentBot.getConnectionState() : null;
    res.json({
      status: "running",
      uptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      protocol: currentBot ? currentBot.protocol : (getConfig().protocol || "onebot"),
      botInfo: currentBot ? currentBot.getBotInfo() : null,
      subscriptionsCount: getConfig().subscriptions.length,
      disabledGroupsCount: Object.values(getState().groupStates).filter(
        (s) => s.disabled
      ).length,
      botState,
      onebotState: botState, // backward compatibility
    });
  });

  // Get logs
  router.get("/api/logs", (req, res) => {
    const level = req.query.level as string;
    let logs = getLogs();
    if (level && level !== "ALL") {
      logs = logs.filter((l) => l.level === level);
    }
    res.json(logs);
  });

  // Get groups
  router.get("/api/groups", async (req, res) => {
    try {
      const currentBot = getCurrentBot();
      if (!currentBot) {
        return res.json([]);
      }
      const groups = await currentBot.callApi("get_group_list");
      res.json(groups || []);
    } catch (e: any) {
      console.warn("[WebUI] Failed to fetch group list:", e.message);
      res.json([]);
    }
  });

  // Force reconnect
  router.post("/api/reconnect", (req, res) => {
    const currentBot = getCurrentBot();
    if (currentBot) {
      currentBot.forceReconnect();
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: "Bot not initialized" });
    }
  });

  // Stop manual reconnect
  router.post("/api/stop", (req, res) => {
    const currentBot = getCurrentBot();
    if (currentBot) {
      currentBot.stopReconnect();
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: "Bot not initialized" });
    }
  });

  return router;
}
