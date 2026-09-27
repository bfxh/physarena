// BSHSQ 验收检测（渲染轴 + 物理冒烟）。
//
// 用法：
//   npm run preview                     # 另开一个终端
//   node scripts/verify-renderers.mjs              # 全部渲染器
//   node scripts/verify-renderers.mjs --engines    # 附带 3 个引擎的物理冒烟
//   node scripts/verify-renderers.mjs --batch 3    # 更小的批次（页面更容易稳住）
//
// 与 arena-drive.mjs 同一套驱动方式：playwright-core + 本机 msedge，不下载浏览器。
//
// 判据是「画布上到底有没有画面」，不是「有没有报错」。这个项目出现过
// 报告完美（draw call、实例数、isReady() 全对）但一个三角形都没画的后端——
// 所以每个渲染器都要落到像素上验。
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.ARENA_URL ?? 'http://localhost:4173';
const argv = process.argv.slice(2);
const BATCH = Number(readFlag('--batch')) || 4;
const WITH_ENGINES = argv.includes('--engines');
const OUT = 'out/verify-renderers.json';

function readFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * 画布采样。
 *
 * 用 drawImage + getImageData 抽稀采样，`distinct` 是出现的颜色桶数：
 * 1 表示整块是纯色（什么都没画），大于 3 说明有真实几何。
 *
 * 注意：`preserveDrawingBuffer: false` 时 drawImage 读 WebGL canvas 本身不可靠
 * （缓冲可能在合成后失效），所以「读到纯色」不等于「一定没画」——配合
 * `cur`（是否真的切过去了）和该后端的 stats 一起看。
 */
async function sampleAll(page, ids) {
  return page.evaluate(async (list) => {
    const sample = () => {
      const el = document.querySelector('.pa-canvas');
      if (!el) return { error: 'no .pa-canvas' };
      const tag = el.tagName;
      if (tag !== 'CANVAS') {
        const nodes = el.querySelectorAll('*').length;
        return { tag, nodes, distinct: nodes > 2 ? 4 : 1, scene: nodes };
      }
      const t = document.createElement('canvas');
      t.width = el.width;
      t.height = el.height;
      const g = t.getContext('2d');
      g.drawImage(el, 0, 0);
      const d = g.getImageData(0, 0, t.width, t.height).data;
      const uniq = new Set();
      let scene = 0;
      for (let i = 0; i < d.length; i += 64) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        uniq.add(`${r >> 4}.${gg >> 4}.${b >> 4}`);
        if (!(Math.abs(r - 238) < 8 && Math.abs(gg - 241) < 8 && Math.abs(b - 246) < 8)) scene++;
      }
      return { tag, distinct: uniq.size, scene, size: `${el.width}x${el.height}` };
    };

    const out = [];
    for (const id of list) {
      try {
        await window.__bshsq.selectRenderer(id);
        await new Promise((r) => setTimeout(r, id === 'babylon' ? 6000 : 2600));
        const rec = { id, cur: window.__bshsq.currentRenderer(), sample: sample() };
        const m = window.__bshsq.metrics();
        for (const row of m) {
          if (row.key === 'r-triangles') rec.triangles = row.value;
          if (row.key === 'r-instances') rec.instances = row.value;
          if (row.key === 'step-p50') rec.stepP50 = row.value;
        }
        rec.guards = window.__bshsq.guardLog().length;
        out.push(rec);
      } catch (e) {
        out.push({ id, error: String((e && e.message) || e).slice(0, 90) });
      }
    }
    return out;
  }, ids, { timeout: 180000 });
}

