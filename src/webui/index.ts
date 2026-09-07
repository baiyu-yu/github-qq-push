import { Router } from "express";
import * as crypto from "crypto";
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

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

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

  // Auth status endpoint
  router.get("/api/auth/status", (req, res) => {
    const cfg = getConfig().webui || { username: "admin", password: "" };
    const authRequired = Boolean(cfg.password);
    let authenticated = !authRequired;

    if (authRequired) {
      const header = req.headers.authorization || "";
      const [scheme, cred] = header.split(" ");
      if (scheme === "Basic" && cred) {
        const decoded = Buffer.from(cred, "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        const user = idx >= 0 ? decoded.slice(0, idx) : "";
        const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
        if (user === (cfg.username || "admin") && safeEqualStrings(pass, cfg.password || "")) {
          authenticated = true;
        }
      }
    }

    res.json({
      authRequired,
      authenticated,
      username: authenticated ? (cfg.username || "admin") : undefined,
    });
  });

  // Login handler
  router.post("/api/auth/login", (req, res) => {
    const cfg = getConfig().webui || { username: "admin", password: "" };
    const expectedUser = cfg.username || "admin";
    const expectedPass = cfg.password || "";
    const { username, password } = req.body || {};

    if (!expectedPass || (username === expectedUser && safeEqualStrings(password || "", expectedPass))) {
      const token = Buffer.from(`${expectedUser}:${expectedPass}`).toString("base64");
      res.json({
        success: true,
        token,
        username: expectedUser,
      });
    } else {
      res.status(401).json({
        success: false,
        error: "用户名或密码错误",
      });
    }
  });

  // Logout handler
  router.post("/api/auth/logout", (req, res) => {
    res.json({ success: true });
  });

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
      const proto = (newConfig.protocol || "onebot") as
        | "onebot"
        | "milky"
        | "qqbot";

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
          (!newConfig.milky || typeof newConfig.milky.endpoint !== "string")) ||
        (proto === "qqbot" &&
          (!newConfig.qqbot ||
            typeof newConfig.qqbot.app_id !== "string" ||
            typeof newConfig.qqbot.app_secret !== "string"))
      ) {
        let errorMsg = "配置结构不完整。";
        if (proto === "milky") {
          errorMsg =
            "配置结构不完整：需要 milky.endpoint 和 github.webhook_port。";
        } else if (proto === "qqbot") {
          errorMsg =
            "配置结构不完整：需要 qqbot.app_id、qqbot.app_secret 和 github.webhook_port。";
        } else {
          errorMsg =
            "配置结构不完整：需要 onebot.ws_url 和 github.webhook_port。";
        }
        res.status(400).json({
          success: false,
          error: errorMsg,
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

      if (newConfig.qqbot) {
        newConfig.qqbot.mode =
          newConfig.qqbot.mode === "webhook" ? "webhook" : "ws";
        newConfig.qqbot.sandbox = !!newConfig.qqbot.sandbox;
        newConfig.qqbot.webhook_path =
          newConfig.qqbot.webhook_path || "/qqbot/webhook";
        newConfig.qqbot.command_prefix =
          newConfig.qqbot.command_prefix || "/";
        newConfig.qqbot.masters = Array.isArray(newConfig.qqbot.masters)
          ? newConfig.qqbot.masters
          : [];
      }

      const oldConfig = getConfig();
      const oldProto = (oldConfig.protocol || "onebot") as
        | "onebot"
        | "milky"
        | "qqbot";
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
        if (proto === "milky") {
          currentBot.updateConfig(newConfig.milky);
        } else if (proto === "qqbot") {
          currentBot.updateConfig(newConfig.qqbot);
        } else {
          currentBot.updateConfig(newConfig.onebot);
        }
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
    const proto = currentBot
      ? currentBot.protocol
      : getConfig().protocol || "onebot";
    const qqbotMode =
      proto === "qqbot" ? getConfig().qqbot?.mode || "ws" : undefined;
    res.json({
      status: "running",
      uptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      protocol: proto,
      qqbotMode,
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
