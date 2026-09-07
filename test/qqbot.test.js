const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { QQBotClient } = require("../dist/qqbot/client");
const { createBotClient } = require("../dist/bot/factory");
const { handleMessage } = require("../dist/handlers/message");

test("QQBotClient derives valid Ed25519 keys from secret seed", () => {
  const secret = "test_bot_secret_123456";
  const { privateKey, publicKey } = QQBotClient.getEd25519KeysFromSecret(secret);

  assert.ok(privateKey);
  assert.ok(publicKey);

  const testMsg = Buffer.from("hello qqbot ed25519");
  const signature = crypto.sign(null, testMsg, privateKey);
  assert.strictEqual(signature.length, 64);

  const isValid = crypto.verify(null, testMsg, publicKey, signature);
  assert.strictEqual(isValid, true);

  // Invalid message should fail
  const isInvalid = crypto.verify(null, Buffer.from("corrupted"), publicKey, signature);
  assert.strictEqual(isInvalid, false);
});

test("QQBotClient handles Webhook OpCode 13 validation callback", async () => {
  const secret = "my_secret_key_abcdef";
  const client = new QQBotClient({
    mode: "webhook",
    app_id: "102030405",
    app_secret: secret,
    command_prefix: "/",
  });

  const plainToken = "test_plain_token_xyz";
  const eventTs = "1710001234";

  let responseStatus = 0;
  let responseData = null;

  const mockReq = {
    body: Buffer.from(
      JSON.stringify({
        op: 13,
        d: {
          plain_token: plainToken,
          event_ts: eventTs,
        },
      })
    ),
    headers: {},
  };

  const mockRes = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    },
  };

  await client.handleWebhookRequest(mockReq, mockRes);

  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.plain_token, plainToken);
  assert.ok(responseData.signature);

  // Verify that the signature returned can be verified using the public key
  const { publicKey } = QQBotClient.getEd25519KeysFromSecret(secret);
  const verifyMsg = Buffer.concat([
    Buffer.from(eventTs, "utf8"),
    Buffer.from(plainToken, "utf8"),
  ]);
  const isSigValid = crypto.verify(
    null,
    verifyMsg,
    publicKey,
    Buffer.from(responseData.signature, "hex")
  );
  assert.strictEqual(isSigValid, true);
});

test("QQBotClient validates incoming Webhook signature for OpCode 0 events", async () => {
  const secret = "my_secret_key_abcdef";
  const client = new QQBotClient({
    mode: "webhook",
    app_id: "102030405",
    app_secret: secret,
    command_prefix: "/",
  });

  const { privateKey } = QQBotClient.getEd25519KeysFromSecret(secret);
  const timestamp = "1710005678";
  const rawBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg_9988",
        content: "/status",
        author: { id: "USER_OPENID_1" },
      },
    })
  );

  const signMsg = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
  const validSigHex = crypto.sign(null, signMsg, privateKey).toString("hex");

  let receivedMessage = null;
  client.onMessageCallback = async (msg) => {
    receivedMessage = msg;
  };

  // 1. Valid signature -> 200 and dispatches
  let respStatus = 0;
  let respData = null;
  const mockReqValid = {
    body: rawBody,
    headers: {
      "x-signature-ed25519": validSigHex,
      "x-signature-timestamp": timestamp,
    },
  };
  const mockResValid = {
    status(code) {
      respStatus = code;
      return this;
    },
    json(data) {
      respData = data;
      return this;
    },
  };

  await client.handleWebhookRequest(mockReqValid, mockResValid);
  assert.strictEqual(respStatus, 200);
  assert.strictEqual(respData.ok, true);

  // Give tick for async dispatch
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(receivedMessage);
  assert.strictEqual(receivedMessage.raw_message, "/status");
  assert.strictEqual(receivedMessage.user_id, "USER_OPENID_1");

  // 2. Corrupted signature -> 401
  let badRespStatus = 0;
  const mockReqBad = {
    body: rawBody,
    headers: {
      "x-signature-ed25519": "0".repeat(128),
      "x-signature-timestamp": timestamp,
    },
  };
  const mockResBad = {
    status(code) {
      badRespStatus = code;
      return this;
    },
    json() {
      return this;
    },
  };

  await client.handleWebhookRequest(mockReqBad, mockResBad);
  assert.strictEqual(badRespStatus, 401);
});

