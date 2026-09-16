const { test } = require("node:test");
const assert = require("node:assert");
const {
  parsePullRequestReference,
  parseCommitReference,
  handleMessage,
} = require("../dist/handlers/message");
const { addSubscription, removeSubscription, getConfig } = require("../dist/config");
const githubApi = require("../dist/github/api");
const renderer = require("../dist/renderer");

test("parsePullRequestReference correctly identifies all PR tag and event variants", () => {
  // Classic [PR]
  const r1 = parsePullRequestReference("[PR] vuejs/core#1234");
  assert.deepStrictEqual(r1, { owner: "vuejs", repo: "core", prNumber: 1234 });

  // Pushed notification fallback texts
  const r2 = parsePullRequestReference("[PR Opened] vuejs/core#5678: feat: new reactivity engine");
  assert.deepStrictEqual(r2, { owner: "vuejs", repo: "core", prNumber: 5678 });

  const r3 = parsePullRequestReference("[PR Merged] facebook/react#9999: merge pull request");
  assert.deepStrictEqual(r3, { owner: "facebook", repo: "react", prNumber: 9999 });

  const r4 = parsePullRequestReference("[PR Review] facebook/react #8888: review comment");
  assert.deepStrictEqual(r4, { owner: "facebook", repo: "react", prNumber: 8888 });

  const r5 = parsePullRequestReference("[PR Closed] owner/repo#42: closed stale");
  assert.deepStrictEqual(r5, { owner: "owner", repo: "repo", prNumber: 42 });

  const r6 = parsePullRequestReference("[PR Diff] owner/repo#77\nhttps://github.com/owner/repo/pull/77");
  assert.deepStrictEqual(r6, { owner: "owner", repo: "repo", prNumber: 77 });

  // URL variants
  const r7 = parsePullRequestReference("https://github.com/torvalds/linux/pull/101");
  assert.deepStrictEqual(r7, { owner: "torvalds", repo: "linux", prNumber: 101 });

  // Direct arguments
  const r8 = parsePullRequestReference("vercel/next.js 4321");
  assert.deepStrictEqual(r8, { owner: "vercel", repo: "next.js", prNumber: 4321 });

  const r9 = parsePullRequestReference("vercel/next.js#4321");
  assert.deepStrictEqual(r9, { owner: "vercel", repo: "next.js", prNumber: 4321 });
});

test("parseCommitReference correctly identifies Commit tags and URLs", () => {
  const c1 = parseCommitReference("[Commit] vuejs/core@abcdef1234567\nhttps://github.com/vuejs/core/commit/abcdef1");
  assert.deepStrictEqual(c1, { owner: "vuejs", repo: "core", commitSha: "abcdef1234567" });

  const c2 = parseCommitReference("https://github.com/facebook/react/commit/1234567890abcdef");
  assert.deepStrictEqual(c2, { owner: "facebook", repo: "react", commitSha: "1234567890abcdef" });

  const c3 = parseCommitReference("facebook/react@1234567890abcdef");
  assert.deepStrictEqual(c3, { owner: "facebook", repo: "react", commitSha: "1234567890abcdef" });

  const c4 = parseCommitReference("facebook/react 1234567890abcdef");
  assert.deepStrictEqual(c4, { owner: "facebook", repo: "react", commitSha: "1234567890abcdef" });
});

