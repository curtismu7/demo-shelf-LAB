#!/usr/bin/env node
// End-to-end check of the shelf in a real browser. Run by hand (npm run e2e), not by CI.
//   npm run e2e                          7 fake demos (ready, needs-setup, broken, unknown schema, hung, no contract,
//                                        one that goes down mid-run); asserts the visible state; screenshots in .data/e2e-screenshots (git-ignored)
//   npm run e2e:refresh-docs             same, but rewrites the committed docs/screenshots
//   npm run e2e -- --real [url]          read-only look at a demo that is already running (default http://localhost:18080)
//   npm run e2e -- --kit <dir>           spawn a demo-health/1 kit from <dir> in mock mode on a free port and expect "Ready"
// Needs `npm run build` first and a Chromium for Playwright (`npx playwright install chromium`).
// Ports: shelf 4490, fakes 4520-4526, kit 4531. It stops everything it started and touches nothing else.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { KIND_NAMES, startFake } from './e2e/fake-demos.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Screenshots go to a git-ignored directory so running e2e never dirties a clean clone.
// `npm run e2e:refresh-docs` writes the committed docs/screenshots instead.
const refreshDocs = process.argv.includes('--refresh-docs');
const shots = refreshDocs ? path.join(root, 'docs', 'screenshots') : path.join(root, '.data', 'e2e-screenshots');
const SHELF_PORT = 4490;
const BASE = `http://127.0.0.1:${SHELF_PORT}`;
const args = process.argv.slice(2);
const flag = (n) => args.indexOf(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function startShelf(demos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-e2e-'));
  const seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ demos }));
  const child = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    env: { PATH: process.env.PATH, SHELF_PORT: String(SHELF_PORT), SHELF_SEED_FILE: seed, SHELF_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('exit', (c) => reject(new Error(`shelf exited early (${c}); is port ${SHELF_PORT} free?`)));
    child.stdout.on('data', (d) => { if (String(d).includes('demo-shelf on')) resolve({ child, dir }); });
  });
}
const stopShelf = ({ child, dir }) => { child.removeAllListeners('exit'); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); };

const cardOf = (page, name) => page.locator('article.box[data-state]', { has: page.getByRole('heading', { name, exact: true }) });

async function open(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(BASE);
  await page.locator('article.box[data-state]').first().waitFor({ timeout: 15000 }).catch(async (e) => { console.error((await page.locator('body').innerText()).slice(0, 400)); throw e; });
  return page;
}

