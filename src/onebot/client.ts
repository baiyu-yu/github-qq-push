import WebSocket from "ws";
import { OneBotConfig } from "../config";

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OneBotClient {
  private ws: WebSocket | null = null;
  private config: OneBotConfig;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;
  private maxReconnectDelay = 60000;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isShuttingDown = false;
  private isManuallyStopped = false;
  private botInfo: { nickname: string; user_id: number } | null = null;
  
  private pingInterval: ReturnType<typeof setTimeout> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000;
  private readonly PONG_TIMEOUT = 10000;
  
  private messageMetadata = new Map<string, string>();
  private readonly MAX_METADATA_SIZE = 1000; 
  
  public onMessageCallback: ((msg: any) => Promise<void>) | null = null;

  constructor(config: OneBotConfig) {
    this.config = {...config}; // Copy to avoid reference issues
  }

  public updateConfig(newConfig: OneBotConfig) {
    const urlChanged =
      this.config.ws_url !== newConfig.ws_url ||
      this.config.access_token !== newConfig.access_token;
    this.config = { ...newConfig };

    if (urlChanged) {
      console.log(
        `[OneBot] Configuration changed. Reconnecting to ${newConfig.ws_url}...`
      );
      this.disconnect();
      setTimeout(() => {
        this.forceReconnect();
      }, 500);
    }
  }

  public forceReconnect() {
    this.isShuttingDown = false;
    this.isManuallyStopped = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 3000;
    console.log("[OneBot] Manual reconnect triggered.");
    this.connect();
  }

  public disconnect() {
    this.isManuallyStopped = true;
    this.botInfo = null;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    for (const [id, req] of this.pendingRequests.entries()) {
      req.reject(new Error("WebSocket disconnected"));
    }
    this.pendingRequests.clear();
  }

  public stopReconnect() {
    this.isManuallyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log("[OneBot] Reconnection manually stopped.");
  }

  public getBotInfo() {
    return this.botInfo;
  }

  private storeMessageMetadata(messageId: string, metadata: string) {
    this.messageMetadata.set(messageId, metadata);
    
    if (this.messageMetadata.size > this.MAX_METADATA_SIZE) {
      const firstKey = this.messageMetadata.keys().next().value;
      if (firstKey) this.messageMetadata.delete(firstKey);
    }
  }

  public getMessageMetadata(messageId: string): string | undefined {
    return this.messageMetadata.get(messageId);
  }

  public connect(): void {
    if (this.isShuttingDown) return;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    const url = this.config.access_token
      ? `${this.config.ws_url}?access_token=${this.config.access_token}`
      : this.config.ws_url;

    console.log(`[OneBot] Connecting to ${this.config.ws_url}...`);
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[OneBot] WebSocket connected!");
      this.reconnectDelay = 3000;
      this.reconnectAttempts = 0; // reset on successful connection
      
      this.callApi("get_login_info")
        .then((data) => {
          this.botInfo = data;
          console.log(`[OneBot] Logged in as ${data.nickname} (${data.user_id})`);
        })
        .catch((e) => {
          console.warn("[OneBot] Failed to get login info:", e.message);
        });

      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        console.error("[OneBot] Failed to parse message:", e);
      }
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "No reason provided";
      console.warn(
        `[OneBot] WebSocket closed. Code: ${code}, Reason: ${reasonStr}`
      );
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[OneBot] WebSocket error:", err.message);
      if (err.stack) console.debug(err.stack);
    });

    this.ws.on("pong", () => {
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.pongTimeout = setTimeout(() => {
          console.warn("[OneBot] Heartbeat timeout. Closing connection.");
          if (this.ws) this.ws.terminate();
        }, this.PONG_TIMEOUT);
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.isManuallyStopped) return;
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[OneBot] Reached maximum reconnect attempts (${this.maxReconnectAttempts}). Connection stopped.`);
      this.isManuallyStopped = true;
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `[OneBot] Reconnecting in ${this.reconnectDelay / 1000}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );
    if (!this.isShuttingDown) {
      // Attempt to reconnect using exponential backoff
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 1.5,
          this.maxReconnectDelay
        );
        this.connect();
      }, this.reconnectDelay);
    }
  }

  public getConnectionState() {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      stopped: this.isManuallyStopped,
      attempts: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts
    };
  }

  private handleMessage(msg: any): void {
    // API response
    if (msg.echo !== undefined) {
      const echo = String(msg.echo);
      const pending = this.pendingRequests.get(echo);
      if (pending) {
        this.pendingRequests.delete(echo);
        clearTimeout(pending.timer);
        if (msg.status === "ok" || msg.retcode === 0) {
          pending.resolve(msg.data);
        } else {
          pending.reject(
            new Error(
              `OneBot API error: ${msg.message || msg.wording || JSON.stringify(msg)}`
            )
          );
        }
      }
      return;
    }

    // Events (heartbeat, lifecycle, etc.) - log meta events at debug level
    if (msg.post_type === "meta_event") {
      // silently ignore heartbeats
      return;
    }

    if (msg.post_type) {
      if (msg.post_type !== "meta_event" && msg.post_type !== "message") {
        console.log(
          `[OneBot] Event: ${msg.post_type}/${msg.sub_type || msg[msg.post_type + "_type"] || ""}`
        );
      }
      if (msg.post_type === "message" && this.onMessageCallback) {
        let preview = msg.raw_message || "";
        if (preview.length > 50) preview = preview.substring(0, 50) + "...";
        console.debug(`[OneBot] Received message in ${msg.message_type} [${msg.group_id || msg.user_id}]: ${preview}`);
        
        this.onMessageCallback(msg).catch((e) => {
          console.error("[OneBot] Message callback error:", e);
        });
      }
    }
  }

  /**
   * Call a OneBot v11 API action.
   */
  async callApi(action: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[OneBot] WebSocket not connected");
    }

    const echo = String(++this.requestId);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`[OneBot] API call '${action}' timed out`));
      }, 30000);

      this.pendingRequests.set(echo, { resolve, reject, timer });

      this.ws!.send(
        JSON.stringify({
          action,
          params,
          echo,
        })
      );
    });
  }

  /**
   * Send a group message with CQ-code image (base64).
   */
  async sendGroupImage(
    groupId: string,
    imageBase64: string,
    fallbackText?: string
  ): Promise<void> {
    const message = `[CQ:image,file=base64://${imageBase64}]`;
    try {
      const result = await this.callApi("send_group_msg", {
        group_id: Number(groupId),
        message,
      });
      
      const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
      console.log(`[OneBot] Sent image to group ${groupId}${preview}`);
      
      if (fallbackText && result?.message_id) {
        this.storeMessageMetadata(String(result.message_id), fallbackText);
      }
    } catch (e) {
      console.error(`[OneBot] Failed to send image to group ${groupId}:`, e);
      // Fallback to text
      if (fallbackText) {
        await this.sendGroupText(groupId, fallbackText);
      }
    }
  }

  /**
   * Send a group text message.
   */
  async sendGroupText(groupId: string, text: string): Promise<void> {
    try {
      await this.callApi("send_group_msg", {
        group_id: Number(groupId),
        message: text,
      });
      let preview = text.replace(/\n/g, " ");
      if (preview.length > 50) preview = preview.slice(0, 50) + "...";
      console.log(`[OneBot] Sent text to group ${groupId}: ${preview}`);
    } catch (e) {
      console.error(`[OneBot] Failed to send text to group ${groupId}:`, e);
    }
  }

  /**
   * Send a private message with CQ-code image (base64).
   */
  async sendPrivateImage(
    userId: string,
    imageBase64: string,
    fallbackText?: string
  ): Promise<void> {
    const message = `[CQ:image,file=base64://${imageBase64}]`;
    try {
      const result = await this.callApi("send_private_msg", {
        user_id: Number(userId),
        message,
      });
      const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
      console.log(`[OneBot] Sent image to user ${userId}${preview}`);
      
      if (fallbackText && result?.message_id) {
        this.storeMessageMetadata(String(result.message_id), fallbackText);
      }
    } catch (e) {
      console.error(`[OneBot] Failed to send image to user ${userId}:`, e);
      if (fallbackText) {
        await this.sendPrivateText(userId, fallbackText);
      }
    }
  }

  /**
   * Send a private text message.
   */
  async sendPrivateText(userId: string, text: string): Promise<void> {
    try {
      await this.callApi("send_private_msg", {
        user_id: Number(userId),
        message: text,
      });
      let preview = text.replace(/\n/g, " ");
      if (preview.length > 50) preview = preview.slice(0, 50) + "...";
      console.log(`[OneBot] Sent text to user ${userId}: ${preview}`);
    } catch (e) {
      console.error(`[OneBot] Failed to send text to user ${userId}:`, e);
    }
  }

  /**
   * High-level: send image to a subscription target.
   */
  async sendImageToTarget(
    target: { type: string; id: string },
    imageBase64: string,
    fallbackText?: string
  ): Promise<void> {
    if (target.type === "group") {
      await this.sendGroupImage(target.id, imageBase64, fallbackText);
    } else {
      await this.sendPrivateImage(target.id, imageBase64, fallbackText);
    }
  }

  /**
   * High-level: send text to a subscription target
   */
  async sendTextToTarget(
    target: { type: string; id: string },
    text: string
  ): Promise<void> {
    if (target.type === "group") {
      await this.sendGroupText(target.id, text);
    } else {
      await this.sendPrivateText(target.id, text);
    }
  }
}
