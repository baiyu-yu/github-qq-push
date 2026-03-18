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
