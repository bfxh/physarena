// 行为级一致性检查：实例化一份 BSHSQ wasm，跑多段固定场景（覆盖多种物理体制），
// 返回位姿/速度组合的二进 checksum。两份同源但不同构建路径的 wasm 必须给出
// 完全相同的组合 checksum（物理确定，与构建主机/路径无关）—— 这是门的核心不变量。
//
// 比逐字节比对更稳：rustc 会把「源路径散列（crate disambiguator）」渗进 wasm 的
// 类型/函数索引布局，导致同一份源码在不同机器上字节不等；但「物理行为」一致。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DT = 1 / 60;

// 多场景固定场景集合：覆盖不同物理体制，避免「单一场景」漏掉其它体制下的脱节。
// 每个场景都用同一套确定性 API（vxl_world_create/add_box/add_sphere/step/read_*），
// 物理确定 => 各场景 checksum 跨主机逐位一致；组合哈希再 sha256 一遍得单一
// behavior_sha256。任一场景的物理因 BSHSQ 改动而变 => 组合哈希必变 => 门拦下。
// 场景 A 刻意等于历史单场景（1 地面 + 3 盒塔 + 1 球，180 tick，重力 -9.81）以便回溯；
// B/C 引入更高塔、更强重力 / 质量比等额外体制，拓宽门的敏感面。
const SCENARIOS = [
  // A: 历史基线（3 盒塔 + 1 落球）—— 门最初只覆盖这一体制。
  { gravityY: -9.81, steps: 180, sphereX: 0.8, boxes: 3, sphereY: 6.0 },
  // B: 更高塔（5 盒）+ 更高落球 —— 测堆叠失稳 / 高冲击碰撞体制。
  { gravityY: -9.81, steps: 240, sphereX: -1.2, boxes: 5, sphereY: 9.0 },
  // C: 强重力（-20）+ 偏移落球 —— 测强重力 / 质量比体制下的行为。
  { gravityY: -20.0, steps: 200, sphereX: 1.5, boxes: 4, sphereY: 4.0 },
];

// 单个固定场景：1 静态地面 + boxes 层动态盒塔 + 1 动态球，静置 steps tick。
// cfg 覆盖重力/步数/球位/盒数/球初始高度，仅用于敏感性自测；默认形参与
// SCENARIOS[0] 完全一致（盒塔 x 偏移 (i-(boxes-1)/2)*0.1 在 boxes=3 时正是 -0.1/0/0.1）。
function runScenario(exports, memory, cfg = {}) {
  const gY = cfg.gravityY ?? -9.81;
  const steps = cfg.steps ?? 180;
  const sphereX = cfg.sphereX ?? 0.8;
  const boxes = cfg.boxes ?? 3;
  const sphereY = cfg.sphereY ?? 6.0;
  const r = (code) => {
    if (code !== 0) throw new Error('wasm op returned ' + code);
  };
  r(exports.vxl_world_create(0.0, gY, 0.0, 0.0, 16));
  exports.vxl_add_box(5.0, 1.0, 5.0, 0.0, -1.0, 0.0, 1000.0, 1); // ground
  for (let i = 0; i < boxes; i++) {
    exports.vxl_add_box(0.5, 0.5, 0.5, (i - (boxes - 1) / 2) * 0.1, 1.0 + i * 1.0, 0.0, 1.0, 0); // tower
  }
  exports.vxl_add_sphere(0.5, sphereX, sphereY, 0.0, 1.0, 0.0, 0); // rolling sphere
  const n = exports.vxl_body_count();
  if (n !== boxes + 2) throw new Error('unexpected body count ' + n);
  for (let i = 0; i < steps; i++) r(exports.vxl_step(DT));

  const pPtr = exports.vxl_read_poses();
  const vPtr = exports.vxl_read_velocities();
  const poses = new Float32Array(memory.buffer, pPtr, n * 7);
  const vels = new Float32Array(memory.buffer, vPtr, n * 6);
  const h = createHash('sha256');
  h.update(Buffer.from(poses.buffer, poses.byteOffset, poses.byteLength));
  h.update(Buffer.from(vels.buffer, vels.byteOffset, vels.byteLength));
  exports.vxl_world_drop();
  return h.digest('hex');
}

export async function checksumWasmWith(wasmPath, cfg = {}) {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { exports } = instance;
  if (exports.vxl_abi() !== 1) throw new Error('vxl_abi != 1');
  const memory = instance.exports.memory;
  // cfg 应用到全部场景（敏感性自测据此扰动）；逐场景哈希后组合再 sha256，得单一指纹。
  const perScene = SCENARIOS.map((s) => runScenario(exports, memory, { ...s, ...cfg }));
  const combiner = createHash('sha256');
  for (const h of perScene) combiner.update(h);
  return combiner.digest('hex');
}

export async function checksumWasm(wasmPath) {
  return checksumWasmWith(wasmPath, {});
}

// 导出符号集合（ABI 面）。两份同源 wasm 必须完全一致；多/少导出函数即脱节。
export async function listExports(wasmPath) {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return Object.keys(instance.exports).filter((k) => k !== 'memory').sort();
}

// CLI: node scripts/wasm-behavior.mjs <wasmA> <wasmB>
if (process.argv[1] && process.argv[1].endsWith('wasm-behavior.mjs')) {
  const [a, b] = process.argv.slice(2);
  const ca = await checksumWasm(a);
  console.log('A', a, ca);
  if (b) {
    const cb = await checksumWasm(b);
    console.log('B', b, cb);
    console.log(ca === cb ? 'MATCH ✓' : 'MISMATCH ✗');
    process.exit(ca === cb ? 0 : 1);
  }
}
