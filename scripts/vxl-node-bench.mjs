// 离线 wasm 基准：在 Node 里直接跑 BSHSQ-Solver 桥（不经浏览器、不进 arena 前端）。
// 场景与 BSHSQ 完全同参（金字塔 210 / 砖墙 200 / 球坑 400）。
// 用法：node scripts/vxl-node-bench.mjs [wasm 路径]
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2] ?? resolve(ROOT, 'public/vendor/vxl/vxl_phys_wasm.wasm');

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
if (ex.vxl_abi() !== 1) throw new Error('ABI 版本不匹配');
console.log(`桥 ABI=${ex.vxl_abi()}，wasm ${(readFileSync(wasmPath).length / 1024).toFixed(0)} KB`);

const VIEW = () => ex.memory.buffer;
const poses = (n) => new Float32Array(VIEW(), ex.vxl_read_poses(), n * 7);

function triangles(n) {
  let l = 1;
  while ((l * (l + 1)) / 2 < n) l++;
  return Math.max(2, Math.min(l, 40));
}
function levelsOf(n, levels) {
  const total = (levels * (levels + 1)) / 2;
  return Array.from({ length: levels }, (_, i) => Math.max(1, Math.round((n * (levels - i)) / total)));
}

function ground(size) {
  const g = ex.vxl_add_box(size / 2, 1, size / 2, 0, -1, 0, 1000, 1);
  ex.vxl_body_material(g, 0.7, 0.05);
}

function scenePyramid() {
  ex.vxl_world_create(0, -9.81, 0, 0, 240);
  ground(120);
  const n = 210, half = 0.5, pitch = half * 2 * 1.01;
  const counts = levelsOf(n, triangles(n));
  counts.forEach((count, k) => {
    const y = half + k * pitch;
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * pitch;
      const b = ex.vxl_add_box(half, half, half, x, y, 0, 1000, 0);
      ex.vxl_body_material(b, 0.6, 0.02);
    }
  });
  return n + 1;
}

function sceneWall() {
  ex.vxl_world_create(0, -9.81, 0, 0, 240);
  ground(120);
  const [hw, hh, hd] = [0.6, 0.28, 0.3];
  const perRow = 16, rows = Math.ceil(200 / perRow);
  let made = 0;
  outer: for (let row = 0; row < rows; row++) {
    const offset = row % 2 === 0 ? 0 : hw;
    for (let i = 0; i < perRow; i++) {
      if (made >= 200) break outer;
      const x = (i - (perRow - 1) / 2) * (hw * 2 + 0.02) + offset;
      const y = hh + row * (hh * 2 + 0.01);
      const b = ex.vxl_add_box(hw, hh, hd, x, y, 0, 1000, 0);
      ex.vxl_body_material(b, 0.7, 0.01);
      made++;
    }
  }
  return made + 1;
}

function sceneBallpit() {
  ex.vxl_world_create(0, -9.81, 0, 0, 460);
  const n = 400;
  const R = Math.max(4, Math.cbrt(n) * 1.4);
  ground(160);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const w = ex.vxl_add_box(R * 0.75, 1.5, 0.4, Math.cos(a) * R, 1.5, Math.sin(a) * R, 0, 1);
    ex.vxl_set_rotation(w, 0, Math.sin((a + Math.PI / 2) / 2), 0, Math.cos((a + Math.PI / 2) / 2));
    ex.vxl_body_material(w, 0.5, 0.05);
  }
  const side = Math.ceil(Math.cbrt(n));
  for (let i = 0; i < n; i++) {
    const ix = i % side, iy = Math.floor(i / side) % side, iz = Math.floor(i / (side * side));
    const b = ex.vxl_add_sphere(
      0.32,
      (ix - (side - 1) / 2) * 0.7,
      0.4 + iy * 0.72,
      (iz - (side - 1) / 2) * 0.7,
      800,
      0,
    );
    ex.vxl_body_material(b, 0.45, 0.1);
  }
  return n + 5;
}

