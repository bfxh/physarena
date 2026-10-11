// 自检矩阵回归护栏（ratchet gate）。
//
// 21 探针 × 9 引擎 = 189 条判定。其中部分 fail 是**引擎能力边界**（PhysX 无凸包、
// 某些引擎不支持某类约束），属「实验室输出」而非构建不变量——所以 ui-gate 只断言机制
// 健全、不卡通过率（见 scripts/ui-gate.mjs 自检段注释）。但这让「某引擎突然多挂了 N 个
// 探针」能静默上线。
//
// 本护栏用 **ratchet** 堵这个口：把「当前 fail 集合」对到一份**钉死的基线**
// （scripts/selftest-baseline.json，记录每个 `engineId:probeId` 的预期 fail）。只有
// **新增**的 fail（基线里没有的）才阻断——已知的能力边界 fail 进基线后不报红；新回归必须
// 显式 `--rebaseline` 才能放行。这与 RUST-WL 的 CI ratchet 哲学一致（主分支只许收紧、不许
// 静默放宽）。
//
// 引导（bootstrap）：基线文件不存在时进入 **capture 模式**——把当前 fail 集合写成基线并放行
// （不报红），避免首次引入护栏就盲红。capture 同时写 out/selftest-baseline.json 供 CI 产物
// 带回；人工把该文件落到 scripts/ 即激活 ratchet。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = resolve(ROOT, 'scripts/selftest-baseline.json');
export const ARTIFACT_PATH = resolve(ROOT, 'out/selftest-baseline.json');

/**
 * 从自检结果里抽出「已启动引擎的真实 fail」。
 * 引擎没启动（bootOk=false）时它的每个探针都被标成 fail（见 src/core/selftest.ts
 * runSelfTest 的「引擎启动失败」分支），那是 boot 故障的连带产物，已由 ui-gate 的 boot
 * 断言单独拦，绝不计入回归基线——否则一个启动故障会污染整张 fail 表、把所有探针都判成「新增」。
 */
export function computeFails(rows) {
  const fails = new Set();
  for (const r of rows) {
    if (!r.bootOk) continue;
    for (const p of r.results || []) {
      if (p.status === 'fail') fails.add(`${r.engineId}:${p.probeId}`);
    }
  }
  return fails;
}

/**
 * 纯函数：比对当前 fail 集合与基线。
 * @returns {{ ok: boolean, rebaselined: boolean, fails: string[], newFails: string[], baseline: string[] }}
 */
export function ratchet(rows, baseline, opts = {}) {
  const current = computeFails(rows);
  const base = new Set(baseline || []);
  if (opts.rebaseline || !baseline) {
    return { ok: true, rebaselined: true, fails: [...current], newFails: [], baseline: [...base] };
  }
  const newFails = [...current].filter((k) => !base.has(k));
  return { ok: newFails.length === 0, rebaselined: false, fails: [...current], newFails, baseline: [...base] };
}

function loadBaseline(path) {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(j.fails) ? j.fails : null;
  } catch {
    return null;
  }
}

/** CI 入口：读基线、比对、capture 模式写基线。返回结果对象供调用方据 ok 决定门结果。 */
export function runRatchet(rows, { rebaseline = false } = {}) {
  const baseline = loadBaseline(BASELINE_PATH);
  const res = ratchet(rows, baseline, { rebaseline });
  if (res.rebaselined) {
    const payload = JSON.stringify({ fails: res.fails, capturedAt: new Date().toISOString() }, null, 2);
    writeFileSync(BASELINE_PATH, payload);
    try {
      mkdirSync('out', { recursive: true });
      writeFileSync(ARTIFACT_PATH, payload);
    } catch { /* 产物是便利物，绝不因此失败 */ }
  }
  return res;
}

// CLI：node scripts/selftest-ratchet.mjs <results.json> [--rebaseline]
// results.json = getSelfTestResults() 的数组（engineId / bootOk / results[].{probeId,status}）。
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/selftest-ratchet.mjs')) {
  const file = process.argv[2];
  const rebaseline = process.argv.includes('--rebaseline');
  if (!file) {
    console.error('usage: node scripts/selftest-ratchet.mjs <results.json> [--rebaseline]');
    process.exit(2);
  }
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  const res = runRatchet(rows, { rebaseline });
  if (res.rebaselined) {
    console.log(`[selftest-ratchet] CAPTURE 模式：写入基线 ${res.fails.length} 个 fail（scripts/ + out/）：`);
    console.log('        ' + res.fails.join('\n        '));
  } else if (res.ok) {
    console.log(`[selftest-ratchet] OK：${res.fails.length} 个 fail，全部在基线内`);
  } else {
    console.error(`[selftest-ratchet] FAIL：${res.newFails.length} 个新增 fail（基线外）：`);
    for (const k of res.newFails) console.error(`    ${k}`);
  }
  process.exit(res.ok ? 0 : 1);
}
