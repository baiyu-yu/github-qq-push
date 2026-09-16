const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let tmpDir;
let originalCwd;

function writeMultiBotConfig(bots, subscriptions) {
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify(
      {
        bots,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghqq-multibot-test-"));
  process.chdir(tmpDir);

  // Stub renderer
  const rendererPath = require.resolve("../dist/renderer");
  require.cache[rendererPath] = {
    id: rendererPath,
    filename: rendererPath,
    loaded: true,
    exports: {
      renderTemplate: async () => "BASE64_IMAGE",
      markdownToHtml: (md) => String(md || ""),
    },
  };
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("BotManager routes push messages strictly to originating bot instance (在哪绑就在哪推)", async () => {
  const configMod = require("../dist/config");
  const { BotManager } = require("../dist/bot/manager");

  writeMultiBotConfig(
    [
      {
        id: "ob_main",
        name: "主号 OneBot",
        protocol: "onebot",
        enabled: true,
        onebot: { ws_url: "ws://127.0.0.1:3001", access_token: "", command_prefix: "/", masters: [] },
      },
      {
        id: "ob_sub",
        name: "小号 OneBot",
        protocol: "onebot",
        enabled: true,
        onebot: { ws_url: "ws://127.0.0.1:3002", access_token: "", command_prefix: "/", masters: [] },
      },
      {
        id: "qq_official",
        name: "官方机器人",
        protocol: "qqbot",
        enabled: true,
        qqbot: { mode: "ws", app_id: "test12345", app_secret: "secret12345", command_prefix: "/", masters: [] },
      },
    ],
    [
      {
        repo: "owner/repo-a",
        targets: [
          { type: "group", id: "1001", botId: "ob_main", events: ["push"] },
          { type: "group", id: "2002", botId: "ob_sub", events: ["push"] },
        ],
      },
      {
        repo: "owner/repo-b",
        targets: [
          { type: "group", id: "3003", botId: "qq_official", events: ["push"] },
        ],
      },
    ]
  );

  const cfg = configMod.loadConfig();
  assert.strictEqual(cfg.bots.length, 3);

  const botManager = new BotManager(cfg.bots);
  assert.strictEqual(botManager.getAllBots().length, 3);

  // Mock send on individual bots
  const sentRecords = {
    ob_main: [],
    ob_sub: [],
    qq_official: [],
  };

  const obMain = botManager.getBot("ob_main");
  obMain.sendImageToTarget = async (target, img, fallback) => {
    sentRecords.ob_main.push({ target, img, fallback });
  };
  obMain.sendTextToTarget = async (target, text) => {
    sentRecords.ob_main.push({ target, text });
  };

  const obSub = botManager.getBot("ob_sub");
  obSub.sendImageToTarget = async (target, img, fallback) => {
    sentRecords.ob_sub.push({ target, img, fallback });
  };
  obSub.sendTextToTarget = async (target, text) => {
    sentRecords.ob_sub.push({ target, text });
  };

  const qqOfficial = botManager.getBot("qq_official");
  qqOfficial.sendImageToTarget = async (target, img, fallback) => {
    sentRecords.qq_official.push({ target, img, fallback });
  };
  qqOfficial.sendTextToTarget = async (target, text) => {
    sentRecords.qq_official.push({ target, text });
  };

  // 1. Find subscribers for repo-a push
  const subsRepoA = configMod.findSubscribers("owner/repo-a", "push");
  assert.strictEqual(subsRepoA.length, 2);

  for (const t of subsRepoA) {
    await botManager.sendImageToTarget(t, "IMAGE_A", "fallback A");
  }

  // Verify: ob_main sent to target 1001 only; ob_sub sent to target 2002 only; qq_official sent nothing!
  assert.strictEqual(sentRecords.ob_main.length, 1);
  assert.strictEqual(sentRecords.ob_main[0].target.id, "1001");

  assert.strictEqual(sentRecords.ob_sub.length, 1);
  assert.strictEqual(sentRecords.ob_sub[0].target.id, "2002");

  assert.strictEqual(sentRecords.qq_official.length, 0);

  // 2. Find subscribers for repo-b push
  const subsRepoB = configMod.findSubscribers("owner/repo-b", "push");
  assert.strictEqual(subsRepoB.length, 1);
  for (const t of subsRepoB) {
    await botManager.sendImageToTarget(t, "IMAGE_B", "fallback B");
  }

  // Verify: qq_official received repo-b push; others received no new push
  assert.strictEqual(sentRecords.qq_official.length, 1);
  assert.strictEqual(sentRecords.qq_official[0].target.id, "3003");
  assert.strictEqual(sentRecords.ob_main.length, 1);
  assert.strictEqual(sentRecords.ob_sub.length, 1);

  // 3. Broadcast test: target without botId should dispatch to all
  await botManager.sendTextToTarget({ type: "group", id: "9999" }, "Broadcast message");
  assert.strictEqual(sentRecords.ob_main.length, 2);
  assert.strictEqual(sentRecords.ob_sub.length, 2);
  assert.strictEqual(sentRecords.qq_official.length, 2);
});

test("handleMessage /github sub and unsub scopes to current bot instance", async () => {
  const configMod = require("../dist/config");
  const { handleMessage } = require("../dist/handlers/message");

  const cfg = configMod.getConfig();

  // Create two distinct mock bot instances
  const mockBotA = {
    id: "bot_alpha",
    name: "Alpha 机器",
    protocol: "onebot",
    getConnectionState: () => ({ connected: true, stopped: false, attempts: 0, maxAttempts: 5 }),
    getBotInfo: () => ({ nickname: "Alpha", user_id: 11111 }),
    sendGroupText: async (groupId, text) => {
      mockBotA.lastReply = text;
    },
    sendPrivateText: async (userId, text) => {
      mockBotA.lastReply = text;
    },
  };

  const mockBotB = {
    id: "bot_beta",
    name: "Beta 机器",
    protocol: "onebot",
    getConnectionState: () => ({ connected: true, stopped: false, attempts: 0, maxAttempts: 5 }),
    getBotInfo: () => ({ nickname: "Beta", user_id: 22222 }),
    sendGroupText: async (groupId, text) => {
      mockBotB.lastReply = text;
    },
    sendPrivateText: async (userId, text) => {
      mockBotB.lastReply = text;
    },
  };

  // Stub getRepo so API validation passes
  const apiMod = require("../dist/github/api");
  apiMod.getRepo = async () => ({ full_name: "test-owner/test-repo" });

  // 1. User executes /github sub on Bot Alpha
  await handleMessage(
    {
      message_type: "group",
      group_id: 5555,
      raw_message: "/github sub test-owner/test-repo push",
      sender: { role: "admin", user_id: 123 },
    },
    mockBotA
  );

  assert.match(mockBotA.lastReply, /订阅成功: test-owner\/test-repo/);
  assert.match(mockBotA.lastReply, /Alpha 机器/);

  // Verify stored target has botId = "bot_alpha"
  const subsAlpha = configMod.listSubscriptions({ type: "group", id: "5555", botId: "bot_alpha" });
  assert.strictEqual(subsAlpha.length, 1);
  assert.strictEqual(subsAlpha[0].repo, "test-owner/test-repo");

  // Bot Beta should NOT see this subscription
  const subsBeta = configMod.listSubscriptions({ type: "group", id: "5555", botId: "bot_beta" });
  assert.strictEqual(subsBeta.length, 0);

  // 2. User executes /github sub on Bot Beta for same group but repo-2
  apiMod.getRepo = async () => ({ full_name: "test-owner/repo-two" });
  await handleMessage(
    {
      message_type: "group",
      group_id: 5555,
      raw_message: "/github sub test-owner/repo-two push",
      sender: { role: "admin", user_id: 123 },
    },
    mockBotB
  );

  assert.match(mockBotB.lastReply, /订阅成功: test-owner\/repo-two/);
  assert.match(mockBotB.lastReply, /Beta 机器/);

  // Verify list on Bot Beta
  const subsBetaAfter = configMod.listSubscriptions({ type: "group", id: "5555", botId: "bot_beta" });
  assert.strictEqual(subsBetaAfter.length, 1);
  assert.strictEqual(subsBetaAfter[0].repo, "test-owner/repo-two");

  // 3. User unsubs test-owner/test-repo on Bot Alpha
  await handleMessage(
    {
      message_type: "group",
      group_id: 5555,
      raw_message: "/github unsub test-owner/test-repo",
      sender: { role: "admin", user_id: 123 },
    },
    mockBotA
  );
  assert.match(mockBotA.lastReply, /已取消订阅仓库/);

  // Ensure Bot Alpha no longer has it, but Bot Beta's repo-two is still intact
  const subsAlphaFinal = configMod.listSubscriptions({ type: "group", id: "5555", botId: "bot_alpha" });
  assert.strictEqual(subsAlphaFinal.length, 0);

  const subsBetaFinal = configMod.listSubscriptions({ type: "group", id: "5555", botId: "bot_beta" });
  assert.strictEqual(subsBetaFinal.length, 1);
  assert.strictEqual(subsBetaFinal[0].repo, "test-owner/repo-two");
});

test("WebUI REST API endpoints allow CRUD operations on bot instances", async () => {
  const express = require("express");
  const { getWebUIRouter } = require("../dist/webui");
  const { BotManager } = require("../dist/bot/manager");
  const configMod = require("../dist/config");

  const cfg = configMod.loadConfig();
  const botManager = new BotManager(cfg.bots);

  const app = express();
  app.use(express.json());
  app.use(getWebUIRouter({ botManager, poller: null, currentPort: 7890 }));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // 1. GET /api/bots
    const resGet = await fetch(`${baseUrl}/bots`);
    const dataGet = await resGet.json();
    assert.strictEqual(resGet.status, 200);
    assert.ok(Array.isArray(dataGet));

    // 2. POST /api/bots (Add new bot)
    const resPost = await fetch(`${baseUrl}/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "new_bot_3",
        name: "第三方测试号",
        protocol: "onebot",
        enabled: true,
        onebot: { ws_url: "ws://127.0.0.1:3005" },
      }),
    });
    const dataPost = await resPost.json();
    assert.strictEqual(resPost.status, 200);
    assert.strictEqual(dataPost.success, true);
    assert.strictEqual(botManager.getBot("new_bot_3") !== undefined, true);

    // 3. PUT /api/bots/:id (Update bot)
    const resPut = await fetch(`${baseUrl}/bots/new_bot_3`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "new_bot_3",
        name: "已修改名称",
        protocol: "onebot",
        enabled: false,
        onebot: { ws_url: "ws://127.0.0.1:3006" },
      }),
    });
    const dataPut = await resPut.json();
    assert.strictEqual(resPut.status, 200);
    assert.strictEqual(dataPut.success, true);
    assert.strictEqual(botManager.getBot("new_bot_3").name, "已修改名称");

    // 4. DELETE /api/bots/:id (Delete bot)
    const resDel = await fetch(`${baseUrl}/bots/new_bot_3`, {
      method: "DELETE",
    });
    const dataDel = await resDel.json();
    assert.strictEqual(resDel.status, 200);
    assert.strictEqual(dataDel.success, true);
    assert.strictEqual(botManager.getBot("new_bot_3"), undefined);
  } finally {
    server.close();
  }
});

