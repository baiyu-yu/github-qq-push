import * as fs from "fs";
import * as path from "path";
import { saveConfig as saveConfigToDisk } from "./state";

export interface OneBotConfig {
  ws_url: string;
  access_token: string;
  command_prefix: string; // e.g. "/" or "!"
}

export interface GitHubConfig {
  webhook_port: number;
  webhook_secret?: string;
  access_token?: string; // Legacy
  access_tokens?: string[]; // Multiple PATs
  polling_enabled?: boolean;
  polling_interval?: number; // seconds, default 60
  link_card_group_mode?: "all" | "selected" | "none";
  link_card_enabled_groups?: string[];
}

export interface RenderConfig {
  image_quality: number; // 0-100
  max_height: number;    // 0 = unlimited
  theme: "light" | "dark";
}

export interface SubscriptionTarget {
  type: "group" | "private";
  id: string;
}

export interface Subscription {
  repo: string;
  events: string[];
  targets: SubscriptionTarget[];
}

export interface AppConfig {
  onebot: OneBotConfig;
  github: GitHubConfig;
  render?: RenderConfig;
  subscriptions: Subscription[];
}

let config: AppConfig;

export function loadConfig(): AppConfig {
  const configPath = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      "[Config] config.json not found! Copy config.example.json to config.json and edit it."
    );
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  config = JSON.parse(raw) as AppConfig;
  // Fill in defaults if missing
  if (!config.onebot) {
    config.onebot = {
      ws_url: "ws://127.0.0.1:3001",
      access_token: "", // Default empty token
      command_prefix: "/",
    };
  }
  if (!config.github) {
    config.github = {
      webhook_port: 7890,
      webhook_secret: "",
      access_token: "",
      access_tokens: [],
      polling_enabled: true,
      polling_interval: 60,
      link_card_group_mode: "all",
      link_card_enabled_groups: [],
    };
  }
  if (!config.github.link_card_group_mode) {
    config.github.link_card_group_mode = "all";
  }
  if (!config.github.link_card_enabled_groups) {
    config.github.link_card_enabled_groups = [];
  }
  if (!config.onebot.command_prefix) {
    config.onebot.command_prefix = "/";
  }
  if (!config.github.access_tokens) {
    if (config.github.access_token) {
      config.github.access_tokens = [config.github.access_token];
    } else {
      config.github.access_tokens = [];
    }
  }
  if (!config.render) {
    config.render = {
      image_quality: 90,
      max_height: 8000,
      theme: "dark",
    };
  }
  if (!config.subscriptions) {
    config.subscriptions = [];
  }
  console.log(
    `[Config] Loaded ${config.subscriptions.length} subscription(s)`
  );
  return config;
}

export function getConfig(): AppConfig {
  if (!config) {
    return loadConfig();
  }
  return config;
}

import { isTargetDisabled } from "./state";

/**
 * Find all subscription targets that match a given repo and event type, ignoring disabled targets.
 */
export function findSubscribers(
  repoFullName: string,
  eventType: string
): SubscriptionTarget[] {
  const targets: SubscriptionTarget[] = [];
  for (const sub of config.subscriptions) {
    const repoMatch =
      sub.repo === repoFullName ||
      (sub.repo.endsWith("/*") &&
        repoFullName.startsWith(sub.repo.slice(0, -1)));
    if (repoMatch && sub.events.includes(eventType)) {
      targets.push(...sub.targets);
    }
  }
  
  // Deduplicate and filter out disabled targets
  const uniqueTargets = new Map<string, SubscriptionTarget>();
  for (const t of targets) {
    const key = `${t.type}:${t.id}`;
    if (!uniqueTargets.has(key) && !isTargetDisabled(t.type, t.id)) {
      uniqueTargets.set(key, t);
    }
  }
  return Array.from(uniqueTargets.values());
}

/**
 * Add a subscription for a repository.
 */
export function addSubscription(
  repoFullName: string,
  events: string[],
  target: SubscriptionTarget
): boolean {
  let sub = config.subscriptions.find((s) => s.repo === repoFullName);
  if (!sub) {
    sub = { repo: repoFullName, events: [], targets: [] };
    config.subscriptions.push(sub);
  }

  // Merge events
  const eventSet = new Set([...sub.events, ...events]);
  sub.events = Array.from(eventSet);

  // Add target if not exists
  const targetExists = sub.targets.some(
    (t) => t.type === target.type && t.id === target.id
  );
  if (!targetExists) {
    sub.targets.push(target);
  }

  saveConfigToDisk(config);
  return true;
}

/**
 * Remove a subscription for a target.
 */
export function removeSubscription(
  repoFullName: string,
  target: SubscriptionTarget
): boolean {
  const subIndex = config.subscriptions.findIndex((s) => s.repo === repoFullName);
  if (subIndex === -1) return false;

  const sub = config.subscriptions[subIndex];
  const targetIndex = sub.targets.findIndex(
    (t) => t.type === target.type && t.id === target.id
  );

  if (targetIndex === -1) return false; // not subscribed

  // Remove target
  sub.targets.splice(targetIndex, 1);

  // If no targets left, remove the subscription block entirely
  if (sub.targets.length === 0) {
    config.subscriptions.splice(subIndex, 1);
  }

  saveConfigToDisk(config);
  return true;
}

/**
 * List subscriptions for a target.
 */
export function listSubscriptions(target: SubscriptionTarget): { repo: string; events: string[] }[] {
  const result: { repo: string; events: string[] }[] = [];
  for (const sub of config.subscriptions) {
    const isTarget = sub.targets.some(
      (t) => t.type === target.type && t.id === target.id
    );
    if (isTarget) {
      result.push({ repo: sub.repo, events: sub.events });
    }
  }
  return result;
}