test("QQBotClient normalizes GROUP_AT_MESSAGE_CREATE events", () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec",
    command_prefix: "/",
  });

  const eventPayload = {
    id: "msg_group_123",
    group_openid: "GROUP_OPENID_ABC",
    content: " /help",
    timestamp: "2026-09-07T12:00:00Z",
    author: {
      id: "MEMBER_OPENID_XYZ",
      username: "CoderAlice",
    },
    message_reference: {
      message_id: "replied_msg_789",
    },
  };

  const normalized = client.normalizeMessage("GROUP_AT_MESSAGE_CREATE", eventPayload);

  assert.strictEqual(normalized.post_type, "message");
  assert.strictEqual(normalized.message_type, "group");
  assert.strictEqual(normalized.group_id, "GROUP_OPENID_ABC");
  assert.strictEqual(normalized.user_id, "MEMBER_OPENID_XYZ");
  assert.strictEqual(normalized.message_id, "msg_group_123");
  assert.strictEqual(
    normalized.raw_message,
    "[CQ:reply,id=replied_msg_789] /help"
  );
  assert.strictEqual(normalized.sender.nickname, "CoderAlice");

  assert.strictEqual(normalized.message.length, 2);
  assert.strictEqual(normalized.message[0].type, "reply");
  assert.strictEqual(normalized.message[0].data.id, "replied_msg_789");
  assert.strictEqual(normalized.message[1].type, "text");
  assert.strictEqual(normalized.message[1].data.text, "/help");
});

test("QQBotClient normalizes C2C_MESSAGE_CREATE events", () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec",
    command_prefix: "/",
  });

  const eventPayload = {
    id: "msg_c2c_456",
    content: "/status",
    timestamp: "2026-09-07T12:00:00Z",
    author: {
      id: "USER_OPENID_BOB",
      username: "Bob",
    },
  };

  const normalized = client.normalizeMessage("C2C_MESSAGE_CREATE", eventPayload);

  assert.strictEqual(normalized.post_type, "message");
  assert.strictEqual(normalized.message_type, "private");
  assert.strictEqual(normalized.group_id, undefined);
  assert.strictEqual(normalized.user_id, "USER_OPENID_BOB");
  assert.strictEqual(normalized.raw_message, "/status");
  assert.strictEqual(normalized.sender.nickname, "Bob");
});

test("QQBotClient normalizes GROUP_MESSAGE_CREATE (full mode) events and strips leading mentions", () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec",
    command_prefix: "/",
  });

  // Example 1: Full mode plain text without @bot
  const eventPayload1 = {
    id: "ROBOT1.0_full_mode_msg_1",
    group_openid: "GROUP_OPENID_FULL",
    content: "/status",
    timestamp: "2026-09-07T12:00:00Z",
    author: {
      id: "MEMBER_OPENID_1",
      member_openid: "MEMBER_OPENID_1",
      member_role: "member",
      username: "Alice",
      bot: false,
    },
  };

  const normalized1 = client.normalizeMessage("GROUP_MESSAGE_CREATE", eventPayload1);
  assert.strictEqual(normalized1.post_type, "message");
  assert.strictEqual(normalized1.message_type, "group");
  assert.strictEqual(normalized1.group_id, "GROUP_OPENID_FULL");
  assert.strictEqual(normalized1.user_id, "MEMBER_OPENID_1");
  assert.strictEqual(normalized1.message_id, "ROBOT1.0_full_mode_msg_1");
  assert.strictEqual(normalized1.raw_message, "/status");
  assert.strictEqual(normalized1.sender.nickname, "Alice");
  assert.strictEqual(normalized1.sender.role, "member");

  // Example 2: Message with leading bot mention "<@!102030405> /help"
  const eventPayload2 = {
    id: "ROBOT1.0_full_mode_msg_2",
    group_openid: "GROUP_OPENID_FULL",
    content: "<@!102030405> /help",
    timestamp: "2026-09-07T12:05:00Z",
    author: {
      id: "MEMBER_OPENID_2",
      member_role: "admin",
      username: "Bob",
    },
  };

  const normalized2 = client.normalizeMessage("GROUP_MESSAGE_CREATE", eventPayload2);
  assert.strictEqual(normalized2.raw_message, "/help");
  assert.strictEqual(normalized2.message[0].data.text, "/help");
});

