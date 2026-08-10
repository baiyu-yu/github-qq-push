import { getOctokit, getPullRequest } from "./api";
import { getConfig } from "../config";
import { getLastEventId, setLastEventId } from "../state";
import { routeEvent } from "../handlers";
import { OneBotClient } from "../onebot/client";

/**
 * GitHub Event Poller - polls the GitHub Events API for subscribed repos.
 */
export class GitHubEventPoller {
  private bot: OneBotClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private hasInitialized = false;

  constructor(bot: OneBotClient) {
    this.bot = bot;
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    const config = getConfig();
    const interval = (config.github.polling_interval || 60) * 1000;

    if (this.timer) {
      clearInterval(this.timer);
    }

    console.log(`[Poller] Starting event polling (every ${interval / 1000}s)`);

    await this.initializeBaseline();

    this.timer = setInterval(() => this.pollAll(), interval);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[Poller] Stopped.");
  }

  /**
   * Restart with potentially new interval.
   */
  restart(): void {
    this.stop();
    const config = getConfig();
    if (config.github.polling_enabled) {
      this.start().catch((e: any) => {
        console.error("[Poller] Restart failed:", e.message);
      });
    }
  }

  /**
   * Initialize repos without pushing historical events.
   */
  private async initializeBaseline(): Promise<void> {
    if (this.hasInitialized) {
      return;
    }

    const config = getConfig();
    if (!config.github.polling_enabled) {
      return;
    }

    const repos = this.collectRepos();
    if (repos.length === 0) {
      console.log("[Poller] No repositories configured for polling.");
      this.hasInitialized = true;
      return;
    }

    console.log(`[Poller] Initializing baseline for ${repos.length} repository(ies)...`);

    for (const repoFullName of repos) {
      try {
        await this.initializeRepo(repoFullName);
      } catch (e: any) {
        if (e.status === 404) {
          console.warn(`[Poller] Repo not found during initialization: ${repoFullName}`);
        } else if (e.status === 403) {
          console.warn(`[Poller] Rate limited or forbidden during initialization for ${repoFullName}`);
          break;
        } else {
          console.error(`[Poller] Error initializing ${repoFullName}:`, e.message);
        }
      }
    }

    this.hasInitialized = true;
  }

  /**
   * Poll all subscribed repos.
   */
  private async pollAll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    const config = getConfig();
    if (!config.github.polling_enabled) {
      this.isPolling = false;
      return;
    }

    const repos = this.collectRepos();
    if (repos.length === 0) {
      console.log("[Poller] No repositories configured for polling.");
      this.isPolling = false;
      return;
    }

    console.log(`[Poller] Checking ${repos.length} repository(ies)...`);

    for (const repoFullName of repos) {
      try {
        await this.pollRepo(repoFullName);
      } catch (e: any) {
        if (e.status === 404) {
          console.warn(`[Poller] Repo not found: ${repoFullName}`);
        } else if (e.status === 403) {
          console.warn(`[Poller] Rate limited or forbidden for ${repoFullName}`);
          break; // Stop polling other repos if rate limited
        } else {
          console.error(`[Poller] Error polling ${repoFullName}:`, e.message);
        }
      }
    }

