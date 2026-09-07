import * as crypto from "crypto";
import WebSocket from "ws";
import express from "express";
import { QQBotConfig } from "../config";
import { sanitizeTextForCq } from "../utils";
import { IBotClient, BotInfo, BotConnectionState, SendMessageOptions } from "../bot/types";

export class QQBotClient implements IBotClient {
  public readonly protocol = "qqbot" as const;
  private config: QQBotConfig;

  // Access Token State
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  // WebSocket State
  private ws: WebSocket | null = null;
  private heartbeatIntervalMs = 45000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;
  private maxReconnectDelay = 60000;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isShuttingDown = false;
  private isManuallyStopped = false;

  // Ed25519 Keypair (Webhook mode)
  private ed25519Keys: {
    privateKey: crypto.KeyObject;
    publicKey: crypto.KeyObject;
  } | null = null;

  // Bot Info & Metadata
  private botInfo: BotInfo | null = null;
  private messageMetadata = new Map<string, string>();
  private readonly MAX_METADATA_SIZE = 1000;

  // MsgSeq tracking per msg_id for passive replies (TTL: 10 minutes)
  private msgSeqMap = new Map<string, { seq: number; lastUsed: number }>();
  private readonly MSG_SEQ_TTL_MS = 10 * 60 * 1000;

  /**
   * Get the next reply sequence number for a given message ID.
   * Starts at 1 and auto-increments to prevent Tencent platform deduplication (40054005).
   */
  public getNextMsgSeq(msgId: string): number {
    const now = Date.now();
    for (const [id, item] of this.msgSeqMap.entries()) {
      if (now - item.lastUsed > this.MSG_SEQ_TTL_MS) {
        this.msgSeqMap.delete(id);
      }
    }

    const current = this.msgSeqMap.get(msgId);
    const seq = current ? current.seq + 1 : 1;
    this.msgSeqMap.set(msgId, { seq, lastUsed: now });
    return seq;
  }

  // Tracked openids for groups (to display in WebUI)
  private trackedGroups = new Map<string, string>();

  public onMessageCallback: ((msg: any) => Promise<void>) | null = null;

  constructor(config: QQBotConfig) {
    this.config = { ...config };
    this.initEd25519Keys();
  }

  /**
   * Derive Ed25519 keypair from Bot Secret seed.
   * QQ Open Platform spec: If secret is shorter than 32 bytes, repeat until >= 32, then slice to 32 bytes.
   */
  public static getEd25519KeysFromSecret(botSecret: string): {
    privateKey: crypto.KeyObject;
    publicKey: crypto.KeyObject;
  } {
    let seedStr = botSecret || "";
    while (Buffer.byteLength(seedStr, "utf8") < 32) {
      seedStr = seedStr + (seedStr || "0");
    }
    const seedBuf = Buffer.from(seedStr, "utf8").subarray(0, 32);
    // PKCS#8 DER header for Ed25519 private key
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const privKeyDer = Buffer.concat([pkcs8Prefix, seedBuf]);
    const privateKey = crypto.createPrivateKey({
      key: privKeyDer,
      format: "der",
      type: "pkcs8",
    });
    const publicKey = crypto.createPublicKey(privateKey);
    return { privateKey, publicKey };
  }

  private initEd25519Keys() {
    if (this.config.app_secret) {
      try {
        this.ed25519Keys = QQBotClient.getEd25519KeysFromSecret(
          this.config.app_secret
        );
      } catch (e: any) {
        console.error(
          `[QQBot] Failed to derive Ed25519 keys from app_secret:`,
          e.message
        );
        this.ed25519Keys = null;
      }
    } else {
      this.ed25519Keys = null;
    }
  }

  public getApiBaseUrl(): string {
    return this.config.sandbox
      ? "https://sandbox.api.sgroup.qq.com"
      : "https://api.sgroup.qq.com";
  }

  public getMode(): "ws" | "webhook" {
    return this.config.mode === "webhook" ? "webhook" : "ws";
  }

  public getConfig(): QQBotConfig {
    return { ...this.config };
  }

  /**
   * Get valid access_token, refreshing automatically when expired or near expiration.
   */
  public async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.fetchNewAccessToken()
      .finally(() => {
        this.tokenRefreshPromise = null;
      });