function bench(name, build, extra = 0) {
  const expected = build();
  const n = ex.vxl_body_count();
  if (n !== expected) console.log(`  ⚠ ${name}: 桥内体数 ${n} ≠ 预期 ${expected}`);
  for (let i = 0; i < 30; i++) step();
  const samples = [];
  for (let i = 0; i < 180; i++) {
    const t0 = performance.now();
    step();
    samples.push(performance.now() - t0);
  }
  for (let i = 0; i < extra; i++) step();
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  // 末态质量：最高点 / 清醒数
  const p = poses(n);
  let maxY = -Infinity, awake = 0;
  for (let i = 0; i < n; i++) {
    maxY = Math.max(maxY, p[i * 7 + 1]);
    if (ex.vxl_is_dynamic(i) && ex.vxl_sleeping(i) === 0) awake++;
  }
  console.log(
    `${name}: ${n} 体  p50 ${p50.toFixed(3)} ms  p95 ${p95.toFixed(3)}  等效 ${(1000 / p50).toFixed(0)} FPS  堆顶 y=${maxY.toFixed(3)}  清醒 ${awake}`,
  );
}

function step() {
  const rc = ex.vxl_step(1 / 60);
  if (rc !== 0) throw new Error('vxl_step 固定步不匹配');
}

function sceneTrimesh() {
  ex.vxl_world_create(0, -9.81, 0, 0, 240);
  // 90 m × 24 段高度场（与 BSHSQ 同参）
  const size = 90, seg = 24, step = size / seg;
  const h = (x, z) => Math.sin(x * 0.13) * 1.6 + Math.cos(z * 0.11) * 1.4 + Math.sin((x + z) * 0.05) * 1.1;
  ex.vxl_mesh_begin();
  for (let iz = 0; iz <= seg; iz++) {
    for (let ix = 0; ix <= seg; ix++) {
      const x = -size / 2 + ix * step;
      const z = -size / 2 + iz * step;
      ex.vxl_mesh_push_vertex(x, h(x, z), z);
    }
  }
  const row = seg + 1;
  for (let iz = 0; iz < seg; iz++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iz * row + ix, b = a + 1, c = a + row, d = c + 1;
      ex.vxl_mesh_push_tri(a, c, b);
      ex.vxl_mesh_push_tri(b, c, d);
    }
  }
  const rc = ex.vxl_mesh_commit();
  if (rc !== 0) throw new Error('mesh_commit failed');
  // 200 体（球/盒/圆柱→凸包 34 顶点；与 arena 的降级链一致）
  let seed = 131;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) / 16777216; };
  for (let i = 0; i < 200; i++) {
    const x = (rnd() - 0.5) * 30, z = (rnd() - 0.5) * 30;
    const y = 14 + (i % 12) * 1.2 + rnd() * 0.5;
    if (i % 3 === 0) {
      const b = ex.vxl_add_sphere(0.36, x, y, z, 1000, 0);
      ex.vxl_body_material(b, 0.6, 0.05);
    } else if (i % 3 === 1) {
      const b = ex.vxl_add_box(0.32, 0.32, 0.32, x, y, z, 1000, 0);
      ex.vxl_body_material(b, 0.6, 0.05);
    } else {
      ex.vxl_hull_begin();
      for (const ring of [-1, 1]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          ex.vxl_hull_push(Math.cos(a) * 0.3, ring * 0.34, Math.sin(a) * 0.3);
        }
      }
      ex.vxl_hull_push(0, -0.34, 0);
      ex.vxl_hull_push(0, 0.34, 0);
      const b = ex.vxl_hull_commit(x, y, z, 1000);
      ex.vxl_body_material(b, 0.6, 0.05);
    }
  }
  return ex.vxl_body_count();
}

bench('金字塔堆叠', scenePyramid);
bench('砖墙', sceneWall);
bench('球坑', sceneBallpit);
bench('三角网地形', sceneTrimesh);
