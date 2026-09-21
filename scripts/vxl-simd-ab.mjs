// SIMD/编译器开关 A/B：同进程交错跑两个 wasm，比 p50 并校验**末态逐位一致**。
// 用法：node scripts/vxl-simd-ab.mjs <a.wasm> <b.wasm>
import { readFileSync } from 'node:fs';

const [pa, pb] = process.argv.slice(2);
const mk = (p) => new WebAssembly.Instance(new WebAssembly.Module(readFileSync(p)), {}).exports;

function tri(n) { let l = 1; while ((l * (l + 1)) / 2 < n) l++; return Math.max(2, Math.min(l, 40)); }
function lv(n, L) { const t = (L * (L + 1)) / 2; return Array.from({ length: L }, (_, i) => Math.max(1, Math.round((n * (L - i)) / t))); }

function scene(ex, kind) {
  if (kind === 'pyramid') {
    ex.vxl_world_create(0, -9.81, 0, 0, 240);
    const g = ex.vxl_add_box(60, 1, 60, 0, -1, 0, 1000, 1); ex.vxl_body_material(g, 0.7, 0.05);
    const n = 210, half = 0.5, pitch = half * 2 * 1.01, c = lv(n, tri(n));
    c.forEach((cnt, k) => { const y = half + k * pitch; for (let i = 0; i < cnt; i++) {
      const b = ex.vxl_add_box(half, half, half, (i - (cnt - 1) / 2) * pitch, y, 0, 1000, 0);
      ex.vxl_body_material(b, 0.6, 0.02); } });
  } else {
    ex.vxl_world_create(0, -9.81, 0, 0, 460);
    const g = ex.vxl_add_box(80, 1, 80, 0, -1, 0, 1000, 1); ex.vxl_body_material(g, 0.7, 0.05);
    const n = 400, R = Math.max(4, Math.cbrt(n) * 1.4), side = Math.ceil(Math.cbrt(n));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const w = ex.vxl_add_box(R * 0.75, 1.5, 0.4, Math.cos(a) * R, 1.5, Math.sin(a) * R, 0, 1);
      ex.vxl_set_rotation(w, 0, Math.sin((a + Math.PI / 2) / 2), 0, Math.cos((a + Math.PI / 2) / 2));
      ex.vxl_body_material(w, 0.5, 0.05);
    }
    for (let i = 0; i < n; i++) {
      const ix = i % side, iy = Math.floor(i / side) % side, iz = Math.floor(i / (side * side));
      const b = ex.vxl_add_sphere(0.32, (ix - (side - 1) / 2) * 0.7, 0.4 + iy * 0.72, (iz - (side - 1) / 2) * 0.7, 800, 0);
      ex.vxl_body_material(b, 0.45, 0.1);
    }
  }
  return ex.vxl_body_count();
}

function run(ex, kind) {
  const n = scene(ex, kind);
  for (let i = 0; i < 30; i++) ex.vxl_step(1 / 60);
  const s = [];
  for (let i = 0; i < 180; i++) { const t0 = performance.now(); ex.vxl_step(1 / 60); s.push(performance.now() - t0); }
  const poses = new Float32Array(ex.memory.buffer, ex.vxl_read_poses(), n * 7);
  // 逐位指纹：量化前先取原始比特和（判"语义一致"用 toBits 和）
  let bits = 0n;
  for (let i = 0; i < n * 7; i++) {
    const dv = new DataView(ex.memory.buffer, ex.vxl_read_poses() + i * 4, 4);
    bits = (bits * 31n + BigInt(dv.getUint32(0, true))) % 0xffffffffffffffffn;
  }
  s.sort((a, b) => a - b);
  return { p50: s[90], p95: s[Math.floor(s.length * 0.95)], bits: bits.toString(16), maxY: (() => { let m = -Infinity; for (let i = 0; i < n; i++) m = Math.max(m, poses[i * 7 + 1]); return m; })() };
}

const A = mk(pa), B = mk(pb);
for (const kind of ['pyramid', 'ballpit']) {
  const ra = [], rb = [];
  for (let r = 0; r < 3; r++) { ra.push(run(A, kind)); rb.push(run(B, kind)); }
  const f = (v, k) => v.map((x) => x[k].toFixed(3)).join(' / ');
  console.log(`[${kind}] A: p50 ${f(ra, 'p50')}  位指纹 ${ra[0].bits}  堆顶 ${ra[0].maxY.toFixed(3)}`);
  console.log(`[${kind}] B: p50 ${f(rb, 'p50')}  位指纹 ${rb[0].bits}  堆顶 ${rb[0].maxY.toFixed(3)}`);
  console.log(`[${kind}] 末态逐位一致: ${ra[0].bits === rb[0].bits ? '✅ 是' : '❌ 否'}`);
}
