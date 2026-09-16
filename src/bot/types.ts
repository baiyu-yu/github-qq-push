export interface BotInfo {
  nickname: string;
  user_id: number | string;
}

export interface BotConnectionState {
  connected: boolean;
  stopped: boolean;
  attempts: number;
  maxAttempts: number;
}

export interface SendMessageOptions {
  /**
   * The message ID being replied to (for passive messages in QQ Bot API v2).
   * If omitted, the message is sent as an active proactive message.
   */
  msgId?: string;
  /**
   * Reply sequence number (1, 2, ...).
   * If omitted in QQBotClient, it will be automatically tracked and incremented per msgId.
   */
  msgSeq?: number;
}

export interface IBotClient {
  readonly id: string;
  readonly name: string;
  readonly protocol: "onebot" | "milky" | "qqbot";
  
  connect(): void;
  disconnect(): void;
  forceReconnect(): void;
  stopReconnect(): void;
  getConnectionState(): BotConnectionState;
  getBotInfo(): BotInfo | null;
  updateConfig(newConfig: any): void;

  sendGroupImage(
    groupId: string,
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void>;
  sendGroupText(
    groupId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void>;
  sendPrivateImage(
    userId: string,
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void>;
  sendPrivateText(
    userId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void>;

  sendImageToTarget(
    target: { type: string; id: string; botId?: string },
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void>;
  sendTextToTarget(
    target: { type: string; id: string; botId?: string },
    text: string,
    options?: SendMessageOptions
  ): Promise<void>;

  getMessageMetadata(messageId: string): string | undefined;
  storeMessageMetadata(messageId: string, metadata: string): void;

  callApi(action: string, params?: Record<string, any>): Promise<any>;

  onMessageCallback: ((msg: any) => Promise<void>) | null;
}