test("QQBotClient handles passive text messages with auto-incrementing msg_seq", async () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec_123",
    command_prefix: "/",
  });

  client.getAccessToken = async () => "mock_token";

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "msg_sent_" + calls.length }),
      text: async () => "",
    };
  };

  try {
    const triggeringMsgId = "ROBOT1.0_trigger_123";

    // First reply to triggeringMsgId -> msg_seq should be 1
    await client.sendGroupText("GROUP_1", "First passive reply", {
      msgId: triggeringMsgId,
    });
    assert.strictEqual(calls.length, 1);
    const body1 = JSON.parse(calls[0].options.body);
    assert.strictEqual(body1.msg_id, triggeringMsgId);
    assert.strictEqual(body1.msg_seq, 1);
    assert.strictEqual(body1.content, "First passive reply");

    // Second reply to triggeringMsgId -> msg_seq should auto-increment to 2
    await client.sendGroupText("GROUP_1", "Second passive reply", {
      msgId: triggeringMsgId,
    });
    assert.strictEqual(calls.length, 2);
    const body2 = JSON.parse(calls[1].options.body);
    assert.strictEqual(body2.msg_id, triggeringMsgId);
    assert.strictEqual(body2.msg_seq, 2);
    assert.strictEqual(body2.content, "Second passive reply");

    // Proactive message without msgId -> active message (no msg_id, no msg_seq)
    await client.sendGroupText("GROUP_1", "Active GitHub push notification");
    assert.strictEqual(calls.length, 3);
    const body3 = JSON.parse(calls[2].options.body);
    assert.strictEqual(body3.msg_id, undefined);
    assert.strictEqual(body3.msg_seq, undefined);
    assert.strictEqual(body3.content, "Active GitHub push notification");
  } finally {
    global.fetch = originalFetch;
  }
});

test("QQBotClient sends passive images using two-step upload (file_info) and message send", async () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec_123",
    command_prefix: "/",
  });

  client.getAccessToken = async () => "mock_token";

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/files")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          file_uuid: "uuid_123",
          file_info: "FILE_INFO_HASH_ABC",
          ttl: 3600,
        }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "msg_media_resp_123" }),
      text: async () => "",
    };
  };

  try {
    const triggeringMsgId = "ROBOT1.0_trigger_image";

    // 1. Send passive image with msgId
    await client.sendGroupImage(
      "GROUP_1",
      "base64_image_content",
      "Status card fallback",
      { msgId: triggeringMsgId }
    );

    // Two API calls expected:
    // Call 0: POST /files with srv_send_msg: false
    // Call 1: POST /messages with msg_type: 7, media: { file_info: "FILE_INFO_HASH_ABC" }, msg_id, msg_seq: 1
    assert.strictEqual(calls.length, 2);

    assert.strictEqual(
      calls[0].url,
      "https://api.sgroup.qq.com/v2/groups/GROUP_1/files"
    );
    const uploadBody = JSON.parse(calls[0].options.body);
    assert.strictEqual(uploadBody.file_type, 1);
    assert.strictEqual(uploadBody.srv_send_msg, false);
    assert.strictEqual(uploadBody.file_data, "base64_image_content");

    assert.strictEqual(
      calls[1].url,
      "https://api.sgroup.qq.com/v2/groups/GROUP_1/messages"
    );
    const msgBody = JSON.parse(calls[1].options.body);
    assert.strictEqual(msgBody.msg_type, 7);
    assert.strictEqual(msgBody.media.file_info, "FILE_INFO_HASH_ABC");
    assert.strictEqual(msgBody.msg_id, triggeringMsgId);
    assert.strictEqual(msgBody.msg_seq, 1);

    // Metadata should be saved for fallbackText
    assert.strictEqual(
      client.getMessageMetadata("msg_media_resp_123"),
      "Status card fallback"
    );

    // 2. Send active image without msgId
    calls.length = 0;
    await client.sendGroupImage(
      "GROUP_1",
      "base64_active_push_image",
      "Push fallback"
    );

    // Single API call expected to /files with srv_send_msg: true
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].url,
      "https://api.sgroup.qq.com/v2/groups/GROUP_1/files"
    );
    const activeUploadBody = JSON.parse(calls[0].options.body);
    assert.strictEqual(activeUploadBody.srv_send_msg, true);
    assert.strictEqual(activeUploadBody.file_data, "base64_active_push_image");
  } finally {
    global.fetch = originalFetch;
  }
});

