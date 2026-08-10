const { test } = require("node:test");
const assert = require("node:assert");
const {
  getEventFingerprint,
  markEventProcessed,
  isEventProcessed,
  deleteProcessedEvent,
} = require("../dist/github/dedup");

test("star/watch fingerprints are identical regardless of action naming", () => {
  const webhookFp = getEventFingerprint("watch", {
    action: "started",
    sender: { login: "octocat" },
    repository: { full_name: "owner/repo" },
  });
  const pollerFp = getEventFingerprint("star", {
    action: "created",
    sender: { login: "octocat" },
    repository: { full_name: "owner/repo" },
  });
  assert.equal(webhookFp, pollerFp);
  assert.equal(webhookFp, "owner/repo:star:octocat");
});

test("push fingerprint includes ref and head sha", () => {
  const fp = getEventFingerprint("push", {
    ref: "refs/heads/main",
    after: "abc123",
    repository: { full_name: "owner/repo" },
  });
  assert.equal(fp, "owner/repo:push:refs/heads/main:abc123");
});

test("markEventProcessed / isEventProcessed deduplicate", () => {
  const fp = "owner/repo:issues:opened:42";
  assert.equal(isEventProcessed(fp), false);
  markEventProcessed(fp);
  assert.equal(isEventProcessed(fp), true);
});

test("unhandled event types return null fingerprint", () => {
  assert.equal(
    getEventFingerprint("some_future_event", {
      repository: { full_name: "owner/repo" },
    }),
    null
  );
});

test("deleteProcessedEvent removes the dedup mark", () => {
  const fp = "owner/repo:issues:opened:99";
  markEventProcessed(fp);
  assert.equal(isEventProcessed(fp), true);
  deleteProcessedEvent(fp);
  assert.equal(isEventProcessed(fp), false);
});
