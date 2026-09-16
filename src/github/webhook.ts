import * as crypto from "crypto";
import express from "express";
import { getConfig } from "../config";
import * as http from "http";

export type WebhookHandler = (
  event: string,
  payload: any
) => Promise<void>;

export class GitHubWebhookServer {
  private app: express.Application;
  private handler: WebhookHandler | null = null;
  private server: http.Server | null = null;
  private qqbotHandler:
    | ((req: express.Request, res: express.Response) => Promise<void> | void)
    | null = null;

  constructor() {
    this.app = express();

    // Raw body for GitHub webhook signature verification
    this.app.use(
      "/webhook",
      express.raw({ type: "application/json", limit: "10mb" })
    );

    this.app.post("/webhook", (req, res) => this.handleWebhook(req, res));

    // QQ Bot Webhook endpoint (unauthenticated, raw body preserved for Ed25519)
    const handleQQBot = (req: express.Request, res: express.Response) => {
      if (this.qqbotHandler) {
        Promise.resolve(this.qqbotHandler(req, res)).catch((err) => {
          console.error("[QQBot] Webhook handling error:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
          }
        });
      } else {
        res.status(503).json({ error: "QQBot Webhook handler is not active" });
      }
    };

    // Middleware to catch default or custom QQBot webhook paths
    this.app.use((req, res, next) => {
      const cfg = getConfig();
      const customPaths = (cfg.bots || [])
        .filter((b) => b.protocol === "qqbot" && b.qqbot?.webhook_path)
        .map((b) => b.qqbot!.webhook_path!);
      const legacyCustom = cfg.qqbot?.webhook_path;
      if (legacyCustom) customPaths.push(legacyCustom);

      const isQQBotPath =
        req.path === "/qqbot/webhook" ||
        req.path === "/api/qqbot/webhook" ||
        req.path.startsWith("/qqbot/webhook/") ||
        customPaths.includes(req.path);

      if (isQQBotPath) {
        if (req.method === "POST") {
          return express.raw({ type: "application/json", limit: "10mb" })(
            req,
            res,
            () => {
              handleQQBot(req, res);
            }
          );
        }
      }
      next();
    });

    // Health check endpoint
    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });
  }

  onEvent(handler: WebhookHandler): void {
    this.handler = handler;
  }

  onQQBotWebhook(
    handler:
      | ((req: express.Request, res: express.Response) => Promise<void> | void)
      | null
  ): void {
    this.qqbotHandler = handler;
  }


  private verifySignature(payload: Buffer, signature: string): boolean {
    const secret = getConfig().github.webhook_secret;
    if (!secret) {
      return true; // No secret configured, skip verification
    }
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("hex");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) {
      // Consume equal time even on length mismatch (also avoids
      // timingSafeEqual throwing on different-length buffers).
      crypto.timingSafeEqual(expBuf, expBuf);
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  private async handleWebhook(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    try {
      const event = req.headers["x-github-event"] as string;
      const signature = req.headers["x-hub-signature-256"] as string;
      const deliveryId = req.headers["x-github-delivery"] as string;

      if (!event) {
        res.status(400).json({ error: "Missing X-GitHub-Event header" });
        return;
      }

      // Verify signature if secret is configured
      const secret = getConfig().github.webhook_secret;
      if (secret) {
        if (!signature) {
          res.status(401).json({ error: "Missing signature" });
          return;
        }
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: "Invalid body" });
          return;
        }
        if (!this.verifySignature(req.body, signature)) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      }

      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "Invalid body" });
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(req.body.toString("utf-8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }

      console.log(
        `[Webhook] Received event: ${event}${payload.action ? `/${payload.action}` : ""} (delivery: ${deliveryId})`
      );

      // Respond immediately to GitHub
      res.status(200).json({ ok: true });

      // Process event asynchronously
      if (this.handler) {
        try {
          await this.handler(event, payload);
        } catch (e) {
          console.error(`[Webhook] Handler error for ${event}:`, e);
        }
      }
    } catch (e) {
      console.error("[Webhook] Error handling request:", e);
      if (!res.headersSent) {
        res.status(400).json({ error: "Bad request" });
      }
    }
  }

  start(): void {
    if (this.server) return;
    const port = getConfig().github.webhook_port;
    this.server = this.app.listen(port, () => {
      console.log(
        `[Webhook] GitHub webhook server listening on port ${port}`
      );
    });

    this.server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Webhook] Fatal: Port ${port} is already in use.`);
      } else {
        console.error(`[Webhook] Server error:`, err);
      }
      process.exit(1);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Re-listen on the (possibly changed) configured port.
   */
  restart(): void {
    this.stop();
    this.start();
  }
}