    this.isPolling = false;
  }

  /**
   * Poll a single repo for new events.
   */
  private async pollRepo(repoFullName: string): Promise<void> {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;

    const events = await this.fetchRepoEvents(owner, repo);

    if (!events || events.length === 0) {
      console.log(`[Poller] ${repoFullName}: No events found.`);
      return;
    }

    const lastId = getLastEventId(repoFullName);

    if (!lastId) {
      // First time polling this repo - set baseline without processing events
      console.log(`[Poller] ${repoFullName}: initializing baseline at event #${events[0].id}`);
      setLastEventId(repoFullName, String(events[0].id));
      return;
    }

    // Find new events (events are sorted newest first)
    const newEvents: any[] = [];
    let foundLastId = false;
    for (const event of events) {
      if (String(event.id) === lastId) {
        foundLastId = true;
        break;
      }
      newEvents.push(event);
    }

    if (!foundLastId && newEvents.length === events.length) {
      // lastId was not found even after paginating up to 300 events,
      // meaning the service was offline long enough for a large gap.
      console.warn(`[Poller] ${repoFullName}: lastId #${lastId} not found in recent events. Updating baseline to #${events[0].id}`);
      setLastEventId(repoFullName, String(events[0].id));
      return;
    }

    if (newEvents.length === 0) {
      return;
    }

    // Process in chronological order (oldest first)
    newEvents.reverse();

    console.log(`[Poller] ${repoFullName}: processing ${newEvents.length} new event(s)...`);

    // Persist the baseline in one batch write after the round instead of
    // atomically writing state.json after every single event (a 300-event
    // catch-up would otherwise hammer the disk 300 times).
    let lastProcessedId: string | null = null;
    let failedAtId: string | null = null;

    for (const event of newEvents) {
      const eventType = this.mapEventType(event.type || "");
      if (!eventType) {
        console.log(`[Poller] Skipping unhandled event type: ${event.type}`);
        continue;
      }

      console.log(`[Poller] Forwarding event ${eventType} (#${event.id}) for ${repoFullName}`);
      const payload = await normalizeEventPayload(event, repoFullName);
      if (payload) {
        try {
          await routeEvent(eventType, payload, this.bot);
          // Advance the baseline only up to the first failed event: later
          // successes are still delivered now, and the next round retries
          // from the failure (dedup prevents duplicates in the meantime).
          if (!failedAtId) {
            lastProcessedId = String(event.id);
          }
        } catch (e: any) {
          console.error(`[Poller] Failed to route event ${eventType}:`, e.message);
          if (!failedAtId) {
            failedAtId = String(event.id);
          }
        }
      }
    }

    if (lastProcessedId) {
      setLastEventId(repoFullName, lastProcessedId);
    }
  }

  /**
   * Fetch repo events with pagination (up to 3 pages x 100 events) so a
   * moderate outage does not silently drop missed events.
   */
  private async fetchRepoEvents(owner: string, repo: string): Promise<any[]> {
    const octokit = getOctokit();
    const all: any[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const { data } = await octokit.activity.listRepoEvents({
        owner,
        repo,
        per_page: 100,
        page,
      });
      if (!data || data.length === 0) break;
      for (const ev of data) {
        const key = String(ev.id);
        if (!seen.has(key)) {
          seen.add(key);
          all.push(ev);
        }
      }
      if (data.length < 100) break;
    }
    return all;
  }

  private collectRepos(): string[] {
    const repos = new Set<string>();
    for (const sub of getConfig().subscriptions) {
      if (sub.repo.includes("*")) continue;
      repos.add(sub.repo);
    }
    return Array.from(repos);
  }

  private async initializeRepo(repoFullName: string): Promise<void> {
    if (getLastEventId(repoFullName)) {
      return;
    }

    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      return;
    }

    const { data: events } = await getOctokit().activity.listRepoEvents({
      owner,
      repo,
      per_page: 1,
    });

    if (!events || events.length === 0) {
      console.log(`[Poller] ${repoFullName}: No events found during initialization.`);
      return;
    }

    setLastEventId(repoFullName, String(events[0].id));
    console.log(`[Poller] ${repoFullName}: baseline initialized at event #${events[0].id}`);
  }

  /**
   * Map GitHub Events API type names to webhook event names.
   */
  private mapEventType(apiType: string): string | null {
    const map: Record<string, string> = {
      PushEvent: "push",
      IssuesEvent: "issues",
      PullRequestEvent: "pull_request",
      ReleaseEvent: "release",
      WatchEvent: "star",
      ForkEvent: "fork",
      IssueCommentEvent: "issue_comment",
      CommitCommentEvent: "commit_comment",
      PullRequestReviewEvent: "pull_request_review",
      PullRequestReviewCommentEvent: "pull_request_review_comment",
    };
    return map[apiType] || null;
  }

}

/**
 * Normalize an Events API payload to look like a webhook payload.
 * Exported so it can be unit-tested without hitting the network.
 */
export async function normalizeEventPayload(
  event: any,
  repoFullName: string
): Promise<any> {
  const payload = event.payload || {};
  const [owner, repo] = repoFullName.split("/");

  // Preserve the event time for handlers that want it (e.g. star/fork cards)
  if (event.created_at && !payload.created_at) {
    payload.created_at = event.created_at;
  }

  // Add common fields that webhook payloads have
  if (!payload.repository) {
    payload.repository = {
      full_name: repoFullName,
      name: repo,
      owner: { login: owner },
    };
  }

  if (!payload.sender && event.actor) {
    payload.sender = {
      login: event.actor.login,
      avatar_url: event.actor.avatar_url,
    };
  }

  // PushEvent normalization
  if (event.type === "PushEvent") {
    payload.ref = payload.ref || "";
    if (payload.ref && !payload.ref.startsWith("refs/")) {
      payload.ref = `refs/heads/${payload.ref}`;
    }
    // The Events API returns commit objects with `sha` but no `id`, while the
    // webhook payload uses `id`. Handlers rely on `c.id` for short SHAs, so
    // map `sha` -> `id` here (otherwise polling push events always crash).
    payload.commits = (payload.commits || []).map((c: any) => ({
      ...c,
      id: c.id || c.sha,
    }));
    payload.compare = `https://github.com/${repoFullName}/compare/${payload.before?.substring(0, 12)}...${payload.head?.substring(0, 12)}`;
  }

  // IssuesEvent normalization
  if (event.type === "IssuesEvent") {
    payload.issue = payload.issue || {};
  }

  // PullRequestEvent normalization
  // GitHub Events API (since late 2025) strips most fields from pull_request,
  // including title. We must fetch the full PR if title is missing.
  if (event.type === "PullRequestEvent") {
    payload.pull_request = payload.pull_request || {};
    const prNumber = payload.pull_request.number ?? payload.number;
    if (!payload.pull_request.title && prNumber) {
      try {
        console.log(`[Poller] Fetching full PR details for ${repoFullName}#${prNumber} (title missing from Events API)`);
        const fullPr = await getPullRequest(owner, repo, prNumber);
        // Merge full PR data into the payload, preserving any fields already present
        payload.pull_request = { ...fullPr, ...payload.pull_request };
      } catch (e: any) {
        console.warn(`[Poller] Failed to fetch PR details for ${repoFullName}#${prNumber}:`, e.message);
      }
    }
  }

  // ReleaseEvent normalization
  if (event.type === "ReleaseEvent") {
    payload.release = payload.release || {};
  }

  // WatchEvent -> Star normalization
  if (event.type === "WatchEvent") {
    payload.action = "created";
  }

  // ForkEvent normalization
  if (event.type === "ForkEvent") {
    payload.forkee = payload.forkee || {};
  }

  // IssueCommentEvent normalization
  if (event.type === "IssueCommentEvent") {
    payload.issue = payload.issue || {};
    payload.comment = payload.comment || {};
  }

  // CommitCommentEvent normalization
  if (event.type === "CommitCommentEvent") {
    payload.comment = payload.comment || {};
  }

  // PullRequestReviewEvent normalization
  // Same issue: title is stripped from pull_request in Events API.
  if (event.type === "PullRequestReviewEvent") {
    payload.pull_request = payload.pull_request || {};
    payload.review = payload.review || {};
    const prNumber = payload.pull_request.number;
    if (!payload.pull_request.title && prNumber) {
      try {
        console.log(`[Poller] Fetching full PR details for ${repoFullName}#${prNumber} (review event, title missing)`);
        const fullPr = await getPullRequest(owner, repo, prNumber);
        payload.pull_request = { ...fullPr, ...payload.pull_request };
      } catch (e: any) {
        console.warn(`[Poller] Failed to fetch PR details for ${repoFullName}#${prNumber}:`, e.message);
      }
    }
  }

  // PullRequestReviewCommentEvent normalization
  // Same issue: title is stripped from pull_request in Events API.
  if (event.type === "PullRequestReviewCommentEvent") {
    payload.pull_request = payload.pull_request || {};
    payload.comment = payload.comment || {};
    const prNumber = payload.pull_request.number;
    if (!payload.pull_request.title && prNumber) {
      try {
        console.log(`[Poller] Fetching full PR details for ${repoFullName}#${prNumber} (review comment event, title missing)`);
        const fullPr = await getPullRequest(owner, repo, prNumber);
        payload.pull_request = { ...fullPr, ...payload.pull_request };
      } catch (e: any) {
        console.warn(`[Poller] Failed to fetch PR details for ${repoFullName}#${prNumber}:`, e.message);
      }
    }
  }

  return payload;
}
