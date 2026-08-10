import { Router } from "express";
import { getConfig } from "../config";
import { getState, saveConfig } from "../state";
import { OneBotClient } from "../onebot/client";
import { getLogs } from "../logger";
import { serviceStartTime } from "../utils";
import { initGitHubApi } from "../github/api";
import { GitHubEventPoller } from "../github/poller";
import { GitHubWebhookServer } from "../github/webhook";

export interface WebUIDeps {
  bot: OneBotClient;
  poller: GitHubEventPoller;
  webhookServer: GitHubWebhookServer;
}

export function getWebUIRouter({ bot, poller, webhookServer }: WebUIDeps) {
  const router = Router();

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

      // Validate the essential shape BEFORE writing to disk, so a malformed
      // request cannot corrupt config.json.
      if (
        !newConfig ||
        typeof newConfig !== "object" ||
        !newConfig.onebot ||
        typeof newConfig.onebot.ws_url !== "string" ||
        !newConfig.github ||
        typeof newConfig.github.webhook_port !== "number"
      ) {
        res.status(400).json({
          success: false,
          error: "配置结构不完整：需要 onebot.ws_url 和 github.webhook_port。",
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
      };
      newConfig.github.access_tokens = Array.isArray(
        newConfig.github.access_tokens
      )
        ? newConfig.github.access_tokens
        : newConfig.github.access_token
          ? [newConfig.github.access_token]
          : [];

      const oldGithub = getConfig().github;
      const oldPollingEnabled = oldGithub.polling_enabled !== false;
      const oldPollingInterval = oldGithub.polling_interval || 60;
      const oldPort = oldGithub.webhook_port;

      saveConfig(newConfig);

      // Re-initialize GitHub API to apply new tokens dynamically
      initGitHubApi(newConfig.github);

      // Update bot if ws_url changed or reconnect is needed
      if (bot) {
        bot.updateConfig(newConfig.onebot);
      }

      const newPollingEnabled = newConfig.github?.polling_enabled !== false;
      const newPollingInterval = newConfig.github?.polling_interval || 60;
      const newPort = newConfig.github?.webhook_port;

      const pollingChanged =
        oldPollingEnabled !== newPollingEnabled ||
        oldPollingInterval !== newPollingInterval;
      const portChanged = oldPort !== newPort;

      if (pollingChanged && poller) {
        poller.restart();
      }

      if (portChanged && webhookServer) {
        webhookServer.restart();
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
    res.json({
      status: "running",
      uptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      botInfo: bot ? bot.getBotInfo() : null,
      subscriptionsCount: getConfig().subscriptions.length,
      disabledGroupsCount: Object.values(getState().groupStates).filter(
        (s) => s.disabled
      ).length,
      onebotState: bot ? bot.getConnectionState() : null
    });
  });

  // Get logs
  router.get("/api/logs", (req, res) => {
    const level = req.query.level as string;
    let logs = getLogs();
    if (level && level !== "ALL") {
      logs = logs.filter(l => l.level === level);
    }
    res.json(logs);
  });

  // Get groups
  router.get("/api/groups", async (req, res) => {
    try {
      if (!bot) {
        return res.json([]);
      }
      const groups = await bot.callApi("get_group_list");
      res.json(groups || []);
    } catch (e: any) {
      console.warn("[WebUI] Failed to fetch group list:", e.message);
      res.json([]);
    }
  });

  // Force reconnect
  router.post("/api/reconnect", (req, res) => {
    if (bot) {
      bot.forceReconnect();
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: "Bot not initialized" });
    }
  });

  // Stop manual reconnect
  router.post("/api/stop", (req, res) => {
    if (bot) {
      bot.stopReconnect();
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: "Bot not initialized" });
    }
  });

  return router;
}
