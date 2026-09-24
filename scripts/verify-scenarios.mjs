// PhysArena 场景验收（playwright-core + 本机 msedge）。
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
    const a = window.__physarena;
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
  await page.waitForFunction(() => !!window.__physarena, null, { timeout: 60000 });
  await page.waitForTimeout(15000);

  const all = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pa-scenario')).map((b) => b.textContent || ''),
  );
  let ids = await page.evaluate(() => window.__physarena.listScenarios().map((s) => ({ id: s.id, group: s.group })));
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
    await page.evaluate((id) => window.__physarena.selectScenario(id), s.id);
    await page.waitForTimeout(1200);
    const early = await snapshot(page);
    // Fluid needs time to fall and level; rigid scenes just need to settle.
    await page.waitForTimeout(/^pbf-/.test(s.id) ? 11000 : 4000);
    const late = await snapshot(page);
    const nan = /NaN/.test(late.summary);
    const bodies = Number(String(late.bodies).replace(/[^0-9]/g, '')) || 0;
    // Leveling check: the fluid's own Y span must shrink as it finds its level.
    const spanEarly = early.fluid ? early.fluid.spanY : null;
    const spanLate = late.fluid ? late.fluid.spanY : null;
    // 20% is a low bar on purpose: a scene that only settles somewhat is still
    // working. What it rules out is the rigid-sphere failure mode, where the
    // span does not change at all because nothing is pushing the pile apart.
    const levelled = spanEarly !== null && spanLate !== null ? spanLate < spanEarly * 0.8 : null;
    const ok = !nan && bodies > 0 && (levelled === null || levelled === true);
    results.push({
      id: s.id, group: s.group, ok, nan, bodies,
      joints: late.joints, step: late.step, fps: late.fps,
      spanEarly: spanEarly === null ? null : Number(spanEarly.toFixed(2)),
      spanLate: spanLate === null ? null : Number(spanLate.toFixed(2)),
      levelled, ms: Date.now() - t0,
    });
    const bits = [
      ok ? 'OK  ' : 'FAIL',
      String(s.id).padEnd(20),
      `刚体=${String(bodies).padEnd(5)}`,
      `关节=${String(late.joints).padEnd(4)}`,
      `p50=${String(late.step).padEnd(7)}`,
    ];
    if (spanLate !== null) {
      bits.push(`Y跨度 ${spanEarly}→${spanLate}${levelled ? ' 已摊平' : ' 未摊平'}`);
    }
    console.log('  ' + bits.join(' '));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 场景：${results.length - failed.length}/${results.length} 通过`);
  for (const f of failed) console.log(`  失败：${f.id}${f.nan ? '（NaN）' : ''}${f.levelled === false ? '（液体未摊平）' : ''}`);
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
