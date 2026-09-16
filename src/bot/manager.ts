import { BotInstanceConfig, BotProtocol } from "../config";
import { IBotClient, BotInfo, BotConnectionState, SendMessageOptions } from "./types";
import { createBotInstance } from "./factory";

export class BotManager implements IBotClient {
  public readonly id = "bot-manager";
  public readonly name = "Bot Manager";
  public readonly protocol = "onebot" as const;

  private bots = new Map<string, IBotClient>();
  private botConfigs = new Map<string, BotInstanceConfig>();
  private messageHandler: ((msg: any, bot: IBotClient) => Promise<void>) | null = null;

  public onMessageCallback: ((msg: any) => Promise<void>) | null = null;

  constructor(bots?: BotInstanceConfig[]) {
    if (bots) {
      for (const cfg of bots) {
        this.addBot(cfg, false);
      }
    }
  }

  public setMessageHandler(handler: (msg: any, bot: IBotClient) => Promise<void>) {
    this.messageHandler = handler;
    for (const [_, bot] of this.bots) {
      bot.onMessageCallback = async (msg) => {
        if (this.messageHandler) {
          await this.messageHandler(msg, bot);
        }
      };
    }
  }

  public getBot(id: string): IBotClient | undefined {
    return this.bots.get(id);
  }

  public getAllBots(): IBotClient[] {
    return Array.from(this.bots.values());
  }

  public getAllConfigs(): BotInstanceConfig[] {
    return Array.from(this.botConfigs.values());
  }

  public addBot(cfg: BotInstanceConfig, autoConnect = true): IBotClient {
    if (this.bots.has(cfg.id)) {
      this.removeBot(cfg.id);
    }

    this.botConfigs.set(cfg.id, { ...cfg });
    const bot = createBotInstance(cfg);
    bot.onMessageCallback = async (msg) => {
      if (this.messageHandler) {
        await this.messageHandler(msg, bot);
      } else if (this.onMessageCallback) {
        await this.onMessageCallback(msg);
      }
    };

    this.bots.set(cfg.id, bot);

    if (autoConnect && cfg.enabled !== false) {
      console.log(`[BotManager] Connecting bot instance "${cfg.name}" (${cfg.id}, ${cfg.protocol})...`);
      bot.connect();
    }

    return bot;
  }

  public updateBot(cfg: BotInstanceConfig): void {
    const existing = this.bots.get(cfg.id);
    this.botConfigs.set(cfg.id, { ...cfg });

    if (!existing) {
      this.addBot(cfg, true);
      return;
    }

    // If protocol changed, recreate
    const oldProtocol = existing.protocol;
    if (oldProtocol !== cfg.protocol) {
      console.log(
        `[BotManager] Bot "${cfg.id}" protocol changed (${oldProtocol} -> ${cfg.protocol}). Recreating...`
      );
      this.removeBot(cfg.id);
      this.addBot(cfg, true);
      return;
    }

    if (cfg.name) {
      (existing as any).name = cfg.name;
    }

    if (cfg.enabled === false) {
      console.log(`[BotManager] Bot "${cfg.id}" is disabled. Disconnecting...`);
      existing.disconnect();
      return;
    }

    // Update inner config
    if (cfg.protocol === "onebot" && cfg.onebot) {
      existing.updateConfig(cfg.onebot);
    } else if (cfg.protocol === "milky" && cfg.milky) {
      existing.updateConfig(cfg.milky);
    } else if (cfg.protocol === "qqbot" && cfg.qqbot) {
      existing.updateConfig(cfg.qqbot);
    }

    const state = existing.getConnectionState();
    if (!state.connected && !state.stopped) {
      existing.connect();
    }
  }

  public removeBot(id: string): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;

    console.log(`[BotManager] Removing bot instance "${id}"...`);
    try {
      bot.disconnect();
    } catch (e: any) {
      console.error(`[BotManager] Error disconnecting bot "${id}":`, e.message);
    }

    this.bots.delete(id);
    this.botConfigs.delete(id);
    return true;
  }

  public reconnectBot(id: string): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    bot.forceReconnect();
    return true;
  }

  public stopBot(id: string): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    bot.stopReconnect();
    return true;
  }

  public connect(): void {
    for (const [id, bot] of this.bots) {
      const cfg = this.botConfigs.get(id);
      if (cfg?.enabled !== false) {
        console.log(`[BotManager] Connecting bot "${bot.name}" (${id})...`);
        bot.connect();
      }
    }
  }

  public disconnect(): void {
    for (const [id, bot] of this.bots) {
      console.log(`[BotManager] Disconnecting bot "${bot.name}" (${id})...`);
      bot.disconnect();
    }
  }

  public forceReconnect(): void {
    for (const [_, bot] of this.bots) {
      bot.forceReconnect();
    }
  }

  public stopReconnect(): void {
    for (const [_, bot] of this.bots) {
      bot.stopReconnect();
    }
  }

  public getConnectionState(): BotConnectionState {
    const states = Array.from(this.bots.values()).map((b) => b.getConnectionState());
    const anyConnected = states.some((s) => s.connected);
    const allStopped = states.length > 0 && states.every((s) => s.stopped);
    return {
      connected: anyConnected,
      stopped: allStopped,
      attempts: states.reduce((max, s) => Math.max(max, s.attempts), 0),
      maxAttempts: 5,
    };
  }

  public getBotInfo(): BotInfo | null {
    for (const bot of this.bots.values()) {
      const info = bot.getBotInfo();
      if (info) return info;
    }
    return null;
  }

  public updateConfig(newConfig: any): void {
    // No-op on manager level
  }

  public getBotStates(): Array<{
    id: string;
    name: string;
    protocol: BotProtocol;
    enabled: boolean;
    state: BotConnectionState;
    info: BotInfo | null;
  }> {
    return Array.from(this.bots.entries()).map(([id, bot]) => {
      const cfg = this.botConfigs.get(id);
      return {
        id,
        name: bot.name,
        protocol: bot.protocol,
        enabled: cfg?.enabled !== false,
        state: bot.getConnectionState(),
        info: bot.getBotInfo(),
      };
    });
  }

  // --- Dispatching to Targets ---

  public async sendImageToTarget(
    target: { type: string; id: string; botId?: string },
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (target.botId) {
      const targetBot = this.bots.get(target.botId);
      if (targetBot) {
        await targetBot.sendImageToTarget(target, imageBase64, fallbackText, options);
      } else {
        console.warn(
          `[BotManager] Bot "${target.botId}" not found or inactive for target ${target.type}:${target.id}. Skipping.`
        );
      }
      return;
    }

    // No botId specified: broadcast to all connected bots
    let sent = false;
    for (const bot of this.bots.values()) {
      try {
        await bot.sendImageToTarget(target, imageBase64, fallbackText, options);
        sent = true;
      } catch (e: any) {
        console.warn(`[BotManager] Broadcast sendImageToTarget error on bot ${bot.id}:`, e.message);
      }
    }
    if (!sent && this.bots.size > 0) {
      console.warn(`[BotManager] Failed to send image to target ${target.type}:${target.id} on any bot`);
    }
  }

  public async sendTextToTarget(
    target: { type: string; id: string; botId?: string },
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (target.botId) {
      const targetBot = this.bots.get(target.botId);
      if (targetBot) {
        await targetBot.sendTextToTarget(target, text, options);
      } else {
        console.warn(
          `[BotManager] Bot "${target.botId}" not found or inactive for target ${target.type}:${target.id}. Skipping.`
        );
      }
      return;
    }

    // No botId specified: send to all connected bots
    for (const bot of this.bots.values()) {
      try {
        await bot.sendTextToTarget(target, text, options);
      } catch (e: any) {
        console.warn(`[BotManager] Broadcast sendTextToTarget error on bot ${bot.id}:`, e.message);
      }
    }
  }

  public async sendGroupImage(
    groupId: string,
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    for (const bot of this.bots.values()) {
      await bot.sendGroupImage(groupId, imageBase64, fallbackText, options);
    }
  }

  public async sendGroupText(
    groupId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    for (const bot of this.bots.values()) {
      await bot.sendGroupText(groupId, text, options);
    }
  }

  public async sendPrivateImage(
    userId: string,
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    for (const bot of this.bots.values()) {
      await bot.sendPrivateImage(userId, imageBase64, fallbackText, options);
    }
  }

  public async sendPrivateText(
    userId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    for (const bot of this.bots.values()) {
      await bot.sendPrivateText(userId, text, options);
    }
  }

  public getMessageMetadata(messageId: string): string | undefined {
    for (const bot of this.bots.values()) {
      const meta = bot.getMessageMetadata(messageId);
      if (meta) return meta;
    }
    return undefined;
  }

  public storeMessageMetadata(messageId: string, metadata: string): void {
    for (const bot of this.bots.values()) {
      bot.storeMessageMetadata(messageId, metadata);
    }
  }

  public async callApi(action: string, params?: Record<string, any>): Promise<any> {
    for (const bot of this.bots.values()) {
      try {
        return await bot.callApi(action, params);
      } catch (e) {
        // Try next bot
      }
    }
    throw new Error("No bot available to handle callApi: " + action);
  }
}
