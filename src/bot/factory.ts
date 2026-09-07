import { AppConfig } from "../config";
import { IBotClient } from "./types";
import { OneBotClient } from "../onebot/client";
import { MilkyClient } from "../milky/client";
import { QQBotClient } from "../qqbot/client";

export function createBotClient(config: AppConfig): IBotClient {
  const protocol = config.protocol || "onebot";
  if (protocol === "milky") {
    const milkyCfg = config.milky || {
      endpoint: "http://127.0.0.1:3000",
      access_token: "",
      command_prefix: "/",
      masters: [],
    };
    return new MilkyClient(milkyCfg);
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
    return new QQBotClient(qqbotCfg);
  }

  return new OneBotClient(config.onebot);
}

