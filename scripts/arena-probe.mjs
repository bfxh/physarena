// 单点诊断：跑一个引擎×场景的跑分单元并打印 notes（排查 PhysX CCD 用）。
// 用法： node scripts/arena-probe.mjs <engineId> <scenarioId>
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const [eng, sc, bodiesArg] = [process.argv[2] ?? 'physx5', process.argv[3] ?? 'ccd-onslaught', process.argv[4]];
const bodies = bodiesArg ? Number(bodiesArg) : undefined;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  ! ' + m.text()); });
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__bshsq, null, { timeout: 60000 });
const results = await page.evaluate(
  ({ eng, sc, bodies }) => window.__bshsq.runBenchCells([eng], [sc], bodies),
  { eng, sc, bodies },
);
writeFileSync('out/probe.json', JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`${r.engineName} · ${r.scenarioName}: p50=${r.timing.p50?.toFixed(3)}ms hash=${r.stateHash}`);
  console.log('  bodies:', r.dynamicBodies, ' awake:', r.awakeFraction, ' sleepOnset:', r.sleepOnsetStep);
  for (const n of r.notes) console.log('  note:', n);
  if (r.error) console.log('  ERROR:', r.error);
}
await browser.close();
