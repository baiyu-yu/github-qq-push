const { test } = require("node:test");
const assert = require("node:assert");
const { escapeHtml, sanitizeTextForCq } = require("../dist/utils");

test("escapeHtml escapes HTML special characters", () => {
  assert.equal(
    escapeHtml(`<script>alert("x'&")</script>`),
    `&lt;script&gt;alert(&quot;x&#039;&amp;&quot;)&lt;/script&gt;`
  );
  assert.equal(escapeHtml(null), "");
});

test("sanitizeTextForCq neutralizes CQ codes", () => {
  assert.equal(
    sanitizeTextForCq("hello [CQ:image,file=x] world"),
    "hello ［CQ:image,file=x] world"
  );
  assert.equal(
    sanitizeTextForCq("[cq:at,qq=1]"),
    "［CQ:at,qq=1]"
  );
  assert.equal(sanitizeTextForCq("plain text"), "plain text");
});