    return this.tokenRefreshPromise;
  }

  private async fetchNewAccessToken(): Promise<string> {
    const appId = (this.config.app_id || "").trim();
    const appSecret = (this.config.app_secret || "").trim();

    if (!appId || !appSecret) {
      throw new Error(
        "[QQBot] Missing app_id or app_secret in QQBot configuration."
      );
    }

    console.log(`[QQBot] Fetching access token for AppID ${appId}...`);
    const endpoints = [
      "https://api.bot.qq.com/app/getAppAccessToken",
      "https://bots.qq.com/app/getAppAccessToken",
    ];

    let lastError: any = null;
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appId,
            clientSecret: appSecret,
          }),
        });

        if (!resp.ok) {
          const bodyText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${bodyText}`);
        }

        const data = (await resp.json()) as any;
        if (!data.access_token) {
          throw new Error(
            `No access_token returned: ${JSON.stringify(data)}`
          );
        }

        const token: string = String(data.access_token);
        this.accessToken = token;
        const expiresIn = Number(data.expires_in) || 7200;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        console.log(
          `[QQBot] Access token acquired successfully (expires in ${expiresIn}s).`
        );
        return token;
      } catch (e: any) {
        lastError = e;
        console.warn(`[QQBot] Failed token request at ${url}:`, e.message);
      }
    }

    throw new Error(
      `[QQBot] Failed to obtain access token: ${lastError?.message || "Unknown error"}`
    );
  }

  public updateConfig(newConfig: QQBotConfig) {
    const modeChanged = this.config.mode !== newConfig.mode;
    const credsChanged =
      this.config.app_id !== newConfig.app_id ||
      this.config.app_secret !== newConfig.app_secret ||
      this.config.sandbox !== newConfig.sandbox;

    this.config = { ...newConfig };
    this.initEd25519Keys();

    if (credsChanged) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
    }

    if (modeChanged || credsChanged) {
      console.log(
        `[QQBot] Configuration updated. Reconnecting in mode: ${this.getMode()}...`
      );
      this.disconnect();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.forceReconnect();
      }, 500);
    }
  }

  public forceReconnect(): void {
    this.isShuttingDown = false;
    this.isManuallyStopped = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 3000;
    console.log(`[QQBot] Manual reconnect triggered (mode: ${this.getMode()}).`);
    this.connect();
  }

  public disconnect(): void {
    this.isManuallyStopped = true;
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
    if (this.getMode() === "ws") {
      this.botInfo = null;
    }
  }

  public stopReconnect(): void {
    this.isManuallyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log("[QQBot] Reconnection manually stopped.");
  }

  public getBotInfo(): BotInfo | null {
    if (this.botInfo) return this.botInfo;
    if (this.config.app_id) {
      return {
        nickname: `QQBot (${this.config.app_id})`,
        user_id: this.config.app_id,
      };
    }
    return null;
  }

  public getConnectionState(): BotConnectionState {
    const isWebhook = this.getMode() === "webhook";
    const connected = isWebhook
      ? !this.isManuallyStopped && !!(this.config.app_id && this.config.app_secret)
      : this.ws !== null && this.ws.readyState === WebSocket.OPEN && !!this.botInfo;

    return {
      connected,
      stopped: this.isManuallyStopped,
      attempts: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
    };
  }

  public storeMessageMetadata(messageId: string, metadata: string): void {
    this.messageMetadata.set(messageId, metadata);
    if (this.messageMetadata.size > this.MAX_METADATA_SIZE) {
      const firstKey = this.messageMetadata.keys().next().value;
      if (firstKey) this.messageMetadata.delete(firstKey);
    }
  }

  public getMessageMetadata(messageId: string): string | undefined {
    return this.messageMetadata.get(messageId);
  }

  public trackGroup(groupId: string, groupName?: string) {
    if (!groupId) return;
    this.trackedGroups.set(groupId, groupName || `QQ群 (${groupId.slice(0, 8)}...)`);
  }

  public connect(): void {
    if (this.isShuttingDown) return;
    this.isManuallyStopped = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.config.app_id || !this.config.app_secret) {
      console.warn(
        "[QQBot] app_id 或 app_secret 未配置，机器人客户端暂未启动连接。请在 WebUI 或 config.json 中配置。"
      );
      return;
    }

    // Proactively fetch login info / test token
    this.fetchBotProfile().catch((e) => {
      console.warn("[QQBot] Initial profile query warning:", e.message);
    });

    if (this.getMode() === "webhook") {
      console.log(
        `[QQBot] Webhook 模式已就绪，接收路径: ${this.config.webhook_path || "/qqbot/webhook"}`
      );
      return;
    }

    // WebSocket Gateway Mode
    this.connectWebSocket();
  }

  private async fetchBotProfile(): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const url = `${this.getApiBaseUrl()}/users/@me`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `QQBot ${token}`,
        },
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        if (data && data.username) {
          this.botInfo = {
            nickname: data.username,
            user_id: data.id || this.config.app_id,
          };
          console.log(
            `[QQBot] Bot profile loaded: ${data.username} (${data.id})`
          );
        }
      }
    } catch (e: any) {
      // Non-fatal, gateway Ready or fallback will populate
    }
  }

  // ==========================================
  // Webhook Mode Handler
  // ==========================================

  /**
   * Handle incoming Webhook HTTP request from QQ Open Platform.
   */
  public async handleWebhookRequest(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!this.ed25519Keys) {
      this.initEd25519Keys();
    }

    if (!this.ed25519Keys) {
      res.status(500).json({ error: "QQBot secret not configured for Ed25519" });
      return;
    }

    const rawBodyBuffer = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === "string"
        ? Buffer.from(req.body, "utf8")
        : Buffer.from(JSON.stringify(req.body || {}), "utf8");

    let payload: any;
    try {
      payload = JSON.parse(rawBodyBuffer.toString("utf8"));
    } catch (e) {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
    }

    // 1. OpCode 13: Callback address validation
    if (payload.op === 13) {
      const d = payload.d;
      if (!d || !d.plain_token || !d.event_ts) {
        res.status(400).json({ error: "Missing plain_token or event_ts" });
        return;
      }

      try {
        const signMsg = Buffer.concat([
          Buffer.from(String(d.event_ts), "utf8"),
          Buffer.from(String(d.plain_token), "utf8"),
        ]);
        const signature = crypto
          .sign(null, signMsg, this.ed25519Keys.privateKey)
          .toString("hex");

        console.log(
          `[QQBot] Webhook validation (op 13) verified for plain_token.`
        );
        res.status(200).json({
          plain_token: d.plain_token,
          signature,
        });
        return;
      } catch (e: any) {
        console.error(`[QQBot] Webhook validation signing error:`, e);
        res.status(500).json({ error: e.message });
        return;
      }
    }

    // 2. Verify signature for normal event notifications
    const sigHex = (req.headers["x-signature-ed25519"] as string) || "";
    const timestamp = (req.headers["x-signature-timestamp"] as string) || "";

    if (sigHex && timestamp) {
      try {
        const sigBuf = Buffer.from(sigHex, "hex");
        const verifyMsg = Buffer.concat([
          Buffer.from(timestamp, "utf8"),
          rawBodyBuffer,
        ]);
        const isValid = crypto.verify(
          null,
          verifyMsg,
          this.ed25519Keys.publicKey,
          sigBuf
        );

        if (!isValid) {
          console.warn("[QQBot] Webhook request Ed25519 signature invalid!");
          res.status(401).json({ error: "Invalid Ed25519 signature" });
          return;
        }
      } catch (e: any) {
        console.warn("[QQBot] Webhook signature verification error:", e.message);
        res.status(401).json({ error: "Signature verification failed" });
        return;
      }
    }

    // Immediate 200 HTTP Callback ACK to QQ Open Platform
    res.status(200).json({ ok: true });

    // Asynchronously dispatch event
    if (payload.op === 0 && payload.t && payload.d) {
      this.handleDispatch(payload.t, payload.d).catch((e) => {
        console.error(`[QQBot] Webhook event dispatch error (${payload.t}):`, e);
      });
    }
  }

  // ==========================================
  // WebSocket Gateway Mode
  // ==========================================

  private async connectWebSocket(): Promise<void> {
    if (this.isShuttingDown || this.isManuallyStopped) return;

    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    let gatewayUrl = "";
    try {
      const token = await this.getAccessToken();
      const apiUrl = `${this.getApiBaseUrl()}/gateway`;
      console.log(`[QQBot] Requesting gateway from ${apiUrl}...`);

      const resp = await fetch(apiUrl, {
        headers: {
          Authorization: `QQBot ${token}`,
        },
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Gateway request failed (${resp.status}): ${txt}`);
      }

      const data = (await resp.json()) as any;
      gatewayUrl = data.url;
      if (!gatewayUrl) {
        throw new Error(`Gateway response missing url: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      console.error(`[QQBot] Failed to get WebSocket gateway URL:`, e.message);
      this.scheduleReconnect();
      return;
    }

    console.log(`[QQBot] Connecting Gateway WebSocket to ${gatewayUrl}...`);
    try {
      this.ws = new WebSocket(gatewayUrl);
    } catch (e: any) {
      console.error(`[QQBot] WebSocket creation error:`, e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[QQBot] Gateway WebSocket connected. Awaiting Hello (OpCode 10)...");
      this.reconnectDelay = 3000;
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleGatewayMessage(payload);
      } catch (e) {
        console.error("[QQBot] Failed to parse gateway JSON message:", e);
      }
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "No reason";
      console.warn(`[QQBot] Gateway WebSocket closed. Code: ${code}, Reason: ${reasonStr}`);
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[QQBot] Gateway WebSocket error:", err.message);
    });
  }

  private handleGatewayMessage(payload: any) {
    if (!payload) return;

    if (payload.s !== undefined && payload.s !== null) {
      this.lastSeq = payload.s;
    }

    const op = payload.op;
    switch (op) {
      case 10: // Hello
        {
          const interval = payload.d?.heartbeat_interval || 45000;
          this.heartbeatIntervalMs = interval;
          console.log(`[QQBot] Received Hello, heartbeat interval: ${interval}ms`);
          this.startHeartbeat();
          this.sendIdentifyOrResume();
        }
        break;

      case 11: // Heartbeat ACK
        // Normal heartbeat acknowledgement
        break;

      case 0: // Dispatch
        this.handleDispatch(payload.t, payload.d);
        break;

      case 7: // Reconnect requested by server
        console.warn("[QQBot] Gateway server requested reconnect (OpCode 7).");
        if (this.ws) this.ws.close();
        break;

      case 9: // Invalid session
        console.warn("[QQBot] Gateway invalid session (OpCode 9). Resetting session.");
        this.sessionId = null;
        this.lastSeq = null;
        if (this.ws) this.ws.close();
        break;

      default:
        break;
    }
  }

  private async sendIdentifyOrResume() {
    try {
      const token = await this.getAccessToken();

      // If we have an existing session and seq, try Resume
      if (this.sessionId && this.lastSeq !== null) {
        console.log(
          `[QQBot] Attempting to Resume session ${this.sessionId} at seq ${this.lastSeq}...`
        );
        const resumePayload = {
          op: 6,
          d: {
            token: `QQBot ${token}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        };
        this.sendWs(resumePayload);
        return;
      }

      // Otherwise Identify
      const intents =
        this.config.intents !== undefined ? this.config.intents : 1 << 25; // GROUP_AND_C2C_EVENT
      console.log(`[QQBot] Sending Identify (intents: ${intents})...`);
      const identifyPayload = {
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: "github-qq-push",
            $device: "github-qq-push",
          },
        },
      };
      this.sendWs(identifyPayload);
    } catch (e: any) {
      console.error("[QQBot] Failed to send Identify/Resume:", e.message);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const heartbeatPayload = {
        op: 1,
        d: this.lastSeq,
      };
      this.sendWs(heartbeatPayload);
    }
  }

  private sendWs(payload: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.isManuallyStopped) return;
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[QQBot] Reached maximum reconnect attempts (${this.maxReconnectAttempts}). Connection stopped.`
      );
      this.isManuallyStopped = true;
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `[QQBot] Reconnecting in ${this.reconnectDelay / 1000}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 1.5,
        this.maxReconnectDelay
      );
      this.connectWebSocket();
    }, this.reconnectDelay);
  }

  // ==========================================
  // Dispatch Events & Normalization
  // ==========================================

  private async handleDispatch(t: string, d: any): Promise<void> {
    if (!t) return;

    if (t === "READY") {
      this.sessionId = d?.session_id || null;
      if (d?.user) {
        this.botInfo = {
          nickname: d.user.username || "QQBot",
          user_id: d.user.id || this.config.app_id,
        };
        console.log(
          `[QQBot] Gateway READY! Logged in as ${this.botInfo.nickname} (${this.botInfo.user_id})`
        );
      }
      this.reconnectAttempts = 0;
      this.reconnectDelay = 3000;
      return;
    }

    if (t === "RESUMED") {
      console.log("[QQBot] Gateway session resumed successfully.");
      this.reconnectAttempts = 0;
      return;
    }

    if (
      t === "GROUP_AT_MESSAGE_CREATE" ||
      t === "GROUP_MESSAGE_CREATE" ||
      t === "C2C_MESSAGE_CREATE" ||
      t === "DIRECT_MESSAGE_CREATE" ||
      t === "AT_MESSAGE_CREATE"
    ) {
      const normalized = this.normalizeMessage(t, d);
      if (normalized) {
        if (normalized.group_id) {
          this.trackGroup(String(normalized.group_id));
        }

        let preview = normalized.raw_message || "";
        if (preview.length > 50) preview = preview.substring(0, 50) + "...";
        console.debug(
          `[QQBot] Received message in ${normalized.message_type} [${normalized.group_id || normalized.user_id}] (${t}): ${preview}`
        );

        if (this.onMessageCallback) {
          try {
            await this.onMessageCallback(normalized);
          } catch (e) {
            console.error("[QQBot] Message callback error:", e);
          }
        }
      }
    } else {
      console.debug(`[QQBot] Event: ${t}`);
    }
  }

  /**
   * Convert QQ Bot API v2 message event into normalized structure compatible with handlers.
   * Supports both full mode (GROUP_MESSAGE_CREATE) and @ mode (GROUP_AT_MESSAGE_CREATE).
   */
  public normalizeMessage(t: string, d: any): any {
    if (!d) return null;

    const isGroup =
      t === "GROUP_AT_MESSAGE_CREATE" ||
      t === "GROUP_MESSAGE_CREATE" ||
      t === "AT_MESSAGE_CREATE" ||
      !!d.group_openid;

    const groupOpenid = d.group_openid || (isGroup ? d.group_id : undefined);
    const author = d.author || {};
    const userId = author.id || author.member_openid || d.user_openid || "";
    const username = author.username || "QQ User";

    const content = (d.content || "").trim();
    // Strip leading bot mention (e.g. "<@!12345678>" or "@bot") if present, so commands like /status or #123 match cleanly
    const cleanContent = content.replace(/^<@!\S+?>\s*/, "").replace(/^@\S+\s*/, "").trim();
    const effectiveText = cleanContent || content;

    let rawMessage = effectiveText;
    const segments: any[] = [];

    // Check if message has a reply reference
    const refId = d.message_reference?.message_id;
    if (refId) {
      rawMessage = `[CQ:reply,id=${refId}] ${effectiveText}`;
      segments.push({ type: "reply", data: { id: String(refId) } });
    }

    if (effectiveText) {
      segments.push({ type: "text", data: { text: effectiveText } });
    }

    return {
      post_type: "message",
      message_type: isGroup ? "group" : "private",
      sub_type: isGroup
        ? t === "GROUP_AT_MESSAGE_CREATE" || t === "AT_MESSAGE_CREATE"
          ? "at"
          : "normal"
        : "friend",
      message_id: String(d.id || ""),
      group_id: isGroup ? String(groupOpenid || "") : undefined,
      user_id: String(userId || ""),
      raw_message: rawMessage,
      message: segments,
      sender: {
        user_id: String(userId || ""),
        nickname: username,
        role: isGroup ? (author.member_role || "member") : undefined,
      },
      time: d.timestamp
        ? Math.floor(new Date(d.timestamp).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      self_id: this.botInfo?.user_id || this.config.app_id,
    };
  }

  // ==========================================
  // Message & Rich Media Sending Methods
  // ==========================================

  /**
   * Send text to a QQ group.
   * If options.msgId is provided, sent as passive reply with msg_id & auto-incrementing msg_seq.
   * Otherwise sent as proactive active message without msg_id.
   */
  public async sendGroupText(
    groupId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const url = `${this.getApiBaseUrl()}/v2/groups/${groupId}/messages`;
      const cleanText = sanitizeTextForCq(text);

      const body: Record<string, any> = {
        content: cleanText,
        msg_type: 0,
      };

      if (options?.msgId) {
        body.msg_id = options.msgId;
        body.msg_seq = options.msgSeq ?? this.getNextMsgSeq(options.msgId);
      }

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      const result = (await resp.json()) as any;
      let preview = text.replace(/\n/g, " ");
      if (preview.length > 50) preview = preview.slice(0, 50) + "...";
      const modeTag = options?.msgId
        ? `[Passive, seq=${body.msg_seq}]`
        : "[Active]";
      console.log(`[QQBot] Sent text to group ${groupId} ${modeTag}: ${preview}`);

      if (result?.id) {
        this.storeMessageMetadata(String(result.id), text);
      }
    } catch (e: any) {
      console.error(`[QQBot] Failed to send text to group ${groupId}:`, e.message);
    }
  }

  /**
   * Send image to a QQ group.
   * If options.msgId is provided:
   *   1. Uploads file with srv_send_msg: false to get file_info.
   *   2. Sends passive message with msg_type: 7, media: { file_info }, msg_id, msg_seq (does NOT consume active quota).
   * Otherwise:
   *   Sends active message with srv_send_msg: true.
   */
  public async sendGroupImage(
    groupId: string,
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();

      if (options?.msgId) {
        // --- Passive message flow (被动消息) ---
        const uploadUrl = `${this.getApiBaseUrl()}/v2/groups/${groupId}/files`;
        const uploadResp = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_type: 1, // 1 = image
            file_data: imageBase64,
            srv_send_msg: false,
          }),
        });

        if (!uploadResp.ok) {
          const errText = await uploadResp.text();
          throw new Error(`File upload HTTP ${uploadResp.status}: ${errText}`);
        }

        const uploadResult = (await uploadResp.json()) as any;
        const fileInfo = uploadResult?.file_info;
        if (!fileInfo) {
          throw new Error(
            `No file_info returned from upload: ${JSON.stringify(uploadResult)}`
          );
        }

        const msgUrl = `${this.getApiBaseUrl()}/v2/groups/${groupId}/messages`;
        const seq = options.msgSeq ?? this.getNextMsgSeq(options.msgId);
        const msgResp = await fetch(msgUrl, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            msg_type: 7, // 7 = rich media
            media: {
              file_info: fileInfo,
            },
            msg_id: options.msgId,
            msg_seq: seq,
          }),
        });

        if (!msgResp.ok) {
          const errText = await msgResp.text();
          throw new Error(`Send passive message HTTP ${msgResp.status}: ${errText}`);
        }

        const result = (await msgResp.json()) as any;
        const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
        console.log(`[QQBot] Sent image to group ${groupId} [Passive, seq=${seq}]${preview}`);

        if (fallbackText && (result?.id || fileInfo)) {
          this.storeMessageMetadata(String(result?.id || fileInfo), fallbackText);
        }
      } else {
        // --- Active message flow (主动推送) ---
        const url = `${this.getApiBaseUrl()}/v2/groups/${groupId}/files`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_type: 1, // 1 = image
            file_data: imageBase64,
            srv_send_msg: true,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        const result = (await resp.json()) as any;
        const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
        console.log(`[QQBot] Sent image to group ${groupId} [Active]${preview}`);

        if (fallbackText && (result?.id || result?.file_info)) {
          this.storeMessageMetadata(String(result.id || result.file_info), fallbackText);
        }
      }
    } catch (e: any) {
      console.error(
        `[QQBot] Failed to send image to group ${groupId}:`,
        e.message
      );
      if (fallbackText) {
        console.log(`[QQBot] Falling back to text message for group ${groupId}...`);
        await this.sendGroupText(groupId, fallbackText, options);
      }
    }
  }

  /**
   * Send text to a QQ user (C2C private message).
   * If options.msgId is provided, sent as passive reply with msg_id & auto-incrementing msg_seq.
   * Otherwise sent as proactive active message.
   */
  public async sendPrivateText(
    userId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const url = `${this.getApiBaseUrl()}/v2/users/${userId}/messages`;
      const cleanText = sanitizeTextForCq(text);

      const body: Record<string, any> = {
        content: cleanText,
        msg_type: 0,
      };

      if (options?.msgId) {
        body.msg_id = options.msgId;
        body.msg_seq = options.msgSeq ?? this.getNextMsgSeq(options.msgId);
      }

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      const result = (await resp.json()) as any;
      let preview = text.replace(/\n/g, " ");
      if (preview.length > 50) preview = preview.slice(0, 50) + "...";
      const modeTag = options?.msgId
        ? `[Passive, seq=${body.msg_seq}]`
        : "[Active]";
      console.log(`[QQBot] Sent text to user ${userId} ${modeTag}: ${preview}`);

      if (result?.id) {
        this.storeMessageMetadata(String(result.id), text);
      }
    } catch (e: any) {
      console.error(`[QQBot] Failed to send text to user ${userId}:`, e.message);
    }
  }

  /**
   * Send image to a QQ user (C2C private message).
   * If options.msgId is provided:
   *   1. Uploads file with srv_send_msg: false to get file_info.
   *   2. Sends passive message with msg_type: 7, media: { file_info }, msg_id, msg_seq (does NOT consume active quota).
   * Otherwise:
   *   Sends active message with srv_send_msg: true.
   */
  public async sendPrivateImage(
    userId: string,
    imageBase64: string,
    fallbackText?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();

      if (options?.msgId) {
        // --- Passive message flow (被动消息) ---
        const uploadUrl = `${this.getApiBaseUrl()}/v2/users/${userId}/files`;
        const uploadResp = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_type: 1,
            file_data: imageBase64,
            srv_send_msg: false,
          }),
        });

        if (!uploadResp.ok) {
          const errText = await uploadResp.text();
          throw new Error(`File upload HTTP ${uploadResp.status}: ${errText}`);
        }

        const uploadResult = (await uploadResp.json()) as any;
        const fileInfo = uploadResult?.file_info;
        if (!fileInfo) {
          throw new Error(
            `No file_info returned from upload: ${JSON.stringify(uploadResult)}`
          );
        }

        const msgUrl = `${this.getApiBaseUrl()}/v2/users/${userId}/messages`;
        const seq = options.msgSeq ?? this.getNextMsgSeq(options.msgId);
        const msgResp = await fetch(msgUrl, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            msg_type: 7,
            media: {
              file_info: fileInfo,
            },
            msg_id: options.msgId,
            msg_seq: seq,
          }),
        });

        if (!msgResp.ok) {
          const errText = await msgResp.text();
          throw new Error(`Send passive message HTTP ${msgResp.status}: ${errText}`);
        }

        const result = (await msgResp.json()) as any;
        const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
        console.log(`[QQBot] Sent image to user ${userId} [Passive, seq=${seq}]${preview}`);

        if (fallbackText && (result?.id || fileInfo)) {
          this.storeMessageMetadata(String(result?.id || fileInfo), fallbackText);
        }
      } else {
        // --- Active message flow (主动推送) ---
        const url = `${this.getApiBaseUrl()}/v2/users/${userId}/files`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_type: 1,
            file_data: imageBase64,
            srv_send_msg: true,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        const result = (await resp.json()) as any;
        const preview = fallbackText ? ` (${fallbackText.slice(0, 30)}...)` : "";
        console.log(`[QQBot] Sent image to user ${userId} [Active]${preview}`);

        if (fallbackText && (result?.id || result?.file_info)) {
          this.storeMessageMetadata(String(result.id || result.file_info), fallbackText);
        }
      }
    } catch (e: any) {
      console.error(
        `[QQBot] Failed to send image to user ${userId}:`,
        e.message
      );
      if (fallbackText) {
        console.log(`[QQBot] Falling back to text message for user ${userId}...`);
        await this.sendPrivateText(userId, fallbackText, options);
      }
    }
  }

  public async sendImageToTarget(
    target: { type: string; id: string },
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
    target: { type: string; id: string },
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    if (target.type === "group") {
      await this.sendGroupText(target.id, text, options);
    } else {
      await this.sendPrivateText(target.id, text, options);
    }
  }

  /**
   * Generic API call wrapper for WebUI / Handlers.
   */
  public async callApi(
    action: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    if (action === "get_group_list") {
      const groups: Array<{ group_id: string; group_name: string }> = [];
      for (const [id, name] of this.trackedGroups.entries()) {
        groups.push({ group_id: id, group_name: name });
      }
      return groups;
    }

    if (action === "get_login_info" || action === "get_bot_info") {
      return this.getBotInfo();
    }

    if (action === "get_msg" || action === "get_message") {
      const id = String(params.message_id || params.id || "");
      const meta = this.getMessageMetadata(id);
      return {
        message_id: id,
        raw_message: meta || "",
        message: meta ? [{ type: "text", data: { text: meta } }] : [],
      };
    }

    // Direct HTTP request to OpenAPI
    const token = await this.getAccessToken();
    const endpoint = action.startsWith("/") ? action : `/${action}`;
    const url = `${this.getApiBaseUrl()}${endpoint}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`[QQBot] API error (${resp.status}): ${txt}`);
    }

    return await resp.json();
  }
}
