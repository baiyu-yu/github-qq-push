const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

/**
 * Generates the official minimalist adapter icon (方案 C: 平铺极简转接头) for GitHub QQ Push
 * Output: public/icon.png (512x512 with irregular transparent alpha background)
 */
async function generateIcon() {
  const width = 512;
  const height = 512;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
      <defs>
        <!-- Dark Obsidian Body Gradient -->
        <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1f242c" />
          <stop offset="100%" stop-color="#0d1117" />
        </linearGradient>

        <!-- Drop Shadow for Irregular Adapter Silhouette -->
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#000000" flood-opacity="0.7" />
          <feDropShadow dx="0" dy="0" stdDeviation="12" flood-color="#58a6ff" flood-opacity="0.35" />
        </filter>

        <!-- High-Precision Neon Glow for Data Bridge Core -->
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#58a6ff" flood-opacity="0.9" />
        </filter>
      </defs>

      <g filter="url(#shadow)">
        <!-- Top Male Plug Connector (USB-C Profile) -->
        <path d="
          M 204, 52
          L 308, 52
          C 328, 52 340, 66 340, 86
          L 340, 138
          L 172, 138
          L 172, 86
          C 172, 66 184, 52 204, 52
          Z
        " fill="#21262d" stroke="#58a6ff" stroke-width="3.5" />

        <!-- Plug Contact Core -->
        <rect x="206" y="80" width="100" height="28" rx="14" fill="#0d1117" stroke="#388bfd" stroke-width="2" />
        <rect x="232" y="91" width="48" height="6" rx="3" fill="#58a6ff" filter="url(#glow)" />

        <!-- Adapter Collar Band -->
        <rect x="188" y="134" width="136" height="20" rx="6" fill="#30363d" />

        <!-- Adapter Main Monolithic Body -->
        <rect x="120" y="150" width="272" height="268" rx="48" fill="url(#bodyGrad)" stroke="#388bfd" stroke-width="3.5" />

        <!-- Clean Recessed Bottom Socket -->
        <path d="
          M 188, 388
          L 324, 388
          C 334, 388 340, 394 338, 404
          L 334, 418
          L 178, 418
          L 174, 404
          C 172, 394 178, 388 188, 388
          Z
        " fill="#05080c" stroke="#30363d" stroke-width="2" />
        
        <rect x="204" y="394" width="104" height="14" rx="7" fill="#0d1117" stroke="#58a6ff" stroke-width="1.5" />
      </g>

      <!-- Center Iconic Symbol: Clean Two-Way Adapter Bridge (Git -> QQ Push) -->
      <g transform="translate(256, 276)">
        <!-- Top Entry Node -->
        <circle cx="0" cy="-56" r="10" fill="#f0f6fc" />
        <line x1="0" y1="-46" x2="0" y2="-18" stroke="#f0f6fc" stroke-width="6" stroke-linecap="round" />

        <!-- Clean Angled Split (Push Router) -->
        <path d="
          M 0, -18
          L 0, 4
          C 0, 22 46, 22 46, 42
          L 46, 54
        " fill="none" stroke="#58a6ff" stroke-width="6" stroke-linecap="round" filter="url(#glow)" />

        <path d="
          M 0, 4
          C 0, 22 -46, 22 -46, 42
          L -46, 54
        " fill="none" stroke="#39d353" stroke-width="6" stroke-linecap="round" />

        <!-- Converter Core Bridge -->
        <rect x="-24" y="-10" width="48" height="24" rx="8" fill="#0d1117" stroke="#58a6ff" stroke-width="2.5" filter="url(#glow)" />
        <circle cx="0" cy="2" r="4" fill="#ffffff" />

        <!-- Output Nodes -->
        <circle cx="-46" cy="54" r="9" fill="#39d353" />
        <circle cx="46" cy="54" r="9" filter="url(#glow)" fill="#58a6ff" />
      </g>

      <!-- Subtle Precision Status Dot -->
      <circle cx="360" cy="186" r="6" fill="#39d353" />
    </svg>
  `.trim();

  const tempHtmlPath = path.join(__dirname, '../temp_icon_render.html');
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; }
          body {
            background: transparent;
            width: ${width}px;
            height: ${height}px;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
          }
        </style>
      </head>
      <body>
        ${svg}
      </body>
    </html>
  `;

  fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto('file://' + tempHtmlPath, { waitUntil: 'networkidle0' });

    const outputPath = path.join(__dirname, '../public/icon.png');
    await page.screenshot({
      path: outputPath,
      omitBackground: true,
      type: 'png'
    });

    console.log(`[Icon] Successfully generated official icon: ${outputPath}`);
  } finally {
    await browser.close();
    if (fs.existsSync(tempHtmlPath)) {
      fs.unlinkSync(tempHtmlPath);
    }
  }
}

generateIcon().catch(console.error);
