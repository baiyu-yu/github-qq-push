import { AppConfig } from "../config";
import { IBotClient } from "./types";
import { OneBotClient } from "../onebot/client";
import { MilkyClient } from "../milky/client";

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

  return new OneBotClient(config.onebot);
}
