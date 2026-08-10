/**
 * Event Deduplication Cache
 * Prevents identical GitHub events (received via Webhook and/or Poller)
 * from being processed multiple times.
 */

const PROCESSED_EVENTS = new Map<string, number>();
const MAX_CACHE_SIZE = 2000;
const TTL_MS = 30 * 60 * 1000; // 30 minutes TTL

/**
 * Generate a unique fingerprint for a GitHub event payload.
 */
export function getEventFingerprint(eventType: string, payload: any): string | null {
  const repo = payload.repository?.full_name || payload.repo || "";
  if (!repo) return null;

  const action = payload.action || "";

  switch (eventType) {
    case "issues":
      return payload.issue?.id
        ? `${repo}:issues:${action}:${payload.issue.id}`
        : null;

    case "pull_request":
      return payload.pull_request?.id
        ? `${repo}:pull_request:${action}:${payload.pull_request.id}`
        : null;

    case "issue_comment":
      return payload.comment?.id
        ? `${repo}:issue_comment:${action}:${payload.comment.id}`
        : null;

    case "commit_comment":
      return payload.comment?.id
        ? `${repo}:commit_comment:${action}:${payload.comment.id}`
        : null;

    case "pull_request_review":
      return payload.review?.id
        ? `${repo}:pull_request_review:${action}:${payload.review.id}`
        : null;

    case "pull_request_review_comment":
      return payload.comment?.id
        ? `${repo}:pull_request_review_comment:${action}:${payload.comment.id}`
        : null;

    case "push": {
      const commitSha =
        payload.head ||
        payload.after ||
        (payload.commits && payload.commits.length > 0
          ? payload.commits[payload.commits.length - 1].id
          : "");
      const ref = payload.ref || "";
      return commitSha ? `${repo}:push:${ref}:${commitSha}` : null;
    }

    case "release":
      return payload.release?.id
        ? `${repo}:release:${action}:${payload.release.id}`
        : null;

    case "star":
    case "watch":
      // Ignore the action here: the webhook sends "started" while the
      // poller normalizes WatchEvent to "created". Same person starring the
      // same repo should always deduplicate to the same fingerprint.
      return payload.sender?.login ? `${repo}:star:${payload.sender.login}` : null;

    case "fork":
      return payload.forkee?.id
        ? `${repo}:fork:${payload.forkee.id}`
        : null;

    default:
      return null;
  }
}

/**
 * Check if an event fingerprint has already been processed recently.
 */
export function isEventProcessed(fingerprint: string): boolean {
  cleanExpired();
  return PROCESSED_EVENTS.has(fingerprint);
}

/**
 * Mark an event fingerprint as processed.
 */
export function markEventProcessed(fingerprint: string): void {
  cleanExpired();
  PROCESSED_EVENTS.set(fingerprint, Date.now());

  // Prevent memory growth beyond max limit
  if (PROCESSED_EVENTS.size > MAX_CACHE_SIZE) {
    const oldestKey = PROCESSED_EVENTS.keys().next().value;
    if (oldestKey) {
      PROCESSED_EVENTS.delete(oldestKey);
    }
  }
}

/**
 * Remove a fingerprint from the processed cache.
 * Used to roll back the dedup mark when routing fails, so a transient
 * handler error does not swallow the event until the TTL expires.
 */
export function deleteProcessedEvent(fingerprint: string): void {
  PROCESSED_EVENTS.delete(fingerprint);
}

/**
 * Remove expired entries from the cache.
 */
function cleanExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of PROCESSED_EVENTS.entries()) {
    if (now - timestamp > TTL_MS) {
      PROCESSED_EVENTS.delete(key);
    }
  }
}
