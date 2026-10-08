// PhysArena UI regression gate (headless, runs in CI before deploy).
//
// Why this exists: every "some panel does not show" bug so far was invisible to
// `vite build` and to the naming gate, because it only appears once the real
// app runs in a browser:
//
//   1. the compare table froze on its first frame (refreshComparePanel looked
//      in the wrong parent), so it shipped looking "not working";
//   2. the memory / contact-pair columns silently showed "—" for engines that
//      do report them;
//   3. below ~1200px the header controls were squeezed until their labels
//      wrapped one glyph per line and scrolled out of view.
//
// A build that compiles is not a build that renders. This gate boots the real
// dist in a headless browser and asserts those invariants, so a regression
// fails CI instead of shipping. It reuses the repo convention of driving the
// system browser (channel msedge locally, chrome on CI runners) - no browser
// download.
//
// Usage: node scripts/ui-gate.mjs            (expects dist/ to be built)
//   UI_GATE_CHANNEL=chrome node scripts/ui-gate.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.UI_GATE_PORT || 4180);
const BASE = `http://127.0.0.1:${PORT}/physarena/`;
const CHANNEL = process.env.UI_GATE_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome');
const HEADFUL = process.env.UI_GATE_HEADFUL === '1';

// Compare-table column order is defined in comparePanel(); keep in sync.
const COL = { engine: 0, p50: 1, steps: 5, contacts: 7, memory: 8 };
const WIDTHS = [1440, 1280, 1152, 1024];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Boots `vite preview` (serves dist/) and resolves once it answers. */
async function startServer() {
  // Spawn vite's JS entry with the current node rather than the .bin shim:
  // on Windows a bare `.cmd` spawn fails with EINVAL, and this stays
  // cross-platform without a shell.
  const proc = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return proc;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  proc.kill();
  throw new Error('vite preview did not come up');
}

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  const errs = [];
  Object.defineProperty(page, '__errs', { value: errs });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  return page;
}

async function waitFor(page, fn, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await page.evaluate(fn)) return true; } catch { /* retry */ }
    await sleep(700);
  }
  return false;
}

const compareTable = () => {
  const rows = [...document.querySelectorAll('.pa-slot-compare tbody tr')];
  return rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
};

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: CHANNEL,
    headless: !HEADFUL,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    // ---- 1. boot + compare table is live and populated -------------------
    const page = await newPage(browser);
    await page.goto(`${BASE}?mode=compare`, { waitUntil: 'load' });
    const booted = await waitFor(page, () => document.querySelectorAll('.pa-slot-compare tbody tr').length >= 2);
    check('app boots and compare table renders', booted);

    if (booted) {
      let table = await page.evaluate(compareTable);
      check('compare table has full column set', table[0]?.length >= 10, `cols=${table[0]?.length}`);

      // Frozen-table guard: step count must advance between two samples.
      const stepsOf = (t) => parseInt(t[0]?.[COL.steps] ?? '0', 10) || 0;
      const s1 = stepsOf(await page.evaluate(compareTable));
      await sleep(4000);
      const s2 = stepsOf(await page.evaluate(compareTable));
      check('compare table is live (step count advances)', s2 > s1, `steps ${s1} -> ${s2}`);

      // Metrics presence: at least one engine reports memory, one reports contacts.
      table = await page.evaluate(compareTable);
      const anyMem = table.some((r) => r[COL.memory] && r[COL.memory] !== '—');
      const anyContacts = table.some((r) => /^\d+$/.test(r[COL.contacts] ?? ''));
      check('memory column populated for >=1 engine', anyMem, JSON.stringify(table.map((r) => r[COL.memory])));
      check('contact-pair column numeric for >=1 engine', anyContacts, JSON.stringify(table.map((r) => r[COL.contacts])));
    }

    const bootErrs = page.__errs.filter((e) => !/favicon/i.test(e));
    check('no console/page errors during compare', bootErrs.length === 0, bootErrs.slice(0, 3).join(' | '));
    await page.close();

    // ---- 2. layout: no page overflow, no header control clipped ---------
    for (const w of WIDTHS) {
      const lp = await newPage(browser);
      await lp.setViewportSize({ width: w, height: 820 });
      await lp.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
      await waitFor(lp, () => !!document.querySelector('.pa-shell'), 30000);
      await sleep(1500);
      const m = await lp.evaluate(() => {
        const de = document.documentElement;
        const ctrls = [...document.querySelectorAll('.pa-header .pa-controls > *')];
        const hidden = ctrls.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width === 0 || r.right > window.innerWidth + 2;
        }).length;
        // A label wrapped one glyph per line becomes unusually tall for a control.
        const tall = ctrls.filter((b) => b.getBoundingClientRect().height > 48).length;
        return {
          pageOverflowX: de.scrollWidth - de.clientWidth,
          hiddenCtrls: hidden,
          tallCtrls: tall,
          ctrls: ctrls.length,
        };
      });
      check(`layout @${w}: no horizontal page overflow`, m.pageOverflowX === 0, `overflowX=${m.pageOverflowX}`);
      check(`layout @${w}: no clipped header controls`, m.hiddenCtrls === 0, `hidden=${m.hiddenCtrls}/${m.ctrls}`);
      check(`layout @${w}: header controls not mangled`, m.tallCtrls === 0, `tall=${m.tallCtrls}`);
      await lp.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:\n' + failed.map((f) => `  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`).join('\n'));
    process.exit(1);
  }
})().catch((e) => { console.error('ui-gate error:', e); process.exit(1); });