import { Octokit } from "@octokit/rest";
import { GitHubConfig } from "../config";

let octokit: Octokit;

export function initGitHubApi(config: GitHubConfig): Octokit {
  octokit = new Octokit({
    auth: config.access_token || undefined,
    request: {
      headers: {
        Accept: "application/vnd.github+json",
      },
    },
  });
  console.log(
    `[GitHub API] Initialized${config.access_token ? " (authenticated)" : " (unauthenticated)"}`
  );
  return octokit;
}

export function getOctokit(): Octokit {
  if (!octokit) {
    throw new Error("[GitHub API] Not initialized. Call initGitHubApi first.");
  }
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
