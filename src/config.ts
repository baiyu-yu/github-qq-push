import * as fs from "fs";
import * as path from "path";
import { saveConfig as saveConfigToDisk } from "./state";

export interface OneBotConfig {
  ws_url: string;
  access_token: string;
  command_prefix: string; // e.g. "/" or "!"
  masters?: string[]; // Master QQ list
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
  concurrency?: number; // Concurrent Puppeteer renders, default 2 (min 1)
  max_queue_size?: number; // Render backlog cap, default 50 (0 = fail fast, no queue)
  max_screenshot_height?: number; // Full-page screenshot safety cap, default 30000 (0 = up to hard ceiling)
}

export interface SubscriptionTarget {
  type: "group" | "private";
  id: string;
  /**
   * Events subscribed for THIS target only (per-target isolation).
   * Undefined/empty = legacy default events (kept for backward compatibility).
   */
  events?: string[];
}

export interface Subscription {
  repo: string;
  targets: SubscriptionTarget[];
  /** @deprecated legacy block-level events, migrated to per-target on load */
  events?: string[];
}

export interface WebUIConfig {
  username?: string;
  password?: string;
}

export interface AppConfig {
  onebot: OneBotConfig;
  github: GitHubConfig;
  render?: RenderConfig;
  subscriptions: Subscription[];
  webui?: WebUIConfig;
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
  if (!config.onebot.masters) {
    config.onebot.masters = [];
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
      concurrency: 2,
      max_queue_size: 50,
      max_screenshot_height: 30000,
    };
  }
  if (config.render.concurrency === undefined) config.render.concurrency = 2;
  if (config.render.max_queue_size === undefined) config.render.max_queue_size = 50;
  if (config.render.max_screenshot_height === undefined) {
    config.render.max_screenshot_height = 30000;
  }
  if (!config.webui) {
    config.webui = { username: "admin", password: "" };
  }
  if (!config.subscriptions) {
    config.subscriptions = [];
  }

  // Migrate legacy block-level events to per-target events
  for (const sub of config.subscriptions) {
    sub.targets = sub.targets || [];
    if (sub.events && sub.events.length > 0) {
      const legacyEvents = sub.events;
      for (const t of sub.targets) {
        if (!t.events || t.events.length === 0) {
          t.events = [...legacyEvents];
        }
      }
      delete sub.events;
    }
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
    if (!repoMatch) continue;
    for (const t of sub.targets) {
      // Per-target events; undefined/empty means all events (legacy behavior)
      const events = t.events;
      const matches =
        !events || events.length === 0 || events.includes(eventType);
      if (matches) {
        targets.push(t);
      }
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
    sub = { repo: repoFullName, targets: [] };
    config.subscriptions.push(sub);
  }

  let existingTarget = sub.targets.find(
    (t) => t.type === target.type && t.id === target.id
  );
  if (!existingTarget) {
    existingTarget = {
      type: target.type,
      id: target.id,
      events: [...events],
    };
    sub.targets.push(existingTarget);
  } else {
    // Merge events for this target only
    const eventSet = new Set([...(existingTarget.events || []), ...events]);
    existingTarget.events = Array.from(eventSet);
  }

  saveConfigToDisk(config);
  return true;
}

/**
 * Remove a subscription (or specific events) for a target.
 */
export function removeSubscription(
  repoFullName: string,
  target: SubscriptionTarget,
  eventsToRemove?: string[]
): { success: boolean; removedEvents?: string[]; remainingEvents?: string[] } {
  const subIndex = config.subscriptions.findIndex((s) => s.repo === repoFullName);
  if (subIndex === -1) return { success: false };

  const sub = config.subscriptions[subIndex];
  const targetIndex = sub.targets.findIndex(
    (t) => t.type === target.type && t.id === target.id
  );

  if (targetIndex === -1) return { success: false }; // not subscribed

  const targetEntry = sub.targets[targetIndex];
  const targetEvents = targetEntry.events || [];

  if (eventsToRemove && eventsToRemove.length > 0) {
    const toRemoveSet = new Set(eventsToRemove);
    const removed = targetEvents.filter((ev) => toRemoveSet.has(ev));
    const remaining = targetEvents.filter((ev) => !toRemoveSet.has(ev));

    if (removed.length === 0) {
      return {
        success: false,
        removedEvents: [],
        remainingEvents: targetEvents,
      };
    }

    targetEntry.events = remaining;

    // If no events left for this target, remove the target from this repo block
    if (remaining.length === 0) {
      sub.targets.splice(targetIndex, 1);
      if (sub.targets.length === 0) {
        config.subscriptions.splice(subIndex, 1);
      }
    }

    saveConfigToDisk(config);
    return { success: true, removedEvents: removed, remainingEvents: remaining };
  } else {
    // Remove target completely
    sub.targets.splice(targetIndex, 1);
    if (sub.targets.length === 0) {
      config.subscriptions.splice(subIndex, 1);
    }
    saveConfigToDisk(config);
    return {
      success: true,
      removedEvents: targetEvents,
      remainingEvents: [],
    };
  }
}

/**
 * List subscriptions for a target.
 */
export function listSubscriptions(target: SubscriptionTarget): { repo: string; events: string[] }[] {
  const result: { repo: string; events: string[] }[] = [];
  for (const sub of config.subscriptions) {
    const matchingTarget = sub.targets.find(
      (t) => t.type === target.type && t.id === target.id
    );
    if (matchingTarget) {
      result.push({ repo: sub.repo, events: matchingTarget.events || [] });
    }
  }
  return result;
}
