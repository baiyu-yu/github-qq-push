const { test } = require("node:test");
const assert = require("node:assert");
const { MilkyClient } = require("../dist/milky/client");
const { createBotClient } = require("../dist/bot/factory");

test("MilkyClient derives correct HTTP base and WS event URLs", () => {
  const client1 = new MilkyClient({
    endpoint: "http://127.0.0.1:3000/",
    access_token: "test_token",
    command_prefix: "/",
  });

  assert.strictEqual(client1.getHttpBaseUrl(), "http://127.0.0.1:3000");
  assert.strictEqual(
    client1.getWsEventUrl(),
    "ws://127.0.0.1:3000/event?access_token=test_token"
  );

  const client2 = new MilkyClient({
    endpoint: "ws://mybot.internal:8080",
    access_token: "",
    command_prefix: "/",
  });

  assert.strictEqual(client2.getHttpBaseUrl(), "http://mybot.internal:8080");
  assert.strictEqual(client2.getWsEventUrl(), "ws://mybot.internal:8080/event");
});

test("MilkyClient normalizes group message_receive events", () => {
  const client = new MilkyClient({
    endpoint: "http://127.0.0.1:3000",
    access_token: "",
    command_prefix: "/",
  });

  const rawMilkyEvent = {
    time: 1710000000,
    self_id: 10001,
    event_type: "message_receive",
    data: {
      message_scene: "group",
      peer_id: 99887766,
      message_seq: 45678,
      sender_id: 12345678,
      time: 1710000000,
      segments: [
        { type: "reply", data: { message_seq: 112233 } },
        { type: "text", data: { text: " /status" } },
      ],
      group: { group_id: 99887766, group_name: "Test Group" },
      group_member: {
        user_id: 12345678,
        nickname: "AdminUser",
        role: "admin",
      },
    },
  };

  const normalized = client.normalizeMessage(rawMilkyEvent);

  assert.strictEqual(normalized.post_type, "message");
  assert.strictEqual(normalized.message_type, "group");
  assert.strictEqual(normalized.group_id, 99887766);
  assert.strictEqual(normalized.user_id, 12345678);
  assert.strictEqual(normalized.message_id, 45678);
  assert.strictEqual(normalized.raw_message, "[CQ:reply,id=112233] /status");
  assert.strictEqual(normalized.sender.role, "admin");
  assert.strictEqual(normalized.sender.nickname, "AdminUser");

  // Check segments
  assert.strictEqual(normalized.message.length, 2);
  assert.strictEqual(normalized.message[0].type, "reply");
  assert.strictEqual(normalized.message[0].data.id, "112233");
  assert.strictEqual(normalized.message[1].type, "text");
  assert.strictEqual(normalized.message[1].data.text, " /status");
});

test("MilkyClient normalizes private message_receive events", () => {
  const client = new MilkyClient({
    endpoint: "http://127.0.0.1:3000",
    access_token: "",
    command_prefix: "/",
  });

  const rawMilkyEvent = {
    time: 1710000000,
    self_id: 10001,
    event_type: "message_receive",
    data: {
      message_scene: "friend",
      peer_id: 12345678,
      message_seq: 78901,
      sender_id: 12345678,
      time: 1710000000,
      segments: [{ type: "text", data: { text: "/help" } }],
      friend: { user_id: 12345678, nickname: "FriendUser" },
    },
  };

  const normalized = client.normalizeMessage(rawMilkyEvent);

  assert.strictEqual(normalized.message_type, "private");
  assert.strictEqual(normalized.group_id, undefined);
  assert.strictEqual(normalized.user_id, 12345678);
  assert.strictEqual(normalized.raw_message, "/help");
});

test("MilkyClient sends group messages with correct API payload and auth header", async () => {
  const requests = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        retcode: 0,
        data: { message_seq: 99999, time: 1710000000 },
      }),
    };
  };

  try {
    const client = new MilkyClient({
      endpoint: "http://127.0.0.1:3000",
      access_token: "secret123",
      command_prefix: "/",
    });

    // Test text message
    await client.sendGroupText("12345", "Hello Milky!");

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(
      requests[0].url,
      "http://127.0.0.1:3000/api/send_group_message"
    );
    assert.strictEqual(
      requests[0].options.headers["Authorization"],
      "Bearer secret123"
    );
    assert.strictEqual(requests[0].body.group_id, 12345);
    assert.strictEqual(requests[0].body.message[0].type, "text");
    assert.strictEqual(requests[0].body.message[0].data.text, "Hello Milky!");

    // Test image message
    await client.sendGroupImage("12345", "QUJDRA==", "Sample text");

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[1].body.group_id, 12345);
    assert.strictEqual(requests[1].body.message[0].type, "image");
    assert.strictEqual(requests[1].body.message[0].data.uri, "base64://QUJDRA==");

    // Verify metadata was saved for message_seq 99999
    assert.strictEqual(
      client.getMessageMetadata("99999"),
      "Sample text"
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("MilkyClient callApi get_group_list unwraps groups array", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        retcode: 0,
        data: {
          groups: [
            { group_id: 111, group_name: "Group 1" },
            { group_id: 222, group_name: "Group 2" },
          ],
        },
      }),
    };
  };

  try {
    const client = new MilkyClient({
      endpoint: "http://127.0.0.1:3000",
      access_token: "",
      command_prefix: "/",
    });

    const groups = await client.callApi("get_group_list");
    assert.ok(Array.isArray(groups));
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].group_name, "Group 1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("createBotClient factory instantiates correct protocol client", () => {
  const milkyBot = createBotClient({
    protocol: "milky",
    onebot: { ws_url: "ws://127.0.0.1:3001", access_token: "", command_prefix: "/" },
    milky: { endpoint: "http://127.0.0.1:3000", access_token: "tk", command_prefix: "!" },
    github: { webhook_port: 7890 },
    subscriptions: [],
  });
  assert.strictEqual(milkyBot.protocol, "milky");

  const onebotBot = createBotClient({
    protocol: "onebot",
    onebot: { ws_url: "ws://127.0.0.1:3001", access_token: "", command_prefix: "/" },
    github: { webhook_port: 7890 },
    subscriptions: [],
  });
  assert.strictEqual(onebotBot.protocol, "onebot");

  const defaultBot = createBotClient({
    onebot: { ws_url: "ws://127.0.0.1:3001", access_token: "", command_prefix: "/" },
    github: { webhook_port: 7890 },
    subscriptions: [],
  });
  assert.strictEqual(defaultBot.protocol, "onebot");
});
