const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let tmpDir;
let originalCwd;
let renderCalls;

function writeConfig(subscriptions) {
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify(
      {
        onebot: { ws_url: "ws://127.0.0.1:3001", access_token: "", command_prefix: "/", masters: [] },
        github: { webhook_port: 7890, access_tokens: [] },
        webui: { username: "admin", password: "" },
        subscriptions,
      },
      null,
      2
    )
  );
}

before(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghqq-edit-test-"));
  process.chdir(tmpDir);
  writeConfig([
    {
      repo: "owner/repo",
      targets: [
        {
          type: "group",
          id: "1",
          events: [
            "issues",
            "pull_request",
            "issue_comment",
            "commit_comment",
            "pull_request_review_comment",
          ],
        },
      ],
    },
  ]);

  // Stub the renderer so tests never launch Chromium.
  renderCalls = [];
  const rendererPath = require.resolve("../dist/renderer");
  require.cache[rendererPath] = {
    id: rendererPath,
    filename: rendererPath,
    loaded: true,
    exports: {
      renderTemplate: async (_name, data) => {
        renderCalls.push(data || {});
        return "QUJD";
      },
      markdownToHtml: (md) => String(md || ""),
    },
  };
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const configMod = require("../dist/config");
const { routeEvent } = require("../dist/handlers");

function makeBot() {
  const sent = [];
  return {
    sent,
    sendImageToTarget: async (target, image, fallback) => {
      sent.push({ target, image, fallback });
    },
    sendTextToTarget: async () => {},
  };
}

test("issue edited (title change) is pushed", async () => {
  configMod.loadConfig();
  const bot = makeBot();
  await routeEvent(
    "issues",
    {
      action: "edited",
      changes: { title: { from: "旧标题" }, body: { from: "旧正文" } },
      issue: {
        id: 1001,
        number: 7,
        title: "新标题",
        body: "新正文",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/7",
        labels: [],
        comments: 0,
        reactions: { total_count: 0 },
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "octocat" },
    },
    bot
  );
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0].fallback, /Issue Edited/);
  assert.match(bot.sent[0].fallback, /编辑了 Issue/);
  assert.match(bot.sent[0].fallback, /标题：旧标题 → 新标题/);
  assert.equal(renderCalls.length, 1);
  assert.match(renderCalls[0].editInfo, /标题：旧标题/);
  assert.match(renderCalls[0].editInfo, /正文已修改/);
});

test("pull_request edited is pushed", async () => {
  configMod.loadConfig();
  const bot = makeBot();
  await routeEvent(
    "pull_request",
    {
      action: "edited",
      changes: { title: { from: "旧PR标题" } },
      pull_request: {
        id: 2001,
        number: 12,
        title: "新PR标题",
        body: "PR正文",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        html_url: "https://github.com/owner/repo/pull/12",
        labels: [],
        comments: 0,
        reactions: { total_count: 0 },
        head: { label: "owner:feat" },
        base: { label: "owner:main" },
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "octocat" },
    },
    bot
  );
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0].fallback, /PR Edited/);
  assert.match(bot.sent[0].fallback, /编辑了 Pull Request/);
  assert.match(bot.sent[0].fallback, /标题：旧PR标题 → 新PR标题/);
});

test("commit_comment edited is pushed", async () => {
  configMod.loadConfig();
  const bot = makeBot();
  await routeEvent(
    "commit_comment",
    {
      action: "edited",
      changes: { body: { from: "旧评论" } },
      comment: {
        id: 3001,
        commit_id: "deadbeef1234567",
        body: "新评论",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        html_url: "https://github.com/owner/repo/commit/deadbeef#r3001",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "octocat" },
    },
    bot
  );
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0].fallback, /编辑了 Commit 评论/);
  assert.match(bot.sent[0].fallback, /修改: 评论已修改/);
});

test("pull_request_review_comment edited is pushed", async () => {
  configMod.loadConfig();
  const bot = makeBot();
  await routeEvent(
    "pull_request_review_comment",
    {
      action: "edited",
      changes: { body: { from: "旧行内评论" } },
      pull_request: {
        id: 2002,
        number: 13,
        title: "PR 13",
        html_url: "https://github.com/owner/repo/pull/13",
      },
      comment: {
        id: 4001,
        path: "src/a.ts",
        body: "新行内评论",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        html_url: "https://github.com/owner/repo/pull/13#discussion_r4001",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "octocat" },
    },
    bot
  );
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0].fallback, /编辑了审查评论/);
  assert.match(bot.sent[0].fallback, /修改: 评论已修改/);
});

test("issue_comment edited is still pushed (regression)", async () => {
  configMod.loadConfig();
  const bot = makeBot();
  await routeEvent(
    "issue_comment",
    {
      action: "edited",
      changes: { body: { from: "旧评论" } },
      issue: {
        id: 1002,
        number: 8,
        title: "Issue 8",
        html_url: "https://github.com/owner/repo/issues/8",
      },
      comment: {
        id: 5001,
        body: "新评论",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/8#issuecomment-5001",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "octocat" },
    },
    bot
  );
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0].fallback, /编辑了评论/);
  assert.match(bot.sent[0].fallback, /修改: 评论已修改/);
});
