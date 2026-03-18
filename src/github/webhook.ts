import * as crypto from "crypto";
import express from "express";
import { GitHubConfig } from "../config";

export type WebhookHandler = (
  event: string,
  payload: any
) => Promise<void>;

export class GitHubWebhookServer {
  private app: express.Application;
  private config: GitHubConfig;
  private handler: WebhookHandler | null = null;

  constructor(config: GitHubConfig) {
    this.config = config;
    this.app = express();

    // Raw body for signature verification
    this.app.use(
      "/webhook",
      express.raw({ type: "application/json", limit: "10mb" })
    );

    this.app.post("/webhook", (req, res) => this.handleWebhook(req, res));

    // Health check endpoint
    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });
  }

  onEvent(handler: WebhookHandler): void {
    this.handler = handler;
  }

  private verifySignature(payload: Buffer, signature: string): boolean {
    if (!this.config.webhook_secret) {
      return true; // No secret configured, skip verification
    }
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", this.config.webhook_secret)
        .update(payload)
        .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  }

  private async handleWebhook(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const event = req.headers["x-github-event"] as string;
    const signature = req.headers["x-hub-signature-256"] as string;
    const deliveryId = req.headers["x-github-delivery"] as string;

    if (!event) {
      res.status(400).json({ error: "Missing X-GitHub-Event header" });
      return;
    }

    // Verify signature if secret is configured
    if (this.config.webhook_secret) {
      if (!signature) {
        res.status(401).json({ error: "Missing signature" });
        return;
      }
      if (!this.verifySignature(req.body as Buffer, signature)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    let payload: any;
    try {
      payload = JSON.parse((req.body as Buffer).toString("utf-8"));
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
  }

  start(): void {
    const port = this.config.webhook_port;
    const server = this.app.listen(port, () => {
      console.log(
        `[Webhook] GitHub webhook server listening on port ${port}`
      );
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Webhook] Fatal: Port ${port} is already in use.`);
      } else {
        console.error(`[Webhook] Server error:`, err);
      }
      process.exit(1);
    });
  }
}
