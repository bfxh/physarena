// 自检矩阵 ratchet 护栏的契约自测（秒级，无浏览器）。证明护栏对「新增 fail」敏感、
// 对「修复 / 已知边界 fail」不误报——否则护栏等于没装。
import assert from 'node:assert';
import { computeFails, ratchet } from './selftest-ratchet.mjs';

// 合成一行自检结果：bootOk + 一组失败探针（其余探针默认为 pass）。
function row(id, bootOk, fails) {
  const probeIds = ['shape-sphere', 'shape-box', 'shape-capsule', 'shape-cone', 'joint-spherical'];
  const failSet = new Set(fails);
  return {
    engineId: id, bootOk,
    results: probeIds.map((p) => ({ probeId: p, status: failSet.has(p) ? 'fail' : 'pass' })),
  };
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

// 1. computeFails 必须排除未启动引擎的连带 fail（否则一个 boot 故障污染整张表）。
t('排除未启动引擎的 fail', () => {
  const rows = [row('e1', true, ['shape-sphere']), row('e2', false, ['shape-box'])];
  const f = computeFails(rows);
  assert.ok(f.has('e1:shape-sphere'), '已启动引擎的 fail 计入');
  assert.ok(!f.has('e2:shape-box'), '未启动引擎的 fail 排除');
});

// 2. capture 模式（baseline=null）→ 放行且标记 rebaselined。
t('capture 模式放行', () => {
  const r = ratchet([row('e1', true, ['shape-sphere'])], null, {});
  assert.ok(r.ok && r.rebaselined, 'capture 应放行');
  assert.deepStrictEqual(r.fails, ['e1:shape-sphere']);
});

// 3. 与基线完全一致 → 放行，无新增。
t('基线一致放行', () => {
  const r = ratchet([row('e1', true, ['shape-sphere'])], ['e1:shape-sphere'], {});
  assert.ok(r.ok && !r.rebaselined, '应放行且不 rebaseline');
  assert.strictEqual(r.newFails.length, 0);
});

// 4. 新增 fail → 阻断，并精确报出是哪个 engine:probe。
t('新增 fail 阻断并报 key', () => {
  const r = ratchet([row('e1', true, ['shape-sphere', 'shape-box'])], ['e1:shape-sphere'], {});
  assert.ok(!r.ok, '新增 fail 应阻断');
  assert.deepStrictEqual(r.newFails, ['e1:shape-box']);
});

// 5. fail 减少（修复）→ 放行（ratchet 只拦收紧方向）。
t('修复后放行', () => {
  const r = ratchet([row('e1', true, [])], ['e1:shape-sphere'], {});
  assert.ok(r.ok, 'fail 减少应放行');
  assert.strictEqual(r.newFails.length, 0);
});

// 6. 基线里的 fail 在另一引擎复现，不算新增（已知边界 fail 跨引擎独立记录）。
t('不同引擎的同名 fail 视为各自已知', () => {
  const rows = [row('e1', true, ['shape-sphere']), row('e2', true, ['shape-sphere'])];
  // 基线只覆盖 e1 的 shape-sphere；e2 的 shape-sphere 是新增 → 必须拦。
  const r = ratchet(rows, ['e1:shape-sphere'], {});
  assert.ok(!r.ok, '未基线的引擎 fail 应拦');
  assert.deepStrictEqual(r.newFails, ['e2:shape-sphere']);
});

// 7. --rebaseline 覆盖基线并放行。
t('rebaseline 覆盖', () => {
  const r = ratchet([row('e1', true, ['shape-sphere', 'shape-box'])], ['e1:shape-sphere'], { rebaseline: true });
  assert.ok(r.ok && r.rebaselined, 'rebaseline 应放行');
  assert.deepStrictEqual(r.fails.sort(), ['e1:shape-box', 'e1:shape-sphere']);
});

console.log(`\nselftest-ratchet.test: ${n} 项断言全部通过`);
