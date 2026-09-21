// PhysArena 无头驱动（playwright-core + 本机 Edge）。
//
// 用法：
//   node scripts/arena-drive.mjs selftest        # 跑完整自检矩阵，落盘 `out/selftest${OUT_TAG}.json`
//   node scripts/arena-drive.mjs bench           # 跑一个默认引擎×场景子集的跑分，落盘 `out/bench${OUT_TAG}.json`
//
// 不下载浏览器：直接使用系统安装的 msedge（channel: 'msedge'）。
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.ARENA_URL ?? 'http://localhost:4173';
const task = process.argv[2] ?? 'selftest';
const OUT_TAG = process.env.ARENA_TAG ? `-${process.env.ARENA_TAG}` : '';

mkdirSync('out', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });

const consoleErrors = [];
const http404 = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  if (r.status() === 404) http404.push(r.url());
});

console.log(`[arena-drive] ${task} @ ${BASE}`);
await page.goto(`${BASE}/?${task === 'selftest' ? 'selftest=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__physarena, null, { timeout: 60000 });

if (task === 'selftest') {
  // ?selftest=1 already started the run; wait for the report to be published.
  console.log('[arena-drive] 等待自检矩阵完成…');
  await page.waitForFunction(() => Array.isArray(window.__physarena_report), null, {
    timeout: 30 * 60 * 1000,
  });
  const report = await page.evaluate(() => window.__physarena_report);
  writeFileSync(`out/selftest${OUT_TAG}.json`, JSON.stringify(report, null, 2));
  const summary = report.map((r) => ({
    engine: r.engineName,
    boot: r.bootOk,
    pass: r.passCount,
    degraded: r.degradedCount,
    fail: r.failCount,
  }));
  console.table(summary);
  const probeCount = report[0]?.results?.length ?? 0;
  console.log(`[arena-drive] 矩阵完成：${report.length} 引擎 × ${probeCount} 探针`);
  const fails = [];
  for (const r of report) {
    for (const p of r.results) {
      if (p.status === 'fail') fails.push(`${r.engineName} · ${p.probeName} · ${p.detail}`);
    }
  }
  console.log(`[arena-drive] 失败项 ${fails.length}`);
  for (const f of fails) console.log('  ✘ ' + f);
} else if (task === 'bench') {
  // A compact engine x scenario sweep that exercises every class of scene.
  const engines = ['vxl-phys', 'rapier3d', 'jolt', 'physx5', 'havok', 'bullet', 'crashcat', 'cannon-es', 'oimo'];
  const scenarios = ['pyramid', 'brick-wall', 'ball-pit', 'chain-hinge', 'ccd-onslaught', 'trimesh-terrain', 'ragdoll', 'spring-net'];
  console.log(`[arena-drive] 跑分：${engines.length} 引擎 × ${scenarios.length} 场景`);
  const results = await page.evaluate(
    ({ engines: ids, scenarios: scs }) => window.__physarena.runBenchCells(ids, scs),
    { engines, scenarios },
  );
  writeFileSync(`out/bench${OUT_TAG}.json`, JSON.stringify(results, null, 2));
  const rows = results.map((r) => ({
    engine: r.engineName,
    scenario: r.scenarioName,
    bodies: r.dynamicBodies,
    p50: Number(r.timing.p50.toFixed(3)),
    eqFps: Math.round(r.timing.equivalentFps),
    awake: Math.round(r.awakeFraction * 100),
    sleepOnset: r.sleepOnsetStep,
    hash: r.stateHash,
    notes: r.notes.join(' / '),
  }));
  console.table(rows);
  console.log('[arena-drive] bench done -> `out/bench${OUT_TAG}.json`');
} else {
  throw new Error(`未知任务 ${task}`);
}

if (consoleErrors.length) {
  console.log(`[arena-drive] 控制台错误 ${consoleErrors.length} 条：`);
  for (const e of consoleErrors.slice(0, 20)) console.log('  ! ' + e);
} else {
  console.log('[arena-drive] 控制台零错误');
}
if (http404.length) {
  console.log(`[arena-drive] HTTP 404 × ${http404.length}：`);
  for (const u of [...new Set(http404)].slice(0, 10)) console.log('  ? ' + u);
}

await browser.close();
