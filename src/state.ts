import * as fs from "fs";
import * as path from "path";
import { AppConfig, getConfig } from "./config";

export interface GroupState {
  disabled: boolean;
}

export interface AppState {
  groupStates: Record<string, GroupState>;
}

let state: AppState = { groupStates: {} };
let configPath = path.resolve(process.cwd(), "config.json");
let statePath = path.resolve(process.cwd(), "data", "state.json");

/**
 * Initialize state from disk.
 */
export function initState(): void {
  configPath = path.resolve(process.cwd(), "config.json");
  statePath = path.resolve(process.cwd(), "data", "state.json");

  // Ensure data dir exists
  const dataDir = path.dirname(statePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    } catch (e) {
      console.error("[State] Failed to load state.json, using default state");
    }
  } else {
    saveState();
  }
}

/**
 * Save state to disk.
 */
export function saveState(): void {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Save current config back to config.json map
 */
export function saveConfig(newConfig: AppConfig): void {
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
  // Hot reload config in memory by calling loadConfig or updating the reference
  // Since config is imported elsewhere, we mutate the existing config object properties
  const currentConfig = getConfig();
  Object.assign(currentConfig, newConfig);
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
