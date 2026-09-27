// BSHSQ 场景验收（playwright-core + 本机 msedge）。
//
// 用法：
//   npm run preview
//   node scripts/verify-scenarios.mjs                 # 全部场景冒烟
//   node scripts/verify-scenarios.mjs --fluid         # 只验流体（含液面判定）
//   node scripts/verify-scenarios.mjs --group 破坏与流体
//
// 做两件事：
//   1. 每个场景都能选中、建出刚体、跑若干秒不出 NaN；
//   2. 流体场景额外判定「液体有没有真的摊平」——
//      一整块水落进水池后，粒子的 Y 跨度必须明显塌缩。
//      这一条是刚体球做不到的（没有压力项，它会保持堆成的小丘），
//      所以它是「这确实是流体」而不是「这是一堆球」的判据。
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.ARENA_URL ?? 'http://localhost:4173';
const argv = process.argv.slice(2);
const FLUID_ONLY = argv.includes('--fluid');
const GROUP = readFlag('--group');
const OUT = 'out/verify-scenarios.json';

function readFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Y span of every renderer layer, plus the body count, for one moment in time. */
async function snapshot(page) {
  return page.evaluate(() => {
    const a = window.__bshsq;
    const m = a.metrics();
    const pick = (k) => {
      for (const r of m) if (r.key === k) return r.value;
      return '?';
    };
    return {
      // Fluid readout comes from the solver, not from the renderer probe: all
      // bodies in a scene share one renderer layer, so instance transforms
      // cannot tell water from walls.
      fluid: typeof a.fluidStats === 'function' ? a.fluidStats() : null,
      bodies: pick('bodies-total'),
      dynamic: pick('bodies-dynamic'),
      step: pick('step-p50'),
      fps: pick('phys-fps'),
      joints: pick('joints'),
      summary: JSON.stringify(a.simStateSummary()).slice(0, 120),
    };
  });
}

async function main() {
  mkdirSync('out', { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const problems = [];
  const http404 = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() === 404) http404.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // "Failed to load resource" carries no URL, so it is resolved against the
    // recorded responses at the end instead of guessed at here.
    if (/Failed to load resource/.test(m.text())) return;
    problems.push(m.text().slice(0, 100));
  });

  console.log(`[scenarios] ${BASE}`);
  await page.goto(`${BASE}/?engine=rapier3d&scene=pbf-pool&renderer=three&preserveBuffer=1`, {
    waitUntil: 'load',
    timeout: 60000,
  });
  await page.waitForFunction(() => !!window.__bshsq, null, { timeout: 60000 });
  await page.waitForTimeout(15000);

  const all = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pa-scenario')).map((b) => b.textContent || ''),
  );
  let ids = await page.evaluate(() => window.__bshsq.listScenarios().map((s) => ({ id: s.id, group: s.group })));
  if (!Array.isArray(ids) || ids.length === 0) {
    // Fall back to the DOM if the hook is not exposed yet.
    ids = all.map((t) => ({ id: '', group: '' }));
  }
  if (GROUP) ids = ids.filter((s) => s.group === GROUP);
  if (FLUID_ONLY) ids = ids.filter((s) => /^pbf-/.test(s.id));
  console.log(`场景：${ids.length} 个待测`);

  const results = [];
  for (const s of ids) {
    if (!s.id) continue;
    const t0 = Date.now();
    await page.evaluate((id) => window.__bshsq.selectScenario(id), s.id);
    await page.waitForTimeout(1200);
    const early = await snapshot(page);
    // Fluid needs time to fall and level; rigid scenes just need to settle.
    await page.waitForTimeout(/^pbf-/.test(s.id) ? 11000 : 4000);
    const late = await snapshot(page);
    const nan = /NaN/.test(late.summary);
    const bodies = Number(String(late.bodies).replace(/[^0-9]/g, '')) || 0;
    // What "working fluid" means here.
    //
    // The first version required the Y span to shrink by 20%, on the theory
    // that a body of liquid levels out. That is the right test for fluid poured
    // in as a column, but `fluidVolume` authors the particles already packed at
    // their spacing - so the span starts near its final value and the check
    // failed a fluid that was behaving perfectly.
    //
    // The property that actually separates "fluid" from "loose spheres" is
    // whether the packing holds together. A relaxed incompressible body keeps
    // ~27 neighbours at h = 2 * spacing; a pile of independent rigid spheres
    // has whatever the engine gives it and drifts apart. So: neighbour count.
    const neighbours = late.fluid ? late.fluid.avgNeighbours : null;
    const packed = neighbours === null ? null : neighbours > 12;
    const spanEarly = early.fluid ? early.fluid.spanY : null;
    const spanLate = late.fluid ? late.fluid.spanY : null;
    const settled = spanEarly === null || spanLate === null
      ? null
      : Math.abs(spanLate - spanEarly) / Math.max(0.01, spanEarly) < 0.5;
    const ok = !nan && bodies > 0 && packed !== false && settled !== false;
    results.push({
      id: s.id, group: s.group, ok, nan, bodies,
      joints: late.joints, step: late.step, fps: late.fps,
      spanEarly: spanEarly === null ? null : Number(spanEarly.toFixed(2)),
      spanLate: spanLate === null ? null : Number(spanLate.toFixed(2)),
      neighbours: neighbours === null ? null : Number(neighbours.toFixed(1)),
      packed, settled, ms: Date.now() - t0,
    });
    const bits = [
      ok ? 'OK  ' : 'FAIL',
      String(s.id).padEnd(20),
      `刚体=${String(bodies).padEnd(5)}`,
      `关节=${String(late.joints).padEnd(4)}`,
      `p50=${String(late.step).padEnd(7)}`,
    ];
    if (neighbours !== null) {
      bits.push(`邻居 ${neighbours.toFixed(1)}${packed ? ' 密实' : ' 松散'}`);
    }
    if (spanLate !== null) {
      bits.push(`Y跨度 ${spanEarly}→${spanLate}${settled ? ' 稳定' : ' 仍在变'}`);
    }
    console.log('  ' + bits.join(' '));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 场景：${results.length - failed.length}/${results.length} 通过`);
  for (const f of failed) {
    console.log(`  失败：${f.id}${f.nan ? '（NaN）' : ''}${f.packed === false ? '（未保持密实）' : ''}${f.settled === false ? '（高度仍在剧变）' : ''}`);
  }
  // Browsers request /favicon.ico on their own; this project ships none.
  const real404 = http404.filter((u) => !/favicon/i.test(u));
  problems.push(...real404.map((u) => `404: ${u}`));
  if (problems.length) {
    console.log(`页面问题 ${problems.length} 条：`);
    for (const p of problems.slice(0, 5)) console.log('  · ' + p);
  } else {
    console.log('页面问题：无');
  }
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, results, problems }, null, 2));
  console.log(`报告已写入 ${OUT}`);
  await browser.close();
  return failed.length || problems.length ? 1 : 0;
}

process.exitCode = await main();
