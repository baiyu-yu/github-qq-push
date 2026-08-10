const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let tmpDir;
let originalCwd;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghqq-route-test-"));
  process.chdir(tmpDir);
  writeConfig([
    {
      repo: "owner/repo",
      targets: [{ type: "group", id: "1", events: ["push"] }],
    },
  ]);

  // Stub the renderer so tests never launch Chromium.
  const rendererPath = require.resolve("../dist/renderer");
  require.cache[rendererPath] = {
    id: rendererPath,
    filename: rendererPath,
    loaded: true,
    exports: {
      renderTemplate: async () => "QUJD",
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
const { getEventFingerprint, isEventProcessed } = require("../dist/github/dedup");

test("push event with Events API commits (sha, no id) routes without crashing", async () => {
  configMod.loadConfig();
  const sent = [];
  const bot = {
    sendImageToTarget: async (target, image, fallback) => {
      sent.push({ target, image, fallback });
    },
    sendTextToTarget: async () => {},
  };

  const payload = {
    repository: { full_name: "owner/repo" },
    sender: { login: "octocat" },
    ref: "refs/heads/main",
    commits: [
      { sha: "abc1234deadbeef", message: "first line\nsecond", author: { name: "octocat" } },
    ],
    compare: "https://github.com/owner/repo/compare/a...b",
  };

  await routeEvent("push", payload, bot);
  assert.equal(sent.length, 1);
  assert.match(sent[0].fallback, /abc1234/);
  assert.match(sent[0].fallback, /first line/);
});

test("failed route rolls back the dedup mark so the event can be retried", async () => {
  configMod.loadConfig();
  const bot = {
    sendImageToTarget: async () => {
      throw new Error("image send failed");
    },
    sendTextToTarget: async () => {
      throw new Error("text send failed");
    },
  };

  const payload = {
    repository: { full_name: "owner/repo" },
    sender: { login: "octocat" },
    ref: "refs/heads/main",
    commits: [{ id: "abc5678deadbeef", message: "msg", author: { name: "octocat" } }],
    compare: "https://github.com/owner/repo/compare/a...b",
  };
  const fp = getEventFingerprint("push", payload);
  assert.ok(fp);

  await assert.rejects(() => routeEvent("push", payload, bot));
  assert.equal(isEventProcessed(fp), false);
});

test("successful route keeps the dedup mark", async () => {
  configMod.loadConfig();
  const bot = {
    sendImageToTarget: async () => {},
    sendTextToTarget: async () => {},
  };

  const payload = {
    repository: { full_name: "owner/repo" },
    sender: { login: "octocat" },
    ref: "refs/heads/main",
    commits: [{ id: "abc9999deadbeef", message: "msg", author: { name: "octocat" } }],
    compare: "https://github.com/owner/repo/compare/a...b",
  };
  const fp = getEventFingerprint("push", payload);

  await routeEvent("push", payload, bot);
  assert.equal(isEventProcessed(fp), true);
});
