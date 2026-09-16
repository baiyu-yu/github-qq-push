import WebSocket from "ws";
import { MilkyConfig } from "../config";
import { sanitizeTextForCq } from "../utils";
import { IBotClient, BotInfo, BotConnectionState, SendMessageOptions } from "../bot/types";

export class MilkyClient implements IBotClient {
  public readonly protocol = "milky" as const;
  public readonly id: string;
  public name: string;
  private ws: WebSocket | null = null;
  private config: MilkyConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;
  private maxReconnectDelay = 60000;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isShuttingDown = false;
  private isManuallyStopped = false;
  private botInfo: BotInfo | null = null;

  private pingInterval: ReturnType<typeof setTimeout> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000;
  private readonly PONG_TIMEOUT = 10000;

  private messageMetadata = new Map<string, string>();
  private readonly MAX_METADATA_SIZE = 1000;

  // Track scene and peer for recent messages so get_message can be queried by message_seq
  private messageScenes = new Map<
    string,
    { scene: "group" | "friend" | "temp"; peer_id: number }
  >();
  private readonly MAX_SCENE_CACHE = 2000;

  public onMessageCallback: ((msg: any) => Promise<void>) | null = null;

  constructor(config: MilkyConfig, id: string = "milky", name: string = "Milky") {
    this.id = id;
    this.name = name;
    this.config = { ...config };
  }

  public getHttpBaseUrl(): string {
    let endpoint = (this.config.endpoint || "http://127.0.0.1:3000").trim();
    if (!/^https?:\/\//i.test(endpoint) && !/^wss?:\/\//i.test(endpoint)) {
      endpoint = "http://" + endpoint;
    }
    // Normalize ws:// to http://
    endpoint = endpoint.replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://");
    return endpoint.replace(/\/+$/, "");
  }

  public getWsEventUrl(): string {
    const httpBase = this.getHttpBaseUrl();
    const wsBase = httpBase
      .replace(/^http:\/\//i, "ws://")
      .replace(/^https:\/\//i, "wss://");
    const eventUrl = `${wsBase}/event`;
    if (this.config.access_token) {
      return `${eventUrl}?access_token=${encodeURIComponent(this.config.access_token)}`;
    }
    return eventUrl;
  }

  public updateConfig(newConfig: MilkyConfig) {
    const changed =
      this.config.endpoint !== newConfig.endpoint ||
      this.config.access_token !== newConfig.access_token;
    this.config = { ...newConfig };

    if (changed) {
      console.log(
        `[Milky] Configuration changed. Reconnecting to ${this.config.endpoint}...`
      );
      this.disconnect();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.forceReconnect();
      }, 500);
    }
  }

  public forceReconnect() {
    this.isShuttingDown = false;
    this.isManuallyStopped = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 3000;
    console.log("[Milky] Manual reconnect triggered.");
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
  }

  public stopReconnect() {
    this.isManuallyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log("[Milky] Reconnection manually stopped.");
  }

  public getBotInfo(): BotInfo | null {
    return this.botInfo;
  }

