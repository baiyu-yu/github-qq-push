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
        onebot: { ws_url: "ws://127.0.0.1:3001" },
        github: { webhook_port: 7890, access_tokens: [] },
        webui: { username: "admin", password: "" },
        subscriptions: subscriptions || [],
      },
      null,
      2
    )
  );
}

before(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghqq-config-test-"));
  process.chdir(tmpDir);
  writeConfig([]);
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const configMod = require("../dist/config");

test("findSubscribers isolates events per target", () => {
  writeConfig([
    {
      repo: "owner/repo",
      targets: [
        { type: "group", id: "1", events: ["push"] },
        { type: "group", id: "2", events: ["star"] },
      ],
    },
  ]);
  configMod.loadConfig();

  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "push").map((t) => t.id),
    ["1"]
  );
  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "star").map((t) => t.id),
    ["2"]
  );
  assert.deepEqual(configMod.findSubscribers("owner/repo", "issues"), []);
});

test("legacy block-level events are migrated to per-target events", () => {
  writeConfig([
    {
      repo: "old/repo",
      events: ["push", "issues"],
      targets: [{ type: "group", id: "3" }, { type: "group", id: "4" }],
    },
  ]);
  const cfg = configMod.loadConfig();

  assert.equal(cfg.subscriptions[0].events, undefined);
  assert.deepEqual(cfg.subscriptions[0].targets[0].events, ["push", "issues"]);
  assert.deepEqual(cfg.subscriptions[0].targets[1].events, ["push", "issues"]);
  assert.deepEqual(
    configMod.findSubscribers("old/repo", "issues").map((t) => t.id),
    ["3", "4"]
  );
});

test("addSubscription merges events only for the matching target", () => {
  writeConfig([
    {
      repo: "owner/repo",
      targets: [
        { type: "group", id: "1", events: ["push"] },
        { type: "group", id: "2", events: ["star"] },
      ],
    },
  ]);
  configMod.loadConfig();

  configMod.addSubscription("owner/repo", ["star"], {
    type: "group",
    id: "1",
  });

  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "star").map((t) => t.id).sort(),
    ["1", "2"]
  );
  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "push").map((t) => t.id),
    ["1"]
  );
});

test("removeSubscription removes events for one target only", () => {
  writeConfig([
    {
      repo: "owner/repo",
      targets: [
        { type: "group", id: "1", events: ["push", "star"] },
        { type: "group", id: "2", events: ["star"] },
      ],
    },
  ]);
  configMod.loadConfig();

  const result = configMod.removeSubscription(
    "owner/repo",
    { type: "group", id: "1" },
    ["star"]
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.remainingEvents, ["push"]);

  // Target 2 still receives star events
  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "star").map((t) => t.id),
    ["2"]
  );
  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "push").map((t) => t.id),
    ["1"]
  );
});

test("listSubscriptions returns events for the requested target", () => {
  writeConfig([
    {
      repo: "owner/repo",
      targets: [
        { type: "group", id: "1", events: ["push"] },
        { type: "private", id: "999", events: ["release"] },
      ],
    },
  ]);
  configMod.loadConfig();

  assert.deepEqual(
    configMod.listSubscriptions({ type: "private", id: "999" }),
    [{ repo: "owner/repo", events: ["release"] }]
  );
  assert.deepEqual(
    configMod.listSubscriptions({ type: "group", id: "1" }),
    [{ repo: "owner/repo", events: ["push"] }]
  );
});

test("findSubscribers matches 'edited' subscribed event", () => {
  writeConfig([
    {
      repo: "owner/repo",
      targets: [
        { type: "group", id: "1", events: ["issues"] },
        { type: "group", id: "2", events: ["edited"] },
        { type: "group", id: "3", events: ["star"] },
      ],
    },
  ]);
  configMod.loadConfig();

  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "issues").map((t) => t.id).sort(),
    ["1", "2"]
  );
  assert.deepEqual(
    configMod.findSubscribers("owner/repo", "star").map((t) => t.id),
    ["3"]
  );
});

test("getAvatarUrl returns default avatar when login is missing or empty", () => {
  const { getAvatarUrl } = require("../dist/github/api");
  assert.equal(getAvatarUrl("octocat"), "https://github.com/octocat.png?size=80");
  assert.equal(getAvatarUrl(""), "https://github.com/github.png?size=80");
  assert.equal(getAvatarUrl(undefined), "https://github.com/github.png?size=80");
});

test("saveConfig persists config using atomicWriteFileSync without throwing", () => {
  const stateMod = require("../dist/state");
  const cfg = configMod.loadConfig();
  cfg.render.concurrency = 4;
  cfg.render.max_queue_size = 100;
  cfg.render.max_screenshot_height = 40000;
  stateMod.saveConfig(cfg);

  const reloaded = configMod.loadConfig();
  assert.equal(reloaded.render.concurrency, 4);
  assert.equal(reloaded.render.max_queue_size, 100);
  assert.equal(reloaded.render.max_screenshot_height, 40000);
});
