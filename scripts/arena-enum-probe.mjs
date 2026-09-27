// 读取 physx-js-webidl 运行时枚举值（排查 CCD 标志位是否正确）。
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__physarena, null, { timeout: 60000 });
// Boot the physx engine so its lazy chunk is fetched, then read the enums back.
await page.evaluate(() => window.__physarena.selectEngine('physx5'));
await page.waitForTimeout(4000);
const out = await page.evaluate(async () => {
  // Find the physx chunk the app uses.
  const entry = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('physx-js-webidl'));
  const init = async () => {
    const mod = await import(entry);
    const f = mod.default ?? mod;
    return await f({ locateFile: () => '/vendor/physx/physx-js-webidl.wasm' });
  };
  const P = await init();
  return {
    chunk: entry,
    sceneType: typeof P.PxSceneFlagEnum,
    sceneKeys: Object.getOwnPropertyNames(P.PxSceneFlagEnum ?? {}),
    sceneProto: Object.getOwnPropertyNames(Object.getPrototypeOf(P.PxSceneFlagEnum ?? {})),
    bodyType: typeof P.PxRigidBodyFlagEnum,
    bodyKeys: Object.getOwnPropertyNames(P.PxRigidBodyFlagEnum ?? {}),
    ccdBody: P.PxRigidBodyFlagEnum?.eENABLE_CCD,
    ccdScene: P.PxSceneFlagEnum?.eENABLE_CCD,
    activeScene: P.PxSceneFlagEnum?.eENABLE_ACTIVE_ACTORS,
    trigger: P.PxShapeFlagEnum?.eTRIGGER_SHAPE,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
