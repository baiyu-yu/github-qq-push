const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { fillTemplate } = require("../dist/renderer");

test("fillTemplate clears unprovided placeholders such as editInfo or {{{editinfo}}}", () => {
  const tpl = `
    <div class="card">
      <div class="card-title">{{title}}</div>
      {{editInfo}}
      {{{editinfo}}}
      <div class="card-body">{{bodyHtml}}</div>
    </div>
  `;

  const rendered = fillTemplate(tpl, {
    title: "Test Title",
    bodyHtml: "Test Body",
  });

  assert.ok(!rendered.includes("{{editInfo}}"), "Should not contain {{editInfo}}");
  assert.ok(!rendered.includes("{{{editinfo}}}"), "Should not contain {{{editinfo}}}");
  assert.ok(rendered.includes("Test Title"), "Should contain title");
  assert.ok(rendered.includes("Test Body"), "Should contain bodyHtml");
});

test("fillTemplate injects editInfo when provided with various casings", () => {
  const tpl = `<div class="card">{{editInfo}}</div>`;

  const rendered1 = fillTemplate(tpl, {
    editInfo: "<div class=\"edit-info\">Edited</div>",
  });
  assert.ok(rendered1.includes("<div class=\"edit-info\">Edited</div>"));

  const rendered2 = fillTemplate(tpl, {
    editinfo: "<div class=\"edit-info\">Edited Lowercase</div>",
  });
  assert.ok(rendered2.includes("<div class=\"edit-info\">Edited Lowercase</div>"));
});

test("fillTemplate preserves {{brackets}} inside user data (bodyHtml, titles, etc.)", () => {
  const tpl = `<div class="card"><div class="title">{{title}}</div><div class="body">{{bodyHtml}}</div>{{editInfo}}</div>`;

  const rendered = fillTemplate(tpl, {
    title: "Fix bug with {{template}} tags",
    bodyHtml: "<p>Code snippet: <code>const x = {{hello_world}};</code></p>",
  });

  assert.ok(rendered.includes("Fix bug with {{template}} tags"));
  assert.ok(rendered.includes("const x = {{hello_world}};"));
  assert.ok(!rendered.includes("{{editInfo}}"));
});

test("actual issue.html template renders without leaving unreplaced {{editInfo}} when editInfo is omitted", () => {
  const issueTplPath = path.resolve(__dirname, "../src/renderer/templates/issue.html");
  const issueTpl = fs.readFileSync(issueTplPath, "utf-8");

  const rendered = fillTemplate(issueTpl, {
    badgeClass: "badge-pr-open",
    eventIcon: "",
    eventLabel: "PR Opened",
    repoFullName: "owner/repo",
    title: "Add awesome feature",
    number: 42,
    avatarUrl: "https://example.com/avatar.png",
    authorName: "octocat",
    actionText: "Pull Request details",
    timestamp: "2026/9/1 12:00:00",
    labelsHtml: "",
    bodyHtml: "PR body details",
    comments: 0,
    reactions: 0,
  });

  assert.ok(!rendered.includes("{{editInfo}}"), "Rendered issue.html should not have {{editInfo}}");
  assert.ok(!rendered.includes("{{{editinfo}}}"), "Rendered issue.html should not have {{{editinfo}}}");
  assert.ok(rendered.includes("Add awesome feature"), "Should contain title");
  assert.ok(rendered.includes("PR body details"), "Should contain bodyHtml");
});

const {
  parseCommitReference,
  parsePullRequestReference,
  parseIssueReference,
  parseRepoReference,
} = require("../dist/handlers/message");

test("parseCommitReference correctly identifies commit links and tags", () => {
  const ref1 = parseCommitReference("https://github.com/facebook/react/commit/7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b");
  assert.deepEqual(ref1, {
    owner: "facebook",
    repo: "react",
    commitSha: "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
  });

  const ref2 = parseCommitReference("[Commit] facebook/react@7a8b9c0");
  assert.deepEqual(ref2, {
    owner: "facebook",
    repo: "react",
    commitSha: "7a8b9c0",
  });

  const ref3 = parseCommitReference("facebook/react@7a8b9c0d1e2f3a4b5c6d");
  assert.deepEqual(ref3, {
    owner: "facebook",
    repo: "react",
    commitSha: "7a8b9c0d1e2f3a4b5c6d",
  });
});

test("parseIssueReference correctly identifies Issue links and tags", () => {
  const ref1 = parseIssueReference("https://github.com/vuejs/core/issues/5678");
  assert.deepEqual(ref1, {
    owner: "vuejs",
    repo: "core",
    issueNumber: 5678,
  });

  const ref2 = parseIssueReference("[Issue] vuejs/core#5678");
  assert.deepEqual(ref2, {
    owner: "vuejs",
    repo: "core",
    issueNumber: 5678,
  });
});

test("parseRepoReference correctly identifies repo links and tags", () => {
  const ref1 = parseRepoReference("https://github.com/vuejs/core");
  assert.deepEqual(ref1, {
    owner: "vuejs",
    repo: "core",
  });

  const ref2 = parseRepoReference("[Repo] vuejs/core");
  assert.deepEqual(ref2, {
    owner: "vuejs",
    repo: "core",
  });
});

test("parsePullRequestReference correctly identifies PR links and tags", () => {
  const ref1 = parsePullRequestReference("https://github.com/vuejs/core/pull/1234");
  assert.deepEqual(ref1, {
    owner: "vuejs",
    repo: "core",
    prNumber: 1234,
  });

  const ref2 = parsePullRequestReference("[PR] vuejs/core#1234");
  assert.deepEqual(ref2, {
    owner: "vuejs",
    repo: "core",
    prNumber: 1234,
  });
});


