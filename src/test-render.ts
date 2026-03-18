import { renderTemplate } from "./renderer";
import * as fs from "fs";

async function testRender() {
  const issueHtml = await renderTemplate("issue", {
    badgeClass: "badge-issue-open",
    eventIcon: "🟢",
    eventLabel: "Issue Opened",
    repoFullName: "owner/repo",
    title: "This is a test issue",
    number: "123",
    avatarUrl: "https://github.com/ghost.png?size=80",
    authorName: "ghost",
    actionText: "创建了 Issue",
    timestamp: new Date().toLocaleString("zh-CN"),
    labelsHtml: `<div class="labels"><span class="label" style="background: #e3b34133; color: #e3b341; border-color: #e3b34155;">bug</span></div>`,
    bodyHtml: "<p>This is a mock body for the issue.<br/>It supports <strong>markdown</strong></p><pre><code>console.log('hello world');</code></pre>",
    comments: 0,
    reactions: 0,
  });

  const pushHtml = await renderTemplate("push", {
    repoFullName: "owner/repo",
    avatarUrl: "https://github.com/ghost.png?size=80",
    pusherName: "ghost",
    commitCount: 2,
    branch: "main",
    commitsHtml: `
      <div class="commit-item">
        <span class="commit-sha">a1b2c3d</span>
        <span class="commit-message">Add new feature</span>
        <span class="commit-author">ghost</span>
      </div>
      <div class="commit-item">
        <span class="commit-sha">e4f5g6h</span>
        <span class="commit-message">Fix bug</span>
        <span class="commit-author">ghost</span>
      </div>
    `,
    statsHtml: `
      <div class="stats">
        <span class="stat"><span class="stat-icon stat-add">+</span> 10 新增</span>
        <span class="stat"><span class="stat-icon stat-del">−</span> 5 删除</span>
        <span class="stat"><span class="stat-icon stat-files">⚡</span> 2 修改</span>
      </div>
    `,
    compareText: "查看完整对比 →",
  });

  fs.writeFileSync("test-issue.png", Buffer.from(issueHtml, "base64"));
  fs.writeFileSync("test-push.png", Buffer.from(pushHtml, "base64"));
  console.log("Rendered test images to test-issue.png and test-push.png");
  
  // Close the renderer gracefully
  const { closeRenderer } = require("./renderer");
  await closeRenderer();
}

testRender().catch(console.error);
