/**
 * Application utilities
 */

// Track when the service started for uptime calculations
export const serviceStartTime = Date.now();

/**
 * Escape HTML special characters
 */
export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Neutralize OneBot/CQ codes in arbitrary text so that GitHub-controlled
 * content (commit messages, titles, usernames...) cannot inject
 * [CQ:image/at/record/...] codes into outgoing QQ messages.
 */
export function sanitizeTextForCq(text: string): string {
  if (!text) return "";
  // Replace the opening bracket of [CQ:...] with a full-width bracket,
  // which QQ displays literally and does not parse as a code.
  return text.replace(/\[CQ:/gi, "［CQ:");
}
