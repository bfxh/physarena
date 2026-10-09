// 行为级一致性检查：实例化一份 BSHSQ wasm，跑一段固定场景，返回位姿/速度的
// 二进 checksum。两份同源但不同构建路径的 wasm 必须给出完全相同的 checksum
// （物理确定，与构建主机/路径无关）—— 这是门的核心不变量。
//
// 比逐字节比对更稳：rustc 会把「源路径散列（crate disambiguator）」渗进 wasm 的
// 类型/函数索引布局，导致同一份源码在不同机器上字节不等；但「物理行为」一致。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DT = 1 / 60;

// 固定场景：1 静态地面 + 3 层动态盒塔 + 1 动态球，落到地面静置 180 tick。
// 体序固定（= 加入序），读回按体索引排列，与迭代顺序无关。
// cfg 可覆盖重力/步数/球初始 X，仅用于敏感性自测；默认形参与已钉死的
// behavior_sha256（76926111…）完全一致，请勿改动默认值。
function runScenario(exports, memory, cfg = {}) {
  const gY = cfg.gravityY ?? -9.81;
  const steps = cfg.steps ?? 180;
  const sphereX = cfg.sphereX ?? 0.8;
  const r = (code) => {
    if (code !== 0) throw new Error('wasm op returned ' + code);
  };
  r(exports.vxl_world_create(0.0, gY, 0.0, 0.0, 16));
  exports.vxl_add_box(5.0, 1.0, 5.0, 0.0, -1.0, 0.0, 1000.0, 1); // ground
  exports.vxl_add_box(0.5, 0.5, 0.5, -0.1, 1.0, 0.0, 1.0, 0); // tower 0
  exports.vxl_add_box(0.5, 0.5, 0.5, 0.0, 2.0, 0.0, 1.0, 0); // tower 1
  exports.vxl_add_box(0.5, 0.5, 0.5, 0.1, 3.0, 0.0, 1.0, 0); // tower 2
  exports.vxl_add_sphere(0.5, sphereX, 6.0, 0.0, 1.0, 0.0, 0); // rolling sphere
  const n = exports.vxl_body_count();
  if (n !== 5) throw new Error('unexpected body count ' + n);
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
  return runScenario(exports, instance.exports.memory, cfg);
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
