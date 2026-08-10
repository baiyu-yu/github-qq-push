import puppeteer, { Browser } from "puppeteer";
import * as path from "path";
import * as fs from "fs";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { getConfig } from "../config";

let browser: Browser | null = null;
let activeRenders = 0;
const renderQueue: (() => void)[] = [];

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_SIZE = 50;
const DEFAULT_SCREENSHOT_CAP = 30000;
// Even when the user raises max_screenshot_height, never render a single
// screenshot above this hard ceiling (huge pages would otherwise OOM).
const HARD_SCREENSHOT_CAP = 100000;

/**
 * Simple semaphore: cap concurrent Puppeteer page renders so a burst of
 * events cannot spawn unbounded Chromium pages and exhaust memory.
 * If the backlog exceeds the queue cap, fail fast so callers fall back to
 * plain text instead of piling up unbounded memory pressure.
 */
async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  const renderCfg = getConfig().render;
  const concurrency = Math.max(1, renderCfg?.concurrency ?? DEFAULT_CONCURRENCY);
  const maxQueue = Math.max(0, renderCfg?.max_queue_size ?? DEFAULT_QUEUE_SIZE);
  if (activeRenders >= concurrency) {
    if (renderQueue.length >= maxQueue) {
      throw new Error("Render queue is full, falling back to text");
    }
    await new Promise<void>((resolve) => renderQueue.push(resolve));
  }
  activeRenders++;
  try {
    return await fn();
  } finally {
    activeRenders--;
    const next = renderQueue.shift();
    if (next) next();
  }
}

/**
 * Initialize the Puppeteer browser singleton.
 */
export async function initRenderer(): Promise<void> {
  if (browser) return;
  
  const launchOptions: any = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  };
  
  // Use custom Chrome path if specified in environment
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  
  browser = await puppeteer.launch(launchOptions);
  console.log("[Renderer] Puppeteer browser launched");
}

/**
 * Close the Puppeteer browser.
 */
export async function closeRenderer(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Load a template, inject data, render to PNG, return as base64 string.
 */
export async function renderTemplate(
  templateName: string,
  data: Record<string, any>,
  options: { fullPage?: boolean; width?: number } = {}
): Promise<string> {
  if (!browser) {
    await initRenderer();
  }

  // Resolve templates folder from project root
  const templateDir = path.resolve(process.cwd(), "src", "renderer", "templates");
  const templatePath = path.join(templateDir, `${templateName}.html`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  let html = fs.readFileSync(templatePath, "utf-8");

  // Load shared CSS
  const cssPath = path.join(templateDir, "common.css");
  let css = "";
  if (fs.existsSync(cssPath)) {
    css = fs.readFileSync(cssPath, "utf-8");
  }
  html = html.replace("/* %%COMMON_CSS%% */", css);

  // Replace template placeholders: {{key}}
  // Use a function replacement so `$&`, `$'`, `$$` in user content
  // are not interpreted as replacement patterns.
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    html = html.replace(placeholder, () => String(value ?? ""));
  }

    const config = getConfig();
    const renderCfg = config.render || { image_quality: 90, max_height: 8000, theme: "dark" };
    const theme = renderCfg.theme || "dark";
    html = html.replace("<body>", `<body class="${theme}-theme">`);

    return await withRenderSlot(async () => {
      const page = await browser!.newPage();
      try {
        const viewportWidth = options.width || 800;
        await page.setViewport({ width: viewportWidth, height: 100, deviceScaleFactor: 2 });
        // Parse the DOM first, then wait a bounded amount of time for remote
        // resources (avatars). Waiting for a full network idle can hang for
        // 15s when a CDN is slow/unreachable (e.g. no Google Fonts access),
        // which is unacceptable for every single card render.
        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              if (document.readyState === "complete") {
                resolve();
                return;
              }
              const timer = setTimeout(resolve, 2000);
              window.addEventListener(
                "load",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true }
              );
            })
        );

        // Auto-calculate content height and enforce max height limits
        const bodyHeight = await page.evaluate(() => {
          return document.body.scrollHeight;
        });

        let finalHeight = bodyHeight + 20;
        let fullPage = renderCfg.max_height === 0 || !!options.fullPage;

        // Safety cap: never render a single screenshot taller than the
        // configured max_screenshot_height (default 30000px), even in fullPage
        // mode (huge READMEs/PRs could otherwise OOM). A hard ceiling always
        // applies regardless of the configured value.
        const configuredCap = renderCfg.max_screenshot_height ?? DEFAULT_SCREENSHOT_CAP;
        const maxScreenshotHeight =
          configuredCap <= 0
            ? HARD_SCREENSHOT_CAP
            : Math.min(configuredCap, HARD_SCREENSHOT_CAP);
        if (fullPage && bodyHeight > maxScreenshotHeight) {
          fullPage = false;
          finalHeight = maxScreenshotHeight;
        }

        if (!fullPage && finalHeight > renderCfg.max_height) {
          finalHeight = renderCfg.max_height;
        }

        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: renderCfg.image_quality,
          fullPage: fullPage,
          clip: fullPage ? undefined : { x: 0, y: 0, width: viewportWidth, height: finalHeight },
        });

        return Buffer.from(screenshot).toString("base64");
      } finally {
        await page.close();
      }
    });
}

/**
 * Convert markdown text to safe HTML for use inside templates.
 */
export function markdownToHtml(md: string, maxLength: number = 50000): string {
  if (!md) return "";
  // Truncate very long markdown to avoid crashing the parser, but allow large limits
  const truncated = md.length > maxLength ? md.slice(0, maxLength) + "\n\n..." : md;
  const raw = marked.parse(truncated, { async: false }) as string;
  // Sanitize the rendered HTML: allow GitHub-flavored markdown markup but
  // strip scripts, event handlers, iframes, javascript: URLs, etc.
  return sanitizeHtml(raw, {
    allowedTags: [
      "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "del", "ins",
      "code", "pre", "blockquote", "a", "ul", "ol", "li", "h1", "h2", "h3",
      "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td",
      "span", "div", "img", "input", "sup", "sub", "details", "summary", "kbd",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title"],
      input: ["type", "checked", "disabled"],
      code: ["class"],
      th: ["align"],
      td: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
  });
}
