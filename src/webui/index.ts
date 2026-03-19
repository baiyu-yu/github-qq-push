import { Router } from "express";
import { getConfig } from "../config";
import { getState, saveConfig } from "../state";
import { OneBotClient } from "../onebot/client";
import { getLogs } from "../logger";
import { serviceStartTime } from "../utils";
import { initGitHubApi } from "../github/api";

export function getWebUIRouter(bot: OneBotClient) {
  const router = Router();

  // Get whole config
  router.get("/api/config", (req, res) => {
    res.json({
      config: getConfig(),
      state: getState(),
    });
  });

  // Update configuration
  router.post("/api/config", async (req, res) => {
    try {
      const newConfig = req.body;
      saveConfig(newConfig);
      
      // Re-initialize GitHub API to apply new tokens dynamically
      initGitHubApi(newConfig.github);
      
      // Update bot if ws_url changed or reconnect is needed
      if (bot) {
        bot.updateConfig(newConfig.onebot);
      }
      res.json({ success: true });
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
