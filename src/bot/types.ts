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

export interface IBotClient {
  readonly protocol: "onebot" | "milky";
  
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
    fallbackText?: string
  ): Promise<void>;
  sendGroupText(groupId: string, text: string): Promise<void>;
  sendPrivateImage(
    userId: string,
    imageBase64: string,
    fallbackText?: string
  ): Promise<void>;
  sendPrivateText(userId: string, text: string): Promise<void>;

  sendImageToTarget(
    target: { type: string; id: string },
    imageBase64: string,
    fallbackText?: string
  ): Promise<void>;
  sendTextToTarget(
    target: { type: string; id: string },
    text: string
  ): Promise<void>;

  getMessageMetadata(messageId: string): string | undefined;
  storeMessageMetadata(messageId: string, metadata: string): void;

  callApi(action: string, params?: Record<string, any>): Promise<any>;

  onMessageCallback: ((msg: any) => Promise<void>) | null;
}
