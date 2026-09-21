// 单/多探针复测：node scripts/arena-probe-only.mjs <engineId> <probeId> [repeats]
import { chromium } from 'playwright-core';

const [eng = 'physx5', probe = 'shape-cylinder', repeats = '1'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  ! ' + m.text()); });
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__physarena, null, { timeout: 60000 });

for (let i = 0; i < Number(repeats); i++) {
  const rows = await page.evaluate(
    ({ eng, probe }) => window.__physarena.runProbes([eng], [probe]),
    { eng, probe },
  );
  for (const r of rows) {
    for (const p of r.results) {
      console.log(`#${i} ${r.engineName} · ${p.probeId}: ${p.status} — ${p.detail}`);
    }
  }
}
await browser.close();
