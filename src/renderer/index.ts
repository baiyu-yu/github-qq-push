import puppeteer, { Browser } from "puppeteer";
import * as path from "path";
import * as fs from "fs";
import { marked } from "marked";
import { getConfig } from "../config";

let browser: Browser | null = null;

/**
 * Initialize the Puppeteer browser singleton.
 */
export async function initRenderer(): Promise<void> {
  if (browser) return;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
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
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    html = html.replace(placeholder, String(value ?? ""));
  }

    const config = getConfig();
    const renderCfg = config.render || { image_quality: 90, max_height: 8000, theme: "dark" };
    const theme = renderCfg.theme || "dark";
    html = html.replace("<body>", `<body class="${theme}-theme">`);

    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: options.width || 800, height: 100, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

    // Auto-calculate content height and enforce max height limits
    const bodyHeight = await page.evaluate(() => {
      return document.body.scrollHeight;
    });
    
    let finalHeight = bodyHeight + 20;
    let fullPage = renderCfg.max_height === 0 || !!options.fullPage;

    if (!fullPage && finalHeight > renderCfg.max_height) {
      finalHeight = renderCfg.max_height;
    }

    const screenshot = await page.screenshot({
      type: "jpeg",
      quality: renderCfg.image_quality,
      fullPage: fullPage, // If max_height is 0, fullPage is true
      clip: fullPage ? undefined : { x: 0, y: 0, width: 800, height: finalHeight },
    });

    return Buffer.from(screenshot).toString("base64");
  } finally {
    await page.close();
  }
}

/**
 * Convert markdown text to safe HTML for use inside templates.
 */
export function markdownToHtml(md: string, maxLength: number = 50000): string {
  if (!md) return "";
  // Truncate very long markdown to avoid crashing the parser, but allow large limits
  const truncated = md.length > maxLength ? md.slice(0, maxLength) + "\n\n..." : md;
  return marked.parse(truncated, { async: false }) as string;
}