function main() {
  mkdirSync('out', { recursive: true });
  return run();
}

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });

  const consoleErrors = [];
  const http404 = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() === 404) http404.push(r.url());
  });

  console.log(`[verify] ${BASE}`);
  // preserveBuffer=1 让每个后端创建绘制缓冲时保留内容。
  // 不开这个开关时，页面内 drawImage 读 WebGL canvas 会拿到全透明像素
  // （缓冲已在合成后失效），验收会把「画得好好的」误判成「什么都没画」——
  // 这个问题真发生过，整批 GL 后端被误报 FAIL。
  const startUrl = `${BASE}/?engine=rapier3d&scene=pyramid&bodies=40&renderer=three&preserveBuffer=1`;
  await page.goto(startUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__bshsq, null, { timeout: 60000 });
  // 冷缓存下 Babylon 的 chunk 有 6 MB，首屏给它留时间。
  await page.waitForTimeout(20000);

  const list = await page.evaluate(() =>
    window.__bshsq.listRenderers().map((r) => ({
      id: r.id,
      name: r.name,
      unavailable: r.unavailable || null,
    })),
  );

  const enabled = list.filter((r) => !r.unavailable);
  const disabled = list.filter((r) => r.unavailable);
  console.log(`\n渲染器：${list.length} 个实现，${enabled.length} 个可用，${disabled.length} 个禁用`);
  for (const d of disabled) {
    console.log(`  · ${d.id}（禁用）：${String(d.unavailable).slice(0, 80)}…`);
  }

  const results = [];
  for (let i = 0; i < enabled.length; i += BATCH) {
    const batch = enabled.slice(i, i + BATCH).map((r) => r.id);
    console.log(`\n--- 第 ${Math.floor(i / BATCH) + 1} 批：${batch.join('、')}`);
    let rows;
    try {
      rows = await sampleAll(page, batch);
    } catch (e) {
      console.log(`  !! 本批无响应（页面被拖死？）：${String(e.message).slice(0, 80)}`);
      for (const id of batch) results.push({ id, ok: false, failed: 'no response' });
      continue;
    }
    for (const r of rows) {
      const s = r.sample || {};
      const ok = r.cur === r.id && (s.distinct || 0) > 3;
      results.push({ ...r, ok });
      const line = [
        ok ? 'OK  ' : 'FAIL',
        String(r.id).padEnd(10),
        `cur=${String(r.cur).padEnd(10)}`,
        `颜色=${String(s.distinct ?? '?').padEnd(4)}`,
        `场景像素=${String(s.scene ?? '?').padEnd(7)}`,
        `三角形=${String(r.triangles ?? '?').padEnd(7)}`,
        `p50=${String(r.stepP50 ?? '?')}`,
      ].join(' ');
      console.log(`  ${line}`);
    }
  }

  let engines = null;
  if (WITH_ENGINES) {
    console.log('\n--- 物理冒烟（3 个引擎）');
    engines = await page.evaluate(async () => {
      const ids = ['rapier3d', 'cannon-es', 'oimo'];
      const out = [];
      for (const id of ids) {
        try {
          await window.__bshsq.selectEngine(id);
          await new Promise((r) => setTimeout(r, 3200));
          const m = window.__bshsq.metrics();
          const row = { id, engine: '?', step: '?', bodies: '?' };
          for (const r of m) {
            if (r.key === 'id-engine') row.engine = r.value;
            if (r.key === 'step-p50') row.step = r.value;
            if (r.key === 'bodies-total') row.bodies = r.value;
          }
          row.nonFinite = JSON.stringify(window.__bshsq.simStateSummary()).includes('NaN');
          out.push(row);
        } catch (e) {
          out.push({ id, error: String((e && e.message) || e).slice(0, 80) });
        }
      }
      return out;
    }, { timeout: 120000 });
    for (const r of engines) {
      const bad = r.error || r.nonFinite;
      console.log(`  ${bad ? 'FAIL' : 'OK  '} ${String(r.id).padEnd(11)} → ${String(r.engine ?? '').padEnd(12)} 刚体=${String(r.bodies ?? '').padEnd(5)} p50=${r.step ?? ''}${r.error ? ` ${r.error}` : ''}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 渲染器：${results.length - failed.length}/${results.length} 通过`);
  for (const f of failed) console.log(`  失败：${f.id} ${f.failed || f.error || ''}`);

  // Browsers request /favicon.ico on their own and this project does not ship
  // one, so that 404 is noise rather than a finding. Everything else counts.
  const real404 = http404.filter((u) => !/favicon/i.test(u));
  const realConsole = consoleErrors.filter(
    (t) => !/Failed to load resource/.test(t) || real404.length > 0,
  );
  const pageProblems = [...realConsole, ...real404.map((u) => `404: ${u}`)];
  if (pageProblems.length) {
    console.log(`页面问题 ${pageProblems.length} 条：`);
    for (const p of pageProblems.slice(0, 8)) console.log(`  · ${String(p).slice(0, 120)}`);
  } else {
    console.log('页面问题：无');
  }

  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, list, results, engines, pageProblems }, null, 2));
  console.log(`\n报告已写入 ${OUT}`);

  await browser.close();
  return failed.length || pageProblems.length ? 1 : 0;
}

process.exitCode = await main();
