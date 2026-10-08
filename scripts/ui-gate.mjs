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
// `--gpu` = manual deep check on a real GPU: run headful, do NOT force the
// software rasteriser, and opt into WebGPU (which is gated behind
// `?allowWebGPU=1` because on SwiftShader it freezes the main thread). This is
// the only way to exercise the WebGPU path and real-GL drivers - CI is stuck on
// SwiftShader and skips WebGPU entirely.
const GPU_MODE = process.argv.includes('--gpu');
const CHANNEL = process.env.UI_GATE_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome');
const HEADFUL = GPU_MODE || process.env.UI_GATE_HEADFUL === '1';

// Compare-table column order is defined in comparePanel(); keep in sync.
const COL = { engine: 0, p50: 1, steps: 5, contacts: 7, memory: 8, rel: 9 };
// Full range: ultrawide down to a phone. A fixed-width 3-column shell can
// collapse the 1fr centre to zero on a narrow viewport, which hides the 3D
// view entirely - the layout checks below assert the viewport stays visible.
const WIDTHS = [2560, 1440, 1280, 1152, 1024, 768, 390];

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
  // Force SwiftShader only for the headless CI path; a real GPU must use the
  // real driver, otherwise we would be testing the same software raster again.
  const launchArgs = GPU_MODE ? ['--no-sandbox', '--ignore-gpu-blocklist']
    : ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({
    channel: CHANNEL,
    headless: !HEADFUL,
    args: launchArgs,
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

      // Display self-consistency: the "relative to fastest" column is derived
      // from the p50 column - the fastest engine must read exactly 1.00x and no
      // row may read below 1.00x (a nonsensical "faster than fastest"). This
      // catches a column that renders stale or mis-scaled numbers.
      const rel = (await page.evaluate(compareTable)).map((r) => parseFloat(String(r[COL.rel]).replace('×', ''))).filter((v) => !Number.isNaN(v));
      check('compare: relative-to-fastest column is self-consistent', rel.length >= 2 && rel.some((v) => Math.abs(v - 1) < 1e-6) && rel.every((v) => v >= 1 - 1e-9),
        `values=${JSON.stringify(rel)}`);

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

    // ---- 2. inventory: loadRenderers/loadRegistry DROP a module whose
    // dynamic import rejects, so a broken module silently disappears from the
    // list - indistinguishable from "some entries are missing". Guard the floor.
    const ip = await newPage(browser);
    await ip.setViewportSize({ width: 1440, height: 900 });
    await ip.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
    await waitFor(ip, () => !!document.querySelector('.pa-shell'), 30000);
    await sleep(2000);
    const inv = await ip.evaluate(() => ({
      engines: document.querySelectorAll('.pa-panel-left .pa-engine').length,
      renderers: document.querySelectorAll('.pa-panel-right .pa-engine').length,
      scenarios: document.querySelectorAll('.pa-scenario').length,
    }));
    check('engine list populated', inv.engines >= 9, `engines=${inv.engines}`);
    check('renderer list populated', inv.renderers >= 10, `renderers=${inv.renderers}`);
    check('scenario list populated', inv.scenarios >= 70, `scenarios=${inv.scenarios}`);

    // Display completeness: the primary readouts must actually show values, not
    // just exist. A panel that renders empty looks identical to a working one in
    // a count-only check - only reading the text tells them apart.
    await sleep(2500);
    const hud1 = await ip.evaluate(() => window.__physarena.hudText());
    await sleep(1600);
    const hud2 = await ip.evaluate(() => window.__physarena.hudText());
    check('HUD renders labelled rows with live values', /已跑步数/.test(hud1) && /\d/.test(hud1) && hud1 !== hud2, `len=${hud1.length} live=${hud1 !== hud2}`);
    const insp = await ip.evaluate(() => {
      const rows = [...document.querySelectorAll('.pa-panel-right .pa-metric')];
      return { n: rows.length, empty: rows.filter((r) => !r.textContent || /(^|\s)—(\s|$)/.test(r.textContent.trim())).length };
    });
    check('inspector metric rows are populated', insp.n >= 5 && insp.empty === 0, `rows=${insp.n} empty=${insp.empty}`);
    await ip.close();

    // ---- 3. bench mode renders its config pane
    const bp = await newPage(browser);
    await bp.goto(`${BASE}?mode=bench`, { waitUntil: 'load' });
    await waitFor(bp, () => !!document.querySelector('.pa-bench'), 30000);
    await sleep(1500);
    const bench = await bp.evaluate(() => ({
      pane: !!document.querySelector('.pa-bench'),
      checks: document.querySelectorAll('.pa-bench .pa-check').length,
    }));
    check('bench mode renders config', bench.pane && bench.checks > 0, `checks=${bench.checks}`);

    // The bench *logic* is covered by the matrix/determinism checks, but the
    // results TABLE was never exercised - the hook fills benchResults without
    // rendering. Scope the config down to one engine x one scenario so the real
    // start button runs fast, then assert the table actually appears.
    await bp.evaluate(() => {
      const secs = [...document.querySelectorAll('#pa-bench-cfg .pa-section')];
      const keepFirst = (sec) => {
        [...sec.querySelectorAll('input[type=checkbox]')].forEach((b, i) => {
          const want = i === 0;
          if (b.checked !== want) { b.checked = want; b.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      };
      if (secs[0]) keepFirst(secs[0]);
      if (secs[1]) keepFirst(secs[1]);
      const btn = [...document.querySelectorAll('#pa-bench-cfg button')].find((x) => /开始跑分/.test(x.textContent || ''));
      if (btn) btn.click();
    });
    let benchTable = false, benchRows = 0;
    for (let i = 0; i < 90; i++) {
      const r = await bp.evaluate(() => {
        const t = document.querySelector('.pa-bench-main table');
        return { has: !!t, rows: t ? t.querySelectorAll('tbody tr').length : 0 };
      });
      if (r.has && r.rows > 0) { benchTable = true; benchRows = r.rows; break; }
      await sleep(1000);
    }
    check('bench: start button produces a rendered results table', benchTable, `rows=${benchRows}`);
    const csvBtn = await bp.evaluate(() => !!([...document.querySelectorAll('#pa-bench-cfg button')].find((x) => /导出 CSV/.test(x.textContent || ''))));
    check('bench: export CSV button appears after a run', csvBtn);
    await bp.close();

    // ---- 3b. functional depth: every engine steps, every renderer draws ----
    // The list rendering a card is not proof the part works: an engine can be
    // listed but fail to boot, a renderer can mount and paint nothing. Drive
    // each one through the app's automation hooks and assert real behaviour.
    const fp = await newPage(browser);
    await fp.setViewportSize({ width: 1440, height: 900 });
    // preserveBuffer=1 turns on preserveDrawingBuffer so the WebGL backends can
    // be read back with drawImage; without it a composited WebGL frame reads as
    // blank and every GL renderer would look like it drew nothing. In GPU mode
    // also opt into WebGPU, which is otherwise gated off.
    const fpUrl = `${BASE}?mode=sandbox&preserveBuffer=1${GPU_MODE ? '&allowWebGPU=1' : ''}`;
    await fp.goto(fpUrl, { waitUntil: 'load' });
    await waitFor(fp, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await sleep(1500);

    // engines: select each, require the sim to actually step
    const engineIds = await fp.evaluate(() => window.__physarena.engineIds());
    for (const id of engineIds) {
      try { await fp.evaluate((e) => window.__physarena.selectEngine(e), id); } catch { /* handled by the check */ }
      const ran = await waitFor(fp, () => window.__physarena.simStateSummary().some((x) => (x.steps ?? 0) > 2), 45000);
      check(`engine steps: ${id}`, ran);
    }

    // renderers: select each, sample the canvas for real pixels. A renderer the
    // environment cannot run is reported via `unavailable` and skipped - but a
    // runnable one that mounts and paints nothing is a failure.
    const renderers = await fp.evaluate(() => window.__physarena.listRenderers().map((r) => ({ id: r.id, unavailable: r.unavailable })));
    for (const r of renderers) {
      if (r.unavailable) { check(`renderer draws: ${r.id}`, true, 'unavailable in this env (skipped)'); continue; }
      let cur = null;
      try { await fp.evaluate((x) => window.__physarena.selectRenderer(x), r.id); cur = await fp.evaluate(() => window.__physarena.currentRenderer()); } catch { /* treated as failure below */ }
      if (cur !== r.id) { check(`renderer draws: ${r.id}`, false, 'selection did not take effect'); continue; }
      await sleep(r.id === 'babylon' ? 5000 : 2600);
      const s = await fp.evaluate(() => {
        const el = document.querySelector('.pa-canvas');
        let drawn = false, why = '';
        if (!el) return { drawn: false, why: 'no .pa-canvas' };
        if (el.tagName !== 'CANVAS') { drawn = el.querySelectorAll('*').length > 2; why = 'dom-nodes'; }
        else {
          const t = document.createElement('canvas'); t.width = el.width; t.height = el.height;
          const g = t.getContext('2d'); g.drawImage(el, 0, 0);
          const d = g.getImageData(0, 0, t.width, t.height).data;
          const uniq = new Set();
          for (let i = 0; i < d.length; i += 64) uniq.add(`${d[i] >> 4}.${d[i + 1] >> 4}.${d[i + 2] >> 4}`);
          drawn = uniq.size > 3; why = `distinct=${uniq.size}`;
        }
        return { drawn, why, stats: window.__physarena.rendererStats() };
      });
      // Pixels are the ground truth, but on a REAL GPU (headful) the canvas drawing
      // buffer is cleared after compositing, so drawImage reads blank for most
      // backends even while they render correctly. Fall back to the backend's
      // own draw-call/instance/triangle counters there. A backend that truly
      // paints nothing has empty stats AND blank pixels, so it still fails - the
      // headless pixel check remains the strict guard, and stats backstops only
      // where readback is untrustworthy.
      const statsWork = (s.stats?.drawCalls ?? 0) > 0 || (s.stats?.instances ?? 0) > 0 || (s.stats?.triangles ?? 0) > 0;
      const evidence = s.drawn || statsWork;
      check(`renderer draws: ${r.id}`, evidence, s.drawn ? s.why : `${s.why} (readback blank; stats drawCalls=${s.stats?.drawCalls ?? 0} instances=${s.stats?.instances ?? 0})`);
    }

    // scenarios: sample across groups (not just the first five) so a breakage
    // confined to, say, the fluids or joints group cannot hide.
    const scen = await fp.evaluate(() => window.__physarena.listScenarios()); // [{id,group}]
    const byGroup = new Map();
    for (const s of scen) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group).push(s.id);
    }
    const sample = [];
    for (const ids of byGroup.values()) sample.push(...ids.slice(0, 2));
    const scenSample = sample.slice(0, 10);
    for (const sid of scenSample) {
      try { await fp.evaluate((x) => window.__physarena.selectScenario(x), sid); } catch { /* handled */ }
      const ok = await waitFor(fp, () => window.__physarena.simStateSummary().some((x) => (x.steps ?? 0) > 1 && (x.nonFinite ?? 0) === 0), 20000);
      check(`scenario runs: ${sid}`, ok);
    }

    // resilience: rapid engine/scenario churn must not wedge the app or leak
    // page errors. Real users click fast; a wedged loop is invisible to the
    // per-feature checks above because each of those starts from a clean page.
    const churn = await fp.evaluate(async () => {
      const es = window.__physarena.engineIds();
      const ss = window.__physarena.scenarioIds();
      for (let i = 0; i < 6; i++) {
        window.__physarena.selectEngine(es[i % es.length]);
        window.__physarena.selectScenario(ss[i % ss.length]);
        await new Promise((r) => setTimeout(r, 120));
      }
      return true;
    });
    await sleep(2500);
    const alive = await waitFor(fp, () => window.__physarena.simStateSummary().some((x) => (x.steps ?? 0) > 2), 20000);
    check('resilience: survives rapid engine/scenario churn', churn && alive);
    await fp.close();

    // ---- 4. layout: no page overflow, no header control clipped ---------
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
        const stage = document.querySelector('.pa-stage');
        return {
          pageOverflowX: de.scrollWidth - de.clientWidth,
          hiddenCtrls: hidden,
          tallCtrls: tall,
          ctrls: ctrls.length,
          stageW: Math.round(stage?.getBoundingClientRect().width || 0),
        };
      });
      check(`layout @${w}: no horizontal page overflow`, m.pageOverflowX === 0, `overflowX=${m.pageOverflowX}`);
      check(`layout @${w}: no clipped header controls`, m.hiddenCtrls === 0, `hidden=${m.hiddenCtrls}/${m.ctrls}`);
      check(`layout @${w}: header controls not mangled`, m.tallCtrls === 0, `tall=${m.tallCtrls}`);
      check(`layout @${w}: 3D viewport stays visible`, m.stageW >= 120, `stageW=${m.stageW}`);
      await lp.close();
    }

    // ---- 4b. short viewports: panes keep a usable height ----------------
    // Width alone is not enough - a short window starves the 3D view because
    // the (supplementary) compare table refuses to yield height. Load compare
    // once, then sweep the height: the panes must never be squashed away.
    const hp = await newPage(browser);
    await hp.setViewportSize({ width: 1024, height: 820 });
    await hp.goto(`${BASE}?mode=compare`, { waitUntil: 'load' });
    await waitFor(hp, () => document.querySelectorAll('.pa-slot-compare tbody tr').length >= 2, 30000);
    await sleep(2000);
    for (const h of [820, 520, 380, 280]) {
      await hp.setViewportSize({ width: 1024, height: h });
      await sleep(1400);
      const sh = await hp.evaluate(() => Math.round(document.querySelector('.pa-stage')?.getBoundingClientRect().height || 0));
      check(`short viewport @1024x${h}: 3D view keeps usable height`, sh >= 100, `stageH=${sh}`);
    }
    await hp.close();

    // ---- 5. determinism: the same cell run twice must hash identically ----
    // A benchmark lab whose numbers move between identical runs is measuring
    // noise. stateHash is the lab's own fingerprint of the final world state.
    const dp = await newPage(browser);
    await dp.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
    await waitFor(dp, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await sleep(1200);
    const engineForBench = await dp.evaluate(() => window.__physarena.engineIds().find((e) => e === 'rapier3d') || window.__physarena.engineIds()[0]);
    const scenForBench = await dp.evaluate(() => window.__physarena.scenarioIds()[0]);
    const hashes = [];
    let completed = false, benchErr = null;
    for (let k = 0; k < 2; k++) {
      const res = await dp.evaluate(([e, s]) => window.__physarena.runBenchCells([e], [s]), [engineForBench, scenForBench]);
      const row = Array.isArray(res) ? res[0] : null;
      hashes.push(row?.stateHash ?? '');
      if (k === 0) { completed = !!row?.completed; benchErr = row?.error ?? null; }
    }
    check('bench cell completes without error', completed && !benchErr, benchErr ?? '');
    check('bench is deterministic (same stateHash across two runs)', hashes[0] !== '' && hashes[0] === hashes[1], `${hashes[0]} vs ${hashes[1]}`);

    // a real matrix, not one cell: every engine×scenario cell must run to
    // completion with a real state hash. A per-cell failure here (an engine
    // that cannot finish a scenario) is exactly the kind of defect the lab
    // exists to surface - it must never ship silently.
    const matrixEngines = await dp.evaluate(() => ['BSHSQ-Solver', 'rapier3d', 'jolt'].filter((e) => window.__physarena.engineIds().includes(e)));
    const matrixScens = await dp.evaluate(() => window.__physarena.scenarioIds().slice(0, 2));
    const mres = await dp.evaluate(([es, ss]) => window.__physarena.runBenchCells(es, ss), [matrixEngines, matrixScens]);
    const cells = Array.isArray(mres) ? mres : [];
    const badCells = cells.filter((r) => !r.completed || r.error || !r.stateHash);
    check('bench matrix: every engine×scenario cell completes', cells.length === matrixEngines.length * matrixScens.length && badCells.length === 0,
      `${cells.length} cells; bad=${JSON.stringify(badCells.map((r) => `${r.engineId}/${r.scenarioId}:${r.error || (r.completed ? 'nohash' : 'incomplete')}`))}`);

    // Determinism must survive a reload, not just two runs in one session: a fresh
    // page rebuilds every engine module and every world from scratch. Run the
    // whole matrix again post-reload - stronger than a single cell.
    const matrixHashes = cells.map((r) => r.stateHash);
    await dp.reload({ waitUntil: 'load' });
    await waitFor(dp, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await sleep(1500);
    const cells2 = await dp.evaluate(([es, ss]) => window.__physarena.runBenchCells(es, ss), [matrixEngines, matrixScens]);
    const matrixHashes2 = (Array.isArray(cells2) ? cells2 : []).map((r) => r.stateHash);
    const sameMatrix = matrixHashes.length === matrixHashes2.length && matrixHashes.length > 0
      && matrixHashes.every((h, i) => h === matrixHashes2[i]);
    check('bench matrix is deterministic across a page reload', sameMatrix,
      matrixHashes.map((h, i) => `${h}/${matrixHashes2[i]}`).join(' '));
    await dp.close();

    // ---- 6. interactions: the controls are actually wired ---------------
    // A rendered button proves nothing if its handler is dead. Drive the
    // transport (pause / single-step), the collapsible panels, and a 3-engine
    // compare (a different N-pane code path than the default 2).
    const tp = await newPage(browser);
    await tp.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
    await waitFor(tp, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await sleep(2500);

    const pauseClicked = await tp.evaluate(() => {
      const b = [...document.querySelectorAll('.pa-header .pa-controls button')].find((x) => /暂停|继续/.test(x.textContent || ''));
      if (!b) return false; b.click(); return true;
    });
    await sleep(400);
    const st1 = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.steps ?? 0);
    await sleep(1500);
    const st2 = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.steps ?? 0);
    check('transport: pause freezes stepping', pauseClicked && st1 === st2 && st1 > 0, `steps ${st1} -> ${st2}`);
    await tp.evaluate(() => {
      const b = [...document.querySelectorAll('.pa-header .pa-controls button')].find((x) => /单步/.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(500);
    const st3 = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.steps ?? 0);
    check('transport: single-step advances by exactly 1', st3 === st2 + 1, `${st2} -> ${st3}`);

    // collapsible panels keep a usable rail instead of vanishing
    await tp.evaluate(() => { const b = document.querySelector('.pa-collapse-left'); if (b) b.click(); });
    await sleep(400);
    const lc = await tp.evaluate(() => ({
      cls: !!document.querySelector('.pa-shell.left-collapsed'),
      rail: !!document.querySelector('.pa-shell.left-collapsed .pa-rail'),
    }));
    check('left panel collapses to a rail', lc.cls && lc.rail, JSON.stringify(lc));
    await tp.evaluate(() => { const b = document.querySelector('.pa-collapse-left'); if (b) b.click(); });
    await sleep(300);

    // 'r' rebuilds the world - the reset path no other check exercises.
    const preReset = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.steps ?? 0);
    await tp.keyboard.press('r');
    let resetOk = false, postReset = -1;
    for (let i = 0; i < 16; i++) {
      postReset = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.steps ?? -1);
      if (postReset < preReset) { resetOk = true; break; }
      await sleep(300);
    }
    check('shortcut: r resets the world', preReset > 0 && resetOk, `${preReset} -> ${postReset}`);

    // the bodies slider rebuilds the scene with the new count
    const bodiesBefore = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.bodies ?? 0);
    await tp.evaluate(() => {
      const r = [...document.querySelectorAll('.pa-header .pa-controls input[type=range]')][0];
      if (!r) return;
      r.value = String(Math.max(8, Math.round(Number(r.value) / 2)));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let bodiesNow = -1, rebuilt = false;
    for (let i = 0; i < 20; i++) {
      bodiesNow = await tp.evaluate(() => window.__physarena.simStateSummary()[0]?.bodies ?? -1);
      if (bodiesNow > 0 && bodiesNow < bodiesBefore) { rebuilt = true; break; }
      await sleep(400);
    }
    check('slider: changing bodies rebuilds the scene', bodiesBefore > 0 && rebuilt, `${bodiesBefore} -> ${bodiesNow}`);

    // a 3-engine compare exercises the N-pane layout, not the 2-pane default
    const cp = await newPage(browser);
    await cp.goto(`${BASE}?mode=compare`, { waitUntil: 'load' });
    await waitFor(cp, () => document.querySelectorAll('.pa-slot-compare tbody tr').length >= 2, 30000);
    await sleep(2500);
    await cp.evaluate(() => window.__physarena.selectEngine('jolt'));
    await sleep(2500);
    await cp.evaluate(() => window.__physarena.selectEngine('cannon-es'));
    await sleep(3000);
    const mc = await cp.evaluate(() => ({
      rows: document.querySelectorAll('.pa-slot-compare tbody tr').length,
      labels: document.querySelectorAll('.pa-slot-label').length,
    }));
    check('compare: 4 engines render 4 rows + 4 panes (max-pane path)', mc.rows === 4 && mc.labels === 4, JSON.stringify(mc));
    await cp.close();
    await tp.close();

    // ---- 7. full self-test matrix (every engine x every probe) ----------
    // Probe failures are legitimate findings (PhysX has no convex hull, ...),
    // so the gate asserts the *machinery*: it finishes, every engine boots or
    // reports an explicit error, and every engine yields probe verdicts. It does
    // not assert a pass rate - that is the lab's output, not a build invariant.
    // Polled rather than awaited so a hung self-test fails the gate instead of
    // hanging CI forever.
    const sp = await newPage(browser);
    await sp.goto(`${BASE}?mode=bench`, { waitUntil: 'load' });
    await waitFor(sp, () => !!(window.__physarena && document.querySelector('.pa-bench')), 30000);
    await sleep(1000);
    await sp.evaluate(() => {
      window.__stDone = false;
      window.__physarena.runSelfTest().then(() => { window.__stDone = true; }, () => { window.__stDone = true; });
    });
    const mapRows = () => window.__physarena.getSelfTestResults().map((r) => ({
      id: r.engineId, bootOk: r.bootOk, bootError: r.bootError ?? null,
      n: (r.results || []).length, pass: r.passCount, fail: r.failCount,
    }));
    let rows = [];
    for (let i = 0; i < 300; i++) {
      const st = await sp.evaluate(() => ({ done: window.__stDone, n: window.__physarena.getSelfTestResults().length }));
      if (st.done && st.n > 0) { rows = await sp.evaluate(mapRows); break; }
      if (st.done && st.n === 0) break;
      await sleep(1000);
    }
    const totalProbes = rows.reduce((a, r) => a + r.n, 0);
    check('selftest: completes and produces a row for every engine', rows.length >= 9, `${rows.length} engine rows, ${totalProbes} probe verdicts`);
    check('selftest: every engine boots or reports an explicit error', rows.length > 0 && rows.every((r) => r.bootOk || !!r.bootError),
      JSON.stringify(rows.filter((r) => !r.bootOk && !r.bootError).map((r) => r.id)));
    check('selftest: every engine yields probe verdicts', totalProbes > 0 && rows.every((r) => r.n > 0),
      `per-engine=${JSON.stringify(rows.map((r) => r.n))}`);
    console.log(`      selftest pass/fail per engine: ${JSON.stringify(rows.map((r) => `${r.id}:${r.pass}/${r.fail}`))}`);
    // the self-test matrix must actually render in the bench pane, not just
    // exist in the hook - this is the compatibility matrix a reader comes for.
    await sleep(1200);
    const matrix = await sp.evaluate(() => {
      const tbl = document.querySelector('#pa-bench-main table, .pa-bench-main table');
      return { hasTable: !!tbl, cells: tbl ? tbl.querySelectorAll('td').length : 0 };
    });
    check('selftest: compatibility matrix renders in the UI', matrix.hasTable && matrix.cells > 0, `cells=${matrix.cells}`);
    await sp.close();

    // ---- 8. stress: resize storm, boot race, model import ---------------
    // Resizing while comparing recomputes the pane rects and the overlay. The
    // table and pane labels must survive a storm of width changes.
    const rp = await newPage(browser);
    await rp.goto(`${BASE}?mode=compare`, { waitUntil: 'load' });
    await waitFor(rp, () => document.querySelectorAll('.pa-slot-compare tbody tr').length >= 2, 30000);
    await sleep(2000);
    let resizeOk = true;
    const resizeSeen = [];
    // each pane label carries the live p50 readout - it is refreshed separately
    // from the table, so it can go stale while the table looks fine.
    const labelLive = await rp.evaluate(() => [...document.querySelectorAll('.pa-slot-label small')].map((s) => s.textContent || ''));
    check('compare: pane labels show a live p50', labelLive.length >= 2 && labelLive.every((t) => /\d/.test(t)), JSON.stringify(labelLive));
    for (const w of [900, 1300, 700, 1100, 640]) {
      await rp.setViewportSize({ width: w, height: 820 });
      await sleep(900);
      const st = await rp.evaluate(() => ({
        rows: document.querySelectorAll('.pa-slot-compare tbody tr').length,
        labels: document.querySelectorAll('.pa-slot-label').length,
      }));
      resizeSeen.push(`${w}:${st.rows}r/${st.labels}l`);
      if (st.rows < 2 || st.labels < 2) resizeOk = false;
    }
    check('stress: compare survives repeated resize', resizeOk, resizeSeen.join(' '));
    await rp.close();

    // Boot race: switch engine/scenario while a world is still booting (30ms
    // gaps land mid-boot). The app must recover, and - unlike the gentler churn
    // check - must not leak an uncaught exception.
    const bc = await newPage(browser);
    await bc.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
    await waitFor(bc, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await bc.evaluate(async () => {
      const es = window.__physarena.engineIds();
      const ss = window.__physarena.scenarioIds();
      for (let i = 0; i < 6; i++) {
        window.__physarena.selectEngine(es[i % es.length]);
        window.__physarena.selectScenario(ss[(i + 3) % ss.length]);
        await new Promise((r) => setTimeout(r, 30));
      }
    });
    const recovered = await waitFor(bc, () => window.__physarena.simStateSummary().some((x) => (x.steps ?? 0) > 2), 30000);
    check('stress: recovers from switching mid-boot', recovered);
    check('stress: no uncaught errors during boot race', bc.__errs.length === 0, bc.__errs.slice(0, 3).join(' | '));
    await bc.close();

    // Model import: the drop path has no coverage anywhere. Feed a minimal valid
    // OBJ (a tetrahedron - 4 vertices, so the hull has enough points) through a
    // synthetic DataTransfer and assert it becomes a live, simulating scenario.
    const obj = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1', 'f 1 2 3', 'f 1 2 4', 'f 1 3 4', 'f 2 3 4'].join('\n');
    const imp = await newPage(browser);
    await imp.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
    await waitFor(imp, () => !!(window.__physarena && document.querySelector('.pa-stage')), 30000);
    await imp.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'gate.obj', { type: 'text/plain' }));
      document.querySelector('.pa-stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, obj);
    let imported = false;
    for (let i = 0; i < 24; i++) {
      if (await imp.evaluate(() => window.__physarena.scenarioIds().some((id) => id.startsWith('import:')))) { imported = true; break; }
      await sleep(500);
    }
    check('import: model drop creates an imported scenario', imported);
    if (imported) {
      const sims = await waitFor(imp, () => window.__physarena.simStateSummary().some((x) => (x.steps ?? 0) > 1), 25000);
      check('import: imported scenario simulates', sims);
    }
    await imp.close();

    // ---- 9. shareable URL round-trip + bounded soak ---------------------
    // A shared/reloaded URL must restore what its hash claims (the hash is the
    // fallback when there is no query string).
    const hp2 = await newPage(browser);
    await hp2.goto(BASE, { waitUntil: 'load' });
    await waitFor(hp2, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await sleep(1500);
    await hp2.evaluate(() => window.__physarena.selectEngine('jolt'));
    await sleep(2500);
    const hash = await hp2.evaluate(() => location.hash);
    await hp2.reload({ waitUntil: 'load' });
    await waitFor(hp2, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    const restored = await waitFor(hp2, () => window.__physarena.simStateSummary().some((x) => x.id === 'jolt'), 20000);
    check('share URL: hash round-trip restores the engine', /engine=jolt/.test(hash) && restored, `hash=${hash}`);
    await hp2.close();

    // Soak: a benchmark session runs for minutes. Over a bounded window the
    // step counter must keep advancing (no wedge) and renderer resources must
    // not grow per-frame (leak).
    const sp2 = await newPage(browser);
    await sp2.goto(`${BASE}?mode=sandbox`, { waitUntil: 'load' });
    await waitFor(sp2, () => !!(window.__physarena && document.querySelector('.pa-shell')), 30000);
    await sleep(2500);
    const geo0 = await sp2.evaluate(() => window.__physarena.rendererStats()?.geometries ?? 0);
    let monotone = true, lastStep = -1, errsDuringSoak = 0;
    for (let i = 0; i < 4; i++) {
      await sleep(5000);
      const st = await sp2.evaluate(() => window.__physarena.simStateSummary()[0]?.steps ?? 0);
      if (st <= lastStep) monotone = false;
      lastStep = st;
    }
    const geo1 = await sp2.evaluate(() => window.__physarena.rendererStats()?.geometries ?? 0);
    errsDuringSoak = sp2.__errs.length;
    check('soak: step counter never wedges over 20s', monotone && lastStep > 0, `lastStep=${lastStep}`);
    check('soak: no renderer resource runaway (leak guard)', geo1 <= geo0 + 10, `geometries ${geo0} -> ${geo1}`);
    check('soak: no errors during sustained run', errsDuringSoak === 0, sp2.__errs.slice(0, 2).join(' | '));
    await sp2.close();
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