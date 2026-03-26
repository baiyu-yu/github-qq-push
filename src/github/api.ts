import { Octokit } from "@octokit/rest";
import { GitHubConfig } from "../config";

let octokits: Octokit[] = [];
let currentIndex = 0;

export function initGitHubApi(config: GitHubConfig): void {
  octokits = [];
  
  // Extract unique tokens from access_tokens (and legacy access_token for safety)
  const tokens = new Set<string>();
  if (config.access_token) tokens.add(config.access_token);
  if (config.access_tokens) {
    for (const t of config.access_tokens) {
      if (t.trim()) tokens.add(t.trim());
    }
  }

  const tokenArray = Array.from(tokens);

  if (tokenArray.length === 0) {
    // Unauthenticated instance
    octokits.push(new Octokit({
      request: { headers: { Accept: "application/vnd.github+json" } }
    }));
    console.log("[GitHub API] Initialized 1 pool instance (unauthenticated)");
  } else {
    for (const token of tokenArray) {
      octokits.push(new Octokit({
        auth: token,
        request: { headers: { Accept: "application/vnd.github+json" } }
      }));
    }
    console.log(`[GitHub API] Initialized ${octokits.length} pool instance(s) (authenticated)`);
  }
}

export function getOctokit(): Octokit {
  if (!octokits || octokits.length === 0) {
    throw new Error("[GitHub API] Not initialized. Call initGitHubApi first.");
  }
  // Round-robin selection
  const octokit = octokits[currentIndex];
  currentIndex = (currentIndex + 1) % octokits.length;
  return octokit;
}

/**
 * Fetch repo details
 */
export async function getRepo(owner: string, repo: string) {
  const { data } = await getOctokit().repos.get({ owner, repo });
  return data;
}

/**
 * Fetch issue/PR details
 */
export async function getIssue(
  owner: string,
  repo: string,
  issueNumber: number
) {
  const { data } = await getOctokit().issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return data;
}

/**
 * Fetch PR details
 */
export async function getPullRequest(
  owner: string,
  repo: string,
  pullNumber: number
) {
  const { data } = await getOctokit().pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return data;
}

/**
 * Fetch release details
 */
export async function getRelease(
  owner: string,
  repo: string,
  releaseId: number
) {
  const { data } = await getOctokit().repos.getRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  return data;
}

/**
 * Fetch user avatar URL (returns URL string)
 */
export function getAvatarUrl(login: string, size = 80): string {
  return `https://github.com/${login}.png?size=${size}`;
}

/**
 * Fetch rate limit info
 */
export async function getRateLimit() {
  const { data } = await getOctokit().rateLimit.get();
  return data.rate;
}