test("handleMessage preserves prototype methods on bot instance and executes /diff", async () => {
  class MockOneBot {
    constructor() {
      this.protocol = "onebot";
      this.metadataStore = new Map();
      this.sentTexts = [];
      this.sentImages = [];
    }
    getMessageMetadata(id) {
      return this.metadataStore.get(String(id));
    }
    storeMessageMetadata(id, meta) {
      this.metadataStore.set(String(id), meta);
    }
    getConnectionState() {
      return { connected: true, stopped: false, attempts: 0, maxAttempts: 5 };
    }
    async callApi(action, params) {
      return { action, params };
    }
    async sendGroupText(groupId, text, options) {
      this.sentTexts.push({ groupId, text, options });
    }
    async sendGroupImage(groupId, imageBase64, fallbackText, options) {
      this.sentImages.push({ groupId, imageBase64, fallbackText, options });
    }
    async sendPrivateText(userId, text, options) {
      this.sentTexts.push({ userId, text, options });
    }
    async sendPrivateImage(userId, imageBase64, fallbackText, options) {
      this.sentImages.push({ userId, imageBase64, fallbackText, options });
    }
    async sendImageToTarget(target, imageBase64, fallbackText, options) {
      this.sentImages.push({ target, imageBase64, fallbackText, options });
    }
    async sendTextToTarget(target, text, options) {
      this.sentTexts.push({ target, text, options });
    }
  }

  const mockBot = new MockOneBot();
  mockBot.storeMessageMetadata("1001", "[PR Opened] testowner/testrepo#42: feat: add new feature\nhttps://github.com/testowner/testrepo/pull/42");

  // Mock Octokit for PR
  const origGetOctokit = githubApi.getOctokit;
  const origRenderTemplate = renderer.renderTemplate;

  let octokitCalled = null;
  githubApi.getOctokit = () => ({
    pulls: {
      get: async ({ owner, repo, pull_number }) => {
        octokitCalled = { type: "pulls.get", owner, repo, pull_number };
        return {
          data: {
            number: pull_number,
            title: "feat: add new feature",
            state: "open",
            merged: false,
            created_at: new Date().toISOString(),
            html_url: `https://github.com/${owner}/${repo}/pull/${pull_number}`,
            user: { login: "alice" },
            comments: 3,
            changed_files: 1,
            additions: 10,
            deletions: 2,
          },
        };
      },
      listFiles: async ({ owner, repo, pull_number }) => {
        return {
          data: [
            {
              filename: "src/index.ts",
              status: "modified",
              additions: 10,
              deletions: 2,
              patch: "@@ -1,5 +1,13 @@\n-old code\n+new code",
            },
          ],
        };
      },
    },
    repos: {
      getCommit: async ({ owner, repo, ref }) => {
        octokitCalled = { type: "repos.getCommit", owner, repo, ref };
        return {
          data: {
            sha: ref,
            commit: {
              message: "fix: resolve critical crash",
              author: { name: "Bob", date: new Date().toISOString() },
            },
            author: { login: "bob" },
            html_url: `https://github.com/${owner}/${repo}/commit/${ref}`,
            stats: { additions: 5, deletions: 1 },
            files: [
              {
                filename: "src/crash.ts",
                status: "modified",
                additions: 5,
                deletions: 1,
                patch: "@@ -10,3 +10,7 @@\n+safeCheck();",
              },
            ],
          },
        };
      },
    },
  });

  renderer.renderTemplate = async (name, data) => `mock_rendered_image_for_${name}`;

  const prefix = getConfig().onebot?.command_prefix || "/";

  try {
    // 1. Test quote-replying to PR card with diff
    const replyPayload = {
      message_type: "group",
      group_id: 123456,
      message_id: 2001,
      raw_message: `[CQ:reply,id=1001] ${prefix}diff`,
      message: [
        { type: "reply", data: { id: "1001" } },
        { type: "text", data: { text: ` ${prefix}diff` } },
      ],
      sender: { user_id: 99999, role: "member" },
    };

    await handleMessage(replyPayload, mockBot);

    assert.strictEqual(octokitCalled?.type, "pulls.get");
    assert.strictEqual(octokitCalled?.owner, "testowner");
    assert.strictEqual(octokitCalled?.repo, "testrepo");
    assert.strictEqual(octokitCalled?.pull_number, 42);
    assert.strictEqual(mockBot.sentImages.length, 1);
    assert.ok(mockBot.sentImages[0].fallbackText.includes("[PR Diff] testowner/testrepo#42"));

    // 2. Test direct argument ${prefix}diff testowner/testrepo 99
    octokitCalled = null;
    mockBot.sentImages.length = 0;
    const directPayload = {
      message_type: "group",
      group_id: 123456,
      message_id: 2002,
      raw_message: `${prefix}diff testowner/testrepo 99`,
      message: [{ type: "text", data: { text: `${prefix}diff testowner/testrepo 99` } }],
      sender: { user_id: 99999, role: "member" },
    };

    await handleMessage(directPayload, mockBot);
    assert.strictEqual(octokitCalled?.pull_number, 99);
    assert.strictEqual(mockBot.sentImages.length, 1);

    // 3. Test backward-compatible alias ${prefix}detail testowner/testrepo 88
    octokitCalled = null;
    mockBot.sentImages.length = 0;
    const detailPayload = {
      message_type: "group",
      group_id: 123456,
      message_id: 2003,
      raw_message: `${prefix}detail testowner/testrepo 88`,
      message: [{ type: "text", data: { text: `${prefix}detail testowner/testrepo 88` } }],
      sender: { user_id: 99999, role: "member" },
    };

    await handleMessage(detailPayload, mockBot);
    assert.strictEqual(octokitCalled?.pull_number, 88);
    assert.strictEqual(mockBot.sentImages.length, 1);

    // 4. Test commit diff ${prefix}diff testowner/testrepo abc1234567890
    octokitCalled = null;
    mockBot.sentImages.length = 0;
    const commitPayload = {
      message_type: "group",
      group_id: 123456,
      message_id: 2004,
      raw_message: `${prefix}diff testowner/testrepo abc1234567890`,
      message: [{ type: "text", data: { text: `${prefix}diff testowner/testrepo abc1234567890` } }],
      sender: { user_id: 99999, role: "member" },
    };

    await handleMessage(commitPayload, mockBot);
    assert.strictEqual(octokitCalled?.type, "repos.getCommit");
    assert.strictEqual(octokitCalled?.ref, "abc1234567890");
    assert.strictEqual(mockBot.sentImages.length, 1);
    assert.ok(mockBot.sentImages[0].fallbackText.includes("[Commit Diff]"));

    // 5. Test single-repo fallback in subscribed group
    addSubscription("single/boundrepo", ["pull_request"], { type: "group", id: "555666" });
    try {
      octokitCalled = null;
      mockBot.sentImages.length = 0;
      const singleRepoPayload = {
        message_type: "group",
        group_id: 555666,
        message_id: 2005,
        raw_message: `${prefix}diff 77`,
        message: [{ type: "text", data: { text: `${prefix}diff 77` } }],
        sender: { user_id: 99999, role: "member" },
      };

      await handleMessage(singleRepoPayload, mockBot);
      assert.strictEqual(octokitCalled?.owner, "single");
      assert.strictEqual(octokitCalled?.repo, "boundrepo");
      assert.strictEqual(octokitCalled?.pull_number, 77);
      assert.strictEqual(mockBot.sentImages.length, 1);
    } finally {
      removeSubscription("single/boundrepo", { type: "group", id: "555666" });
    }

    // 6. Test invalid ${prefix}diff with no ref gives helpful usage guide
    mockBot.sentTexts.length = 0;
    const emptyPayload = {
      message_type: "group",
      group_id: 999111,
      message_id: 2006,
      raw_message: `${prefix}diff`,
      message: [{ type: "text", data: { text: `${prefix}diff` } }],
      sender: { user_id: 99999, role: "member" },
    };

    await handleMessage(emptyPayload, mockBot);
    assert.strictEqual(mockBot.sentTexts.length, 1);
    assert.ok(mockBot.sentTexts[0].text.includes("用法:"));
    assert.ok(mockBot.sentTexts[0].text.includes(`${prefix}diff <owner/repo> <PR编号>`));

    // 7. Test ${prefix}help renders help card as an image
    mockBot.sentImages.length = 0;
    const helpPayload = {
      message_type: "group",
      group_id: 999111,
      message_id: 2007,
      raw_message: `${prefix}help`,
      message: [{ type: "text", data: { text: `${prefix}help` } }],
      sender: { user_id: 99999, role: "member" },
    };

    await handleMessage(helpPayload, mockBot);
    assert.strictEqual(mockBot.sentImages.length, 1);
    assert.strictEqual(mockBot.sentImages[0].imageBase64, "mock_rendered_image_for_help");
    assert.ok(mockBot.sentImages[0].fallbackText.includes("可用命令:"));
  } finally {
    githubApi.getOctokit = origGetOctokit;
    renderer.renderTemplate = origRenderTemplate;
  }
});