test("createBotClient factory instantiates QQBotClient when protocol is qqbot", () => {
  const config = {
    protocol: "qqbot",
    onebot: { ws_url: "", access_token: "", command_prefix: "/" },
    qqbot: {
      mode: "webhook",
      app_id: "998877",
      app_secret: "secret9988",
      sandbox: true,
      webhook_path: "/custom/webhook",
      command_prefix: "#",
      masters: ["MASTER_1"],
    },
    github: { webhook_port: 7890 },
    subscriptions: [],
  };

  const bot = createBotClient(config);
  assert.strictEqual(bot.protocol, "qqbot");
  assert.strictEqual(bot.getMode(), "webhook");
  assert.strictEqual(bot.getApiBaseUrl(), "https://sandbox.api.sgroup.qq.com");
});

test("handleMessage dispatches passive replies carrying msgId and auto msg_seq to QQBotClient", async () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec_123",
    command_prefix: "/",
  });

  client.getAccessToken = async () => "mock_token";

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "msg_out_help" }),
      text: async () => "",
    };
  };

  try {
    // Incoming full mode message event "/help"
    const eventPayload = {
      id: "ROBOT1.0_user_cmd_help_99",
      group_openid: "GROUP_OPENID_HELP_TEST",
      content: "/help",
      author: {
        id: "USER_ALICE",
        username: "Alice",
      },
    };

    const normalized = client.normalizeMessage("GROUP_MESSAGE_CREATE", eventPayload);
    await handleMessage(normalized, client);

    // Verify response was sent as passive message with the triggering msgId
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].url,
      "https://api.sgroup.qq.com/v2/groups/GROUP_OPENID_HELP_TEST/messages"
    );
    const body = JSON.parse(calls[0].options.body);
    assert.strictEqual(body.msg_id, "ROBOT1.0_user_cmd_help_99");
    assert.strictEqual(body.msg_seq, 1);
    assert.ok(body.content.includes("GitHub QQ Push"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("handleMessage /id command simultaneously reports group ID and user ID for OneBot", async () => {
  const sentMessages = [];
  const mockOneBot = {
    protocol: "onebot",
    getConnectionState: () => ({ connected: true, stopped: false, attempts: 0, maxAttempts: 5 }),
    getBotInfo: () => ({ user_id: 10001, nickname: "OneBotAssistant" }),
    sendGroupText: async (gid, text) => {
      sentMessages.push({ type: "group", gid, text });
    },
    sendPrivateText: async (uid, text) => {
      sentMessages.push({ type: "private", uid, text });
    },
  };

  // 1. Group message
  const groupMsg = {
    post_type: "message",
    message_type: "group",
    group_id: 88812345,
    user_id: 666789,
    sender: { user_id: 666789, nickname: "Alice" },
    self_id: 10001,
    raw_message: "/id",
  };
  await handleMessage(groupMsg, mockOneBot);

  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].type, "group");
  assert.strictEqual(sentMessages[0].gid, "88812345");
  assert.ok(sentMessages[0].text.includes("[ID 查询] 协议: OneBot"));
  assert.ok(sentMessages[0].text.includes("群聊 (Group)"));
  assert.ok(sentMessages[0].text.includes("群号 (Group ID): 88812345"));
  assert.ok(sentMessages[0].text.includes("个人 QQ (User ID): 666789 (Alice)"));
  assert.ok(sentMessages[0].text.includes("机器人 ID: 10001"));
  assert.ok(sentMessages[0].text.includes("订阅目标配置 (Target): 88812345 (group)"));

  // 2. Private message
  const privMsg = {
    post_type: "message",
    message_type: "private",
    user_id: 666789,
    sender: { user_id: 666789, nickname: "Alice" },
    self_id: 10001,
    raw_message: "id", // direct "id" in private chat
  };
  await handleMessage(privMsg, mockOneBot);

  assert.strictEqual(sentMessages.length, 2);
  assert.strictEqual(sentMessages[1].type, "private");
  assert.strictEqual(sentMessages[1].uid, "666789");
  assert.ok(sentMessages[1].text.includes("私聊 (Private)"));
  assert.ok(sentMessages[1].text.includes("群号 (Group ID): 无 (私聊会话)"));
  assert.ok(sentMessages[1].text.includes("个人 QQ (User ID): 666789 (Alice)"));
  assert.ok(sentMessages[1].text.includes("订阅目标配置 (Target): 666789 (private)"));
});