async function fakesRun(browser) {
  const ports = Object.fromEntries(KIND_NAMES.map((k, i) => [k, 4520 + i]));
  const fakes = {};
  for (const k of KIND_NAMES) fakes[k] = await startFake(k, ports[k]);
  const label = { ready: 'Ready', 'needs-setup': 'Needs setup', broken: 'Broken', unknown: 'Unknown', hung: 'Down', 'no-contract': 'Up (no health contract)', 'goes-down': 'Ready' };
  const demos = KIND_NAMES.map((k, i) => ({
    id: `fake-${k}`, name: `Fake ${k}`, catalogId: `A${i + 1}`, kind: 'Demo', description: `Fake demo that answers as "${k}".`, url: `http://localhost:${ports[k]}`,
  }));
  const shelf = await startShelf(demos);
  try {
    const page = await open(browser);
    fs.mkdirSync(shots, { recursive: true });
    for (const k of KIND_NAMES) {
      const c = cardOf(page, `Fake ${k}`);
      check(`${k}: shows "${label[k]}"`, (await c.locator('.light').innerText()).trim() === label[k]);
    }
    check('hung demo is Down within the poll timeout', (await cardOf(page, 'Fake hung').getAttribute('data-state')) === 'down');
    check('Open link only on demos that are up', (await cardOf(page, 'Fake hung').getByRole('link', { name: /Open/ }).count()) === 0 && (await cardOf(page, 'Fake ready').getByRole('link', { name: /Open/ }).count()) === 1);
    await page.screenshot({ path: path.join(shots, 'shelf-all-states.png') });

    // Details drawer explains the unknown-schema case.
    await cardOf(page, 'Fake unknown').getByRole('button', { name: /Details/ }).click();
    const drawer = page.getByRole('dialog');
    check('details drawer names the reason for an off-contract reply', (await drawer.innerText()).includes('unknown-schema'));
    await page.screenshot({ path: path.join(shots, 'shelf-details.png') });
    await page.keyboard.press('Escape');

    // The demo that goes down mid-run: stop it, wait past the refresh floor, press Refresh.
    await fakes['goes-down'].stop();
    await sleep(2300);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.locator('article.box[data-state="down"]', { has: page.getByRole('heading', { name: 'Fake goes-down' }) }).waitFor({ timeout: 8000 });
    check('goes-down: Ready -> Down after Refresh', true);
    // Since 40343d6 (owner, 2026-11-05) the summary is four buckets; Offline = installed but not answering (broken, hung, goes-down).
    check('summary counts follow (3 Offline: broken + hung + goes-down)', (await page.locator('.lights .chip[data-state="offline"] b').innerText()).trim() === '3');
    check('screen-reader announcement names the change', (await page.locator('[role=status].sr').innerText()).includes('Fake goes-down is now Down'));

    // Filter and present mode. The status chips are a summary now (40343d6), so filter with the search box.
    await page.getByRole('searchbox', { name: 'Search' }).fill('Fake needs-setup');
    await page.waitForFunction(() => document.querySelectorAll('article.box[data-state]').length === 1, null, { timeout: 5000 }).catch(() => {});
    check('search filters the page to one card', (await page.locator('article.box[data-state]').count()) === 1 && (await cardOf(page, 'Fake needs-setup').count()) === 1);
    await page.getByRole('searchbox', { name: 'Search' }).fill('');
    await page.getByRole('button', { name: 'Present' }).click();
    check('Present mode switches on', (await page.locator('html[data-present="1"]').count()) === 1);
    await page.screenshot({ path: path.join(shots, 'shelf-present.png') });
    await page.getByRole('button', { name: 'Present' }).click();
    await page.screenshot({ path: path.join(shots, 'shelf-after-down.png') });
    // The shelf's JSON carries only the known status fields for each demo.
    const api = await (await page.request.get(`${BASE}/api/shelf`)).json();
    const allowed = new Set(['state', 'reason', 'runtime', 'reportedAt', 'demo', 'lastChecked', 'latencyMs']);
    check('API status objects carry only known fields', api.demos.every((d) => Object.keys(d.status).every((k) => allowed.has(k))));
  } finally {
    stopShelf(shelf);
    await Promise.all(Object.values(fakes).map((f) => f.stop().catch(() => {})));
  }
}

async function oneDemo(browser, demo, shotName, expectLabel) {
  const shelf = await startShelf([demo]);
  try {
    const page = await open(browser);
    const got = (await cardOf(page, demo.name).locator('.light').innerText()).trim();
    console.log(`OBSERVED  ${demo.name} at ${demo.url}: shelf shows "${got}"`);
    if (expectLabel) check(`${demo.name} shows "${expectLabel}"`, got === expectLabel);
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, shotName) });
  } finally { stopShelf(shelf); }
}

async function realRun(browser, url) {
  await oneDemo(browser, { id: 'real-demo', name: 'Real demo', catalogId: 'C1', kind: 'Demo', description: 'A demo that is already running (read-only look).', url }, 'shelf-real.png');
}

async function kitRun(browser, dir) {
  const port = 4531;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-e2e-'));
  const kit = spawn(process.execPath, ['server/src/index.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), HEALTH_MODE: 'mock', DATA_DIR: data, APP_ORIGIN: `http://localhost:${port}` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    let h;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); if (h.state !== 'unknown') break; } catch { /* not up yet */ }
    }
    console.log(`kit /api/health: ${JSON.stringify(h)}`);
    await oneDemo(browser, { id: 'id-jag-kit', name: 'ID-JAG kit (health branch)', catalogId: 'C1', kind: 'Demo', description: 'Kit with GET /api/health, mock mode.', url: `http://localhost:${port}` }, 'shelf-kit-health.png', 'Ready');
  } finally { kit.kill(); fs.rmSync(data, { recursive: true, force: true }); }
}

if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
try {
  if (flag('--real') >= 0) await realRun(browser, args[flag('--real') + 1]?.startsWith('http') ? args[flag('--real') + 1] : 'http://localhost:18080');
  else if (flag('--kit') >= 0) await kitRun(browser, path.resolve(args[flag('--kit') + 1]));
  else await fakesRun(browser);
} finally { await browser.close(); }
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
