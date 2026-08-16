#!/usr/bin/env node
// Photograph Piggy. See SKILL.md for the option table.
//
// Seeds the book by writing the localStorage key the app reads
// (piggy.ledger.v1) before first paint, so shots are deterministic.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = dirname(fileURLToPath(import.meta.url));

// Playwright is installed beside the skill (see package.json here), never in
// the app's own dependency tree. Self-heal on first run.
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch {
    console.error('installing playwright beside the skill (first run)...');
    execSync('npm install --no-audit --no-fund', { cwd: skillDir, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? '1' } });
    return req('playwright');
  }
}

const WIDTHS = { phone: 390, tablet: 768, desktop: 1440 };
const HEIGHTS = { 390: 844, 768: 1024 };
const DEFAULT_HEIGHT = 900;

const args = process.argv.slice(2);
const opt = { widths: [], clicks: [], seed: false, empty: false, fullPage: false, name: 'shot', base: null };
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--seed': opt.seed = true; break;
    case '--empty': opt.empty = true; break;
    case '--full-page': opt.fullPage = true; break;
    case '--width': opt.widths.push(args[++i]); break;
    case '--click': opt.clicks.push(args[++i]); break;
    case '--act': opt.clicks.push(`[data-act="${args[++i]}"]`); break;
    case '--name': opt.name = args[++i]; break;
    case '--base': opt.base = args[++i]; break;
    default: console.error(`unknown option: ${args[i]}`); process.exit(2);
  }
}
if (!opt.widths.length) opt.widths = ['phone'];
if (!opt.seed && !opt.empty) {
  console.error('Pick --seed (realistic book) or --empty (onboarding). --seed is almost always right.');
  process.exit(2);
}

function baseUrl() {
  if (opt.base) return opt.base;
  const f = resolve('.dev/base_url');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return 'http://127.0.0.1:5173';
}

async function launch() {
  const { chromium } = loadPlaywright();
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  try { return await chromium.launch(); } catch { /* try explicit paths */ }
  for (const executablePath of candidates) {
    try { return await chromium.launch({ executablePath }); } catch { /* next */ }
  }
  throw new Error('no launchable chromium found');
}

// A believable two-person book: bills, extras, a planned booking, a trip, a repayment.
function seedBook() {
  const month = new Date().toISOString().slice(0, 7);
  const day = (d) => `${month}-${String(d).padStart(2, '0')}`;
  const split = { mode: 'equal', participants: ['per_lea', 'per_marc'], values: {} };
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    meta: { appName: 'Piggy', createdAt: now, updatedAt: now },
    settings: { theme: 'blueberry', baseCurrency: 'CHF', currencies: ['CHF', 'EUR'], rates: { CHF: 1, EUR: 0.94, USD: 0.81 }, ratesUpdatedAt: null },
    people: [
      { id: 'per_lea', name: 'Léa', emoji: '🐰', color: '#5A67E8' },
      { id: 'per_marc', name: 'Marc', emoji: '🦊', color: '#3EA7E8' },
    ],
    accounts: [
      { id: 'acc_lea', name: "Léa's money", kind: 'personal', ownership: { per_lea: 1 } },
      { id: 'acc_marc', name: "Marc's money", kind: 'personal', ownership: { per_marc: 1 } },
      { id: 'acc_joint', name: 'Joint account', kind: 'joint', ownership: { per_lea: 0.5, per_marc: 0.5 } },
    ],
    ledgers: [
      { id: 'led_home', name: 'Home', emoji: '🏠', kind: 'household', currency: 'CHF', archived: false, createdAt: now },
      { id: 'led_trip', name: 'Lisbon', emoji: '✈️', kind: 'trip', currency: 'EUR', startDate: day(2), endDate: day(9), archived: false, createdAt: now },
    ],
    rules: [
      { id: 'rule_rent', ledgerId: 'led_home', name: 'Rent', emoji: '🏠', amount: 1850, currency: 'CHF', frequency: 'monthly', dueDay: 1, startMonth: '2025-01', endMonth: null, accountId: 'acc_joint', method: 'direct-debit', split, active: true, notes: '', createdAt: now },
      { id: 'rule_net', ledgerId: 'led_home', name: 'Internet', emoji: '🌐', amount: 59.9, currency: 'CHF', frequency: 'monthly', dueDay: 5, startMonth: '2025-01', endMonth: null, accountId: 'acc_lea', method: 'direct-debit', split, active: true, notes: '', createdAt: now },
      { id: 'rule_ins', ledgerId: 'led_home', name: 'Home insurance', emoji: '🛡️', amount: 210, currency: 'CHF', frequency: 'quarterly', dueDay: 15, startMonth: '2025-02', endMonth: null, accountId: 'acc_marc', method: 'transfer', split, active: true, notes: '', createdAt: now },
    ],
    overrides: [],
    expenses: [
      { id: 'exp_1', ledgerId: 'led_home', name: 'Groceries at Coop', emoji: '🛒', amount: 84.35, currency: 'CHF', fxRate: 1, date: day(6), accountId: 'acc_lea', method: 'card', planned: false, split, notes: '', createdAt: now },
      { id: 'exp_2', ledgerId: 'led_home', name: 'Cleaning lady', emoji: '🧹', amount: 120, currency: 'CHF', fxRate: 1, date: day(10), accountId: 'acc_marc', method: 'cash', planned: false, split, notes: '', createdAt: now },
      { id: 'exp_3', ledgerId: 'led_home', name: 'New lamp', emoji: '🛋️', amount: 249, currency: 'CHF', fxRate: 1, date: day(20), accountId: 'acc_lea', method: 'card', planned: true, split, notes: 'to pick up', createdAt: now },
      { id: 'exp_4', ledgerId: 'led_trip', name: 'Hotel', emoji: '🏨', amount: 420, currency: 'EUR', fxRate: 0.95, date: day(3), accountId: 'acc_marc', method: 'card', planned: false, split, notes: '', createdAt: now },
      { id: 'exp_5', ledgerId: 'led_trip', name: 'Dinner in Alfama', emoji: '🍜', amount: 62.5, currency: 'EUR', fxRate: 0.95, date: day(4), accountId: 'acc_lea', method: 'card', planned: false, split, notes: '', createdAt: now },
    ],
    settlements: [
      { id: 'set_1', ledgerId: 'led_home', date: day(12), fromPersonId: 'per_marc', toPersonId: 'per_lea', amount: 45, currency: 'CHF', fxRate: 1, method: 'twint', note: '', createdAt: now },
    ],
  };
}

const outDir = resolve('.dev/screenshots');
mkdirSync(outDir, { recursive: true });

const browser = await launch();
const errors = [];
const written = [];

for (const w of opt.widths) {
  const width = WIDTHS[w] ?? Number(w);
  if (!width) { console.error(`bad width: ${w}`); continue; }
  const height = HEIGHTS[width] ?? DEFAULT_HEIGHT;
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Resource loads (fonts, CDNs) fail in sandboxes without being app bugs.
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });

  if (opt.seed) {
    const book = JSON.stringify(seedBook());
    await page.addInitScript(`localStorage.setItem('piggy.ledger.v1', ${JSON.stringify(book)});`);
  }
  await page.goto(baseUrl(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  for (const sel of opt.clicks) {
    await page.click(sel, { timeout: 5000 });
    await page.waitForTimeout(350);
  }

  const file = resolve(outDir, `${opt.name}-${w}.png`);
  await page.screenshot({ path: file, fullPage: opt.fullPage });
  written.push(file);
  await page.close();
}

await browser.close();
for (const f of written) console.log(f);
if (errors.length) {
  console.error('JS errors during capture:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
