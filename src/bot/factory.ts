import { AppConfig, BotInstanceConfig } from "../config";
import { IBotClient } from "./types";
import { OneBotClient } from "../onebot/client";
import { MilkyClient } from "../milky/client";
import { QQBotClient } from "../qqbot/client";

export function createBotInstance(botConfig: BotInstanceConfig): IBotClient {
  const protocol = botConfig.protocol || "onebot";
  const id = botConfig.id || "default";
  const name = botConfig.name || id;

  if (protocol === "milky") {
    const milkyCfg = botConfig.milky || {
      endpoint: "http://127.0.0.1:3000",
      access_token: "",
      command_prefix: "/",
      masters: [],
    };
    return new MilkyClient(milkyCfg, id, name);
  }

  if (protocol === "qqbot") {
    const qqbotCfg = botConfig.qqbot || {
      mode: "ws",
      app_id: "",
      app_secret: "",
      sandbox: false,
      webhook_path: "/qqbot/webhook",
      intents: 1 << 25,
      command_prefix: "/",
      masters: [],
    };
    return new QQBotClient(qqbotCfg, id, name);
  }

  const onebotCfg = botConfig.onebot || {
    ws_url: "ws://127.0.0.1:3001",
    access_token: "",
    command_prefix: "/",
    masters: [],
  };
  return new OneBotClient(onebotCfg, id, name);
}

export function createBotClient(config: AppConfig): IBotClient {
  if (config.bots && config.bots.length > 0) {
    return createBotInstance(config.bots[0]);
  }

  const protocol = config.protocol || "onebot";
  if (protocol === "milky") {
    const milkyCfg = config.milky || {
      endpoint: "http://127.0.0.1:3000",
      access_token: "",
      command_prefix: "/",
      masters: [],
    };
    return new MilkyClient(milkyCfg, "milky", "Milky");
  }

  if (protocol === "qqbot") {
    const qqbotCfg = config.qqbot || {
      mode: "ws",
      app_id: "",
      app_secret: "",
      sandbox: false,
      webhook_path: "/qqbot/webhook",
      intents: 1 << 25,
      command_prefix: "/",
      masters: [],
    };
    return new QQBotClient(qqbotCfg, "qqbot", "QQBot");
  }

  return new OneBotClient(config.onebot, "default", "OneBot");
}
