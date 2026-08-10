import * as fs from "fs";
import * as path from "path";
import { AppConfig, getConfig } from "./config";

export interface GroupState {
  disabled: boolean;
}

export interface AppState {
  groupStates: Record<string, GroupState>;
  lastEventIds: Record<string, string>; // repo -> last processed event ID
}

let state: AppState = { groupStates: {}, lastEventIds: {} };
let statePath = path.resolve(process.cwd(), "data", "state.json");

/**
 * Initialize state from disk.
 */
export function initState(): void {
  statePath = path.resolve(process.cwd(), "data", "state.json");

  // Ensure data dir exists
  const dataDir = path.dirname(statePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!state.lastEventIds) state.lastEventIds = {};
      if (!state.groupStates) state.groupStates = {};
    } catch (e) {
      console.error("[State] Failed to load state.json, using default state");
      state = { groupStates: {}, lastEventIds: {} };
    }
  } else {
    saveState();
  }
}

/**
 * Save state to disk.
 */
export function saveState(): void {
  atomicWriteFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Save current config back to config.json map
 */
export function saveConfig(newConfig: AppConfig): void {
  // Resolve the path on every call: loadConfig() uses the same
  // process.cwd()-relative lookup, so config.json always lands where it was
  // loaded from even if the process cwd changed after startup.
  atomicWriteFileSync(
    path.resolve(process.cwd(), "config.json"),
    JSON.stringify(newConfig, null, 2)
  );
  // Hot reload config in memory by calling loadConfig or updating the reference
  // Since config is imported elsewhere, we mutate the existing config object properties
  const currentConfig = getConfig();
  Object.assign(currentConfig, newConfig);
}

/**
 * Write a file atomically (write to temp file, then rename) to avoid
 * corrupting state/config on crash mid-write.
 * Handles transient file locks (EBUSY / EPERM) on Windows and Docker volume mounts.
 */
function atomicWriteFileSync(targetPath: string, content: string): void {
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const tmpPath = `${targetPath}.${Date.now()}.${randomSuffix}.tmp`;

  try {
    fs.writeFileSync(tmpPath, content);
  } catch (err) {
    // If temp file creation fails for any reason, try direct write
    fs.writeFileSync(targetPath, content);
    return;
  }

  let retries = 5;
  while (retries > 0) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err: any) {
      if (
        err.code === "EBUSY" ||
        err.code === "EPERM" ||
        err.code === "EACCES"
      ) {
        retries--;
        if (retries === 0) {
          try {
            fs.copyFileSync(tmpPath, targetPath);
            try {
              fs.unlinkSync(tmpPath);
            } catch (_) {}
            return;
          } catch (_) {
            fs.writeFileSync(targetPath, content);
            try {
              fs.unlinkSync(tmpPath);
            } catch (_) {}
            return;
          }
        }
        // Brief sync pause before retrying
        const start = Date.now();
        while (Date.now() - start < 50) {}
      } else {
        // Unexpected error, fallback to copy/direct write then cleanup
        try {
          fs.copyFileSync(tmpPath, targetPath);
          try {
            fs.unlinkSync(tmpPath);
          } catch (_) {}
        } catch (_) {
          fs.writeFileSync(targetPath, content);
          try {
            fs.unlinkSync(tmpPath);
          } catch (_) {}
        }
        return;
      }
    }
  }
}

/**
 * Check if a specific target (group or private) is disabled.
 */
export function isTargetDisabled(type: string, id: string): boolean {
  if (type === "group") {
    return !!state.groupStates[id]?.disabled;
  }
  return false;
}

/**
 * Enable or disable push for a specific group.
 */
export function setGroupToggle(groupId: string, disabled: boolean): void {
  if (!state.groupStates[groupId]) {
    state.groupStates[groupId] = { disabled };
  } else {
    state.groupStates[groupId].disabled = disabled;
  }
  saveState();
}

/**
 * Get internal state payload for WebUI
 */
export function getState(): AppState {
  return state;
}

/**
 * Get last processed event ID for a repo.
 */
export function getLastEventId(repo: string): string | undefined {
  return state.lastEventIds[repo];
}

/**
 * Set last processed event ID for a repo and persist.
 */
export function setLastEventId(repo: string, eventId: string): void {
  state.lastEventIds[repo] = eventId;
  saveState();
}