  public getConnectionState(): BotConnectionState {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      stopped: this.isManuallyStopped,
      attempts: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
    };
  }

  public storeMessageMetadata(messageId: string, metadata: string) {
    this.messageMetadata.set(messageId, metadata);
    if (this.messageMetadata.size > this.MAX_METADATA_SIZE) {
      const firstKey = this.messageMetadata.keys().next().value;
      if (firstKey) this.messageMetadata.delete(firstKey);
    }
  }

  public getMessageMetadata(messageId: string): string | undefined {
    return this.messageMetadata.get(messageId);
  }

  private trackMessageScene(
    messageSeq: string | number,
    scene: "group" | "friend" | "temp",
    peerId: number
  ) {
    const key = String(messageSeq);
    this.messageScenes.set(key, { scene, peer_id: peerId });
    if (this.messageScenes.size > this.MAX_SCENE_CACHE) {
      const firstKey = this.messageScenes.keys().next().value;
      if (firstKey) this.messageScenes.delete(firstKey);
    }
  }

  public connect(): void {
    if (this.isShuttingDown) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    const wsUrl = this.getWsEventUrl();
    console.log(`[Milky] Connecting event stream to ${wsUrl}...`);

    const headers: Record<string, string> = {};
    if (this.config.access_token) {
      headers["Authorization"] = `Bearer ${this.config.access_token}`;
    }

    try {
      this.ws = new WebSocket(wsUrl, { headers });
    } catch (e: any) {
      console.error(`[Milky] Invalid WebSocket URL "${wsUrl}":`, e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[Milky] Event WebSocket connected!");
      this.reconnectDelay = 3000;
      this.reconnectAttempts = 0;

      // Fetch login info via HTTP API
      this.callApi("get_login_info")
        .then((data) => {
          if (data && data.uin) {
            this.botInfo = {
              nickname: data.nickname || "Milky Bot",
              user_id: data.uin,
            };
            console.log(
              `[Milky] Logged in as ${data.nickname} (${data.uin})`
            );
          }
        })
        .catch((e) => {
          console.warn("[Milky] Failed to get login info:", e.message);
        });

      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleEvent(event);
      } catch (e) {
        console.error("[Milky] Failed to parse event JSON:", e);
      }
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "No reason provided";
      console.warn(`[Milky] Event WebSocket closed. Code: ${code}, Reason: ${reasonStr}`);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[Milky] Event WebSocket error:", err.message);
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
          console.warn("[Milky] Heartbeat timeout. Closing connection.");
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
      console.error(
        `[Milky] Reached maximum reconnect attempts (${this.maxReconnectAttempts}). Connection stopped.`
      );
      this.isManuallyStopped = true;
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `[Milky] Reconnecting in ${this.reconnectDelay / 1000}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 1.5,
        this.maxReconnectDelay
      );
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Handle incoming event from Milky event stream
   */
  private handleEvent(event: any): void {
    if (!event || !event.event_type) return;

    if (event.event_type === "message_receive") {
      const data = event.data;
      if (!data) return;

      const scene = data.message_scene; // "group" | "friend" | "temp"
      const messageSeq = String(data.message_seq || "");
      if (messageSeq) {
        this.trackMessageScene(messageSeq, scene, Number(data.peer_id));
      }

      if (this.onMessageCallback) {
        const normalized = this.normalizeMessage(event);
        let preview = normalized.raw_message || "";
        if (preview.length > 50) preview = preview.substring(0, 50) + "...";
        console.debug(
          `[Milky] Received message in ${normalized.message_type} [${normalized.group_id || normalized.user_id}]: ${preview}`
        );

        this.onMessageCallback(normalized).catch((e) => {
          console.error("[Milky] Message callback error:", e);
        });
      }
    } else {
      console.debug(`[Milky] Event: ${event.event_type}`);
    }
  }

  /**
   * Convert Milky message_receive event into normalized structure compatible with handlers
   */
  public normalizeMessage(event: any): any {
    const data = event.data || {};
    const scene = data.message_scene;
    const isGroup = scene === "group";
    const segments = Array.isArray(data.segments) ? data.segments : [];

    let rawMessage = "";
    const normalizedSegments: any[] = [];

    for (const seg of segments) {
      if (!seg || !seg.type) continue;
      const d = seg.data || {};
      if (seg.type === "text") {
        const text = String(d.text || "");
        rawMessage += text;
        normalizedSegments.push({ type: "text", data: { text } });
      } else if (seg.type === "reply") {
        const replySeq = String(d.message_seq || "");
        rawMessage += `[CQ:reply,id=${replySeq}]`;
        normalizedSegments.push({ type: "reply", data: { id: replySeq, ...d } });
      } else if (seg.type === "mention") {
        const atUid = String(d.user_id || "");
        rawMessage += `[CQ:at,qq=${atUid}]`;
        normalizedSegments.push({ type: "at", data: { qq: atUid, ...d } });
      } else if (seg.type === "image") {
        rawMessage += `[CQ:image,file=${d.temp_url || d.resource_id || ""}]`;
        normalizedSegments.push({ type: "image", data: { ...d } });
      } else {
        normalizedSegments.push({ type: seg.type, data: d });
      }
    }

    const senderRole = isGroup ? data.group_member?.role : undefined;
    const senderNickname =
      data.group_member?.nickname ||
      data.group_member?.card ||
      data.friend?.nickname ||
      "";

    const hasAtBot = segments.some(
      (s: any) =>
        s.type === "mention" &&
        (String(s.data?.user_id) === String(event.self_id) ||
          String(s.data?.user_id) === String(this.botInfo?.user_id))
    );

    return {
      post_type: "message",
      message_type: isGroup ? "group" : "private",
      sub_type: isGroup ? (hasAtBot ? "at" : "normal") : "friend",
      message_id: Number(data.message_seq),
      group_id: isGroup ? Number(data.peer_id) : undefined,
      user_id: Number(data.sender_id),
      raw_message: rawMessage,
      message: normalizedSegments,
      sender: {
        user_id: Number(data.sender_id),
        nickname: senderNickname,
        role: senderRole || "member",
      },
      time: Number(data.time || Math.floor(Date.now() / 1000)),
      self_id: Number(event.self_id || 0),
    };
  }

  /**
   * Invoke a Milky HTTP API action.
   */
  public async callApi(
    action: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    // Map OneBot-style actions to Milky API endpoints if needed
    let apiEndpoint = action;
    let payload = { ...params };

    if (action === "get_msg" || action === "get_message") {
      const msgSeq = params.message_id || params.message_seq;
      const tracked = this.messageScenes.get(String(msgSeq));
      apiEndpoint = "get_message";
      payload = {
        message_scene: params.message_scene || tracked?.scene || "group",
        peer_id: Number(params.peer_id || tracked?.peer_id || 0),
        message_seq: Number(msgSeq),
      };
    } else if (action === "send_group_msg") {
      apiEndpoint = "send_group_message";
    } else if (action === "send_private_msg") {
      apiEndpoint = "send_private_message";
    }

    const httpBase = this.getHttpBaseUrl();
    const url = `${httpBase}/api/${apiEndpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.access_token) {
      headers["Authorization"] = `Bearer ${this.config.access_token}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (resp.status === 401) {
      throw new Error(`[Milky] API 401 Unauthorized for action '${apiEndpoint}'`);
    }
    if (resp.status === 404) {
      throw new Error(`[Milky] API 404 Action '${apiEndpoint}' not found`);
    }
    if (!resp.ok) {
      throw new Error(
        `[Milky] API '${apiEndpoint}' failed with HTTP ${resp.status} ${resp.statusText}`
      );
    }

    const result = (await resp.json()) as any;
    if (result.status === "failed" || (result.retcode !== undefined && result.retcode !== 0)) {
      throw new Error(
        `[Milky] API error (${result.retcode}): ${result.message || JSON.stringify(result)}`
      );
    }

    const data = result.data;
    // For get_group_list: Milky returns { groups: [...] }.
    // If caller requests get_group_list, return array of groups directly for OneBot consistency
    if (apiEndpoint === "get_group_list" && data && Array.isArray(data.groups)) {
      return data.groups;
    }

    // For get_message: normalize to { message_id, raw_message, message }
    if (apiEndpoint === "get_message" && data && data.message) {
      const norm = this.normalizeMessage({ data: data.message });
      return {
        message_id: norm.message_id,
        raw_message: norm.raw_message,
        message: norm.message,
        sender: norm.sender,
      };
    }

    return data;
  }

  /**
   * Send a group message with image (base64).
   */
  public async sendGroupImage(
    groupId: string,
    imageBase64: string,
    fallbackText?: string,
    _options?: SendMessageOptions
  ): Promise<void> {
    try {
      const segments: any[] = [
        {
          type: "image",
          data: {
            uri: `base64://${imageBase64}`,
            sub_type: "normal",
            summary: fallbackText ? fallbackText.slice(0, 40) : undefined,
          },
        },
      ];

      const result = await this.callApi("send_group_message", {
        group_id: Number(groupId),
        message: segments,
      });

      const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
      console.log(`[Milky] Sent image to group ${groupId}${preview}`);

      if (fallbackText && result?.message_seq) {
        this.storeMessageMetadata(String(result.message_seq), fallbackText);
      }
    } catch (e: any) {
      console.error(`[Milky] Failed to send image to group ${groupId}:`, e.message);
      if (fallbackText) {
        await this.sendGroupText(groupId, fallbackText);
      }
    }
  }

  /**
   * Send a group text message.
   */
  public async sendGroupText(
    groupId: string,
    text: string,
    _options?: SendMessageOptions
  ): Promise<void> {
    try {
      const result = await this.callApi("send_group_message", {
        group_id: Number(groupId),
        message: [
          {
            type: "text",
            data: {
              text: sanitizeTextForCq(text),
            },
          },
        ],
      });

      let preview = text.replace(/\n/g, " ");
      if (preview.length > 50) preview = preview.slice(0, 50) + "...";
      console.log(`[Milky] Sent text to group ${groupId}: ${preview}`);

      if (result?.message_seq) {
        this.storeMessageMetadata(String(result.message_seq), text);
      }
    } catch (e: any) {
      console.error(`[Milky] Failed to send text to group ${groupId}:`, e.message);
    }
  }

  /**
   * Send a private message with image (base64).
   */
  public async sendPrivateImage(
    userId: string,
    imageBase64: string,
    fallbackText?: string,
    _options?: SendMessageOptions
  ): Promise<void> {
    try {
      const segments: any[] = [
        {
          type: "image",
          data: {
            uri: `base64://${imageBase64}`,
            sub_type: "normal",
            summary: fallbackText ? fallbackText.slice(0, 40) : undefined,
          },
        },
      ];

      const result = await this.callApi("send_private_message", {
        user_id: Number(userId),
        message: segments,
      });

      const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
      console.log(`[Milky] Sent image to user ${userId}${preview}`);

      if (fallbackText && result?.message_seq) {
        this.storeMessageMetadata(String(result.message_seq), fallbackText);
      }
    } catch (e: any) {
      console.error(`[Milky] Failed to send image to user ${userId}:`, e.message);
      if (fallbackText) {
        await this.sendPrivateText(userId, fallbackText);
      }
    }
  }

  /**
   * Send a private text message.
   */
  public async sendPrivateText(
    userId: string,
    text: string,
    _options?: SendMessageOptions
  ): Promise<void> {
    try {
      const result = await this.callApi("send_private_message", {
        user_id: Number(userId),
        message: [
          {
            type: "text",
            data: {
              text: sanitizeTextForCq(text),
            },
          },
        ],
      });

      let preview = text.replace(/\n/g, " ");
      if (preview.length > 50) preview = preview.slice(0, 50) + "...";
      console.log(`[Milky] Sent text to user ${userId}: ${preview}`);

      if (result?.message_seq) {
        this.storeMessageMetadata(String(result.message_seq), text);
      }
    } catch (e: any) {
      console.error(`[Milky] Failed to send text to user ${userId}:`, e.message);
    }
  }

  public async sendImageToTarget(
    target: { type: string; id: string; botId?: string },
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (target.type === "group") {
      await this.sendGroupImage(target.id, imageBase64, fallbackText, options);
    } else {
      await this.sendPrivateImage(target.id, imageBase64, fallbackText, options);
    }
  }

  public async sendTextToTarget(
    target: { type: string; id: string; botId?: string },
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (target.type === "group") {
      await this.sendGroupText(target.id, text, options);
    } else {
      await this.sendPrivateText(target.id, text, options);
    }
  }
}
