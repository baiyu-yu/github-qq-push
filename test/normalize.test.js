const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeEventPayload } = require("../dist/github/poller");

test("PushEvent commits map sha -> id (Events API has no id)", async () => {
  const payload = await normalizeEventPayload(
    {
      type: "PushEvent",
      payload: {
        ref: "main",
        before: "aaaaaaaaaaaa",
        head: "bbbbbbbbbbbb",
        commits: [{ sha: "abc1234", message: "m" }],
      },
      actor: { login: "octocat" },
      created_at: "2026-01-01T00:00:00Z",
    },
    "owner/repo"
  );

  assert.equal(payload.commits[0].id, "abc1234");
  assert.equal(payload.ref, "refs/heads/main");
  assert.equal(payload.repository.full_name, "owner/repo");
  assert.equal(payload.sender.login, "octocat");
  assert.equal(payload.created_at, "2026-01-01T00:00:00Z");
});

test("PushEvent keeps an existing commit id", async () => {
  const payload = await normalizeEventPayload(
    {
      type: "PushEvent",
      payload: { commits: [{ id: "webhook-id", sha: "abc1234" }] },
    },
    "owner/repo"
  );
  assert.equal(payload.commits[0].id, "webhook-id");
});

test("IssueCommentEvent gets issue/comment defaults", async () => {
  const payload = await normalizeEventPayload(
    { type: "IssueCommentEvent", payload: {} },
    "owner/repo"
  );
  assert.ok(payload.issue);
  assert.ok(payload.comment);
});