test("handleMessage /id command simultaneously reports group ID and user ID for Milky", async () => {
  const sentMessages = [];
  const mockMilky = {
    protocol: "milky",
    getConnectionState: () => ({ connected: true, stopped: false, attempts: 0, maxAttempts: 5 }),
    getBotInfo: () => ({ user_id: 20002, nickname: "MilkyBot" }),
    sendGroupText: async (gid, text) => {
      sentMessages.push({ type: "group", gid, text });
    },
    sendPrivateText: async (uid, text) => {
      sentMessages.push({ type: "private", uid, text });
    },
  };

  const groupMsg = {
    post_type: "message",
    message_type: "group",
    group_id: 99998888,
    user_id: 777666,
    sender: { user_id: 777666, nickname: "Bob" },
    self_id: 20002,
    raw_message: "/myid",
  };
  await handleMessage(groupMsg, mockMilky);

  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].type, "group");
  assert.strictEqual(sentMessages[0].gid, "99998888");
  assert.ok(sentMessages[0].text.includes("[ID 查询] 协议: Milky"));
  assert.ok(sentMessages[0].text.includes("群号 (Group ID): 99998888"));
  assert.ok(sentMessages[0].text.includes("个人 QQ (User ID): 777666 (Bob)"));
  assert.ok(sentMessages[0].text.includes("订阅目标配置 (Target): 99998888 (group)"));
});

test("handleMessage /id command simultaneously reports group OpenID and user OpenID for QQBot with passive replies", async () => {
  const client = new QQBotClient({
    mode: "ws",
    app_id: "102030405",
    app_secret: "sec",
    command_prefix: "/",
  });

  client.accessToken = "mock_token";
  client.tokenExpiresAt = Date.now() + 3600000;

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "msg_out_id" }),
      text: async () => "",
    };
  };

  try {
    // 1. Group full mode /id message
    const groupPayload = {
      id: "MSG_ID_QQBOT_GROUP_01",
      group_openid: "GROUP_OPENID_XYZ_123",
      content: "/id",
      author: {
        id: "MEMBER_OPENID_CHARLIE_789",
        username: "Charlie",
      },
    };
    const normGroup = client.normalizeMessage("GROUP_MESSAGE_CREATE", groupPayload);
    await handleMessage(normGroup, client);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].url,
      "https://api.sgroup.qq.com/v2/groups/GROUP_OPENID_XYZ_123/messages"
    );
    const bodyGroup = JSON.parse(calls[0].options.body);
    assert.strictEqual(bodyGroup.msg_id, "MSG_ID_QQBOT_GROUP_01");
    assert.strictEqual(bodyGroup.msg_seq, 1);
    assert.ok(bodyGroup.content.includes("[ID 查询] 协议: QQBot"));
    assert.ok(bodyGroup.content.includes("群 OpenID: GROUP_OPENID_XYZ_123"));
    assert.ok(bodyGroup.content.includes("个人 OpenID: MEMBER_OPENID_CHARLIE_789 (Charlie)"));
    assert.ok(bodyGroup.content.includes("订阅目标配置 (Target): GROUP_OPENID_XYZ_123 (group)"));

    // 2. C2C private /id message
    const privPayload = {
      id: "MSG_ID_QQBOT_C2C_02",
      content: "/whoami",
      author: {
        id: "USER_OPENID_CHARLIE_789",
        username: "Charlie",
      },
    };
    const normPriv = client.normalizeMessage("C2C_MESSAGE_CREATE", privPayload);
    await handleMessage(normPriv, client);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(
      calls[1].url,
      "https://api.sgroup.qq.com/v2/users/USER_OPENID_CHARLIE_789/messages"
    );
    const bodyPriv = JSON.parse(calls[1].options.body);
    assert.strictEqual(bodyPriv.msg_id, "MSG_ID_QQBOT_C2C_02");
    assert.strictEqual(bodyPriv.msg_seq, 1);
    assert.ok(bodyPriv.content.includes("私聊 (Private)"));
    assert.ok(bodyPriv.content.includes("群 OpenID: 无 (私聊会话)"));
    assert.ok(bodyPriv.content.includes("个人 OpenID: USER_OPENID_CHARLIE_789 (Charlie)"));
    assert.ok(bodyPriv.content.includes("订阅目标配置 (Target): USER_OPENID_CHARLIE_789 (private)"));
  } finally {
    global.fetch = originalFetch;
  }
});


