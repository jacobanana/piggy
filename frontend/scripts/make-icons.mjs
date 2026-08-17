#!/usr/bin/env node
/**
 * Render public/icon.svg into the PNGs the platforms actually ask for.
 *
 *   node frontend/scripts/make-icons.mjs
 *
 * Run this only when the mark changes; the PNGs are committed, so neither the
 * build nor CI needs a browser. Playwright is borrowed from the app-screenshots
 * skill, which is where this repo keeps a browser — the app's own dependency
 * tree stays free of one (see .claude/skills/app-screenshots/scripts/package.json).
 *
 * Three renderings, because the platforms disagree about who owns the corners:
 *
 *   any        rounded tile, transparent outside it. Android draws it as given
 *              and the browser tab shows it at 16px.
 *   maskable   full-bleed square, mark shrunk into the safe circle. Android
 *              crops this to whatever shape the launcher uses, and anything
 *              outside the middle 80% is the part it is allowed to cut off —
 *              an ear, in our case.
 *   apple      full-bleed square, opaque, corners left square. iOS applies its
 *              own squircle; hand it a rounded icon and it rounds the rounding,
 *              leaving four dark notches. Alpha is composited onto black for
 *              the same reason, so the background is painted, never implied.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');
const skillDir = resolve(here, '../../.claude/skills/app-screenshots/scripts');

function loadPlaywright() {
  const req = createRequire(resolve(skillDir, 'noop.js'));
  try {
    return req('playwright');
  } catch {
    console.error('installing playwright beside the app-screenshots skill (first run)...');
    execSync('npm install --no-audit --no-fund', {
      cwd: skillDir,
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? '1' },
    });
    return req('playwright');
  }
}

/**
 * @typedef {object} Rendering
 * @property {string} file      output name, under public/
 * @property {number} size      square edge in CSS pixels
 * @property {boolean} rounded  keep the tile's rounded corners?
 * @property {number} scale     how much of the square the mark fills
 * @property {boolean} opaque   composite onto the tile rather than transparency
 */

/** @type {Rendering[]} */
const RENDERINGS = [
  { file: 'pwa-192.png', size: 192, rounded: true, scale: 1, opaque: false },
  { file: 'pwa-512.png', size: 512, rounded: true, scale: 1, opaque: false },
  // 0.82 keeps the ear tips — the mark's furthest point from centre — inside
  // the middle 80% circle a maskable icon promises not to lose.
  { file: 'pwa-maskable-512.png', size: 512, rounded: false, scale: 0.82, opaque: true },
  // Bigger, because iOS only shaves the corners rather than cropping to a
  // circle, and a timid icon reads as a small icon on the home screen.
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false, scale: 0.88, opaque: true },
];

const svg = readFileSync(resolve(publicDir, 'icon.svg'), 'utf8');

/**
 * The same fallback chain the screenshot script walks, and for the same reason:
 * the browser here is whatever the container already has, which is rarely the
 * exact build the freshly-installed Playwright would like to download.
 */
async function launch(chromium) {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  try { return await chromium.launch(); } catch { /* try explicit paths */ }
  for (const executablePath of candidates) {
    try { return await chromium.launch({ executablePath }); } catch { /* next */ }
  }
  throw new Error('no launchable chromium found');
}

const browser = await launch(loadPlaywright().chromium);

mkdirSync(publicDir, { recursive: true });

for (const r of RENDERINGS) {
  const page = await browser.newPage({
    viewport: { width: r.size, height: r.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${r.size}px;height:${r.size}px}</style>${svg}`,
  );
  await page.evaluate(({ rounded, scale }) => {
    if (!rounded) document.getElementById('tile').setAttribute('rx', '0');
    if (scale !== 1) {
      // Scale about the artboard's centre, so the mark stays where it was.
      document.getElementById('mark').setAttribute(
        'transform',
        `translate(256,256) scale(${scale}) translate(-256,-256)`,
      );
    }
  }, r);

  const png = await page.screenshot({ omitBackground: !r.opaque });
  writeFileSync(resolve(publicDir, r.file), png);
  console.log(`wrote public/${r.file} (${r.size}x${r.size})`);
  await page.close();
}

await browser.close();
