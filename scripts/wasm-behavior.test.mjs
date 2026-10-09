// 行为门敏感性自测（CI 跑，无 cargo 构建，秒级）。
//
// 一个只在「绿」时通过的门等于没门。本测试证明三层事实：
//  1) 确定性：同一 wasm 跑默认场景两次，checksum 逐位一致。
//  2) 对账：默认场景 checksum 必须 == 溯源文件记录的 behavior_sha256
//     （即复刻了 vxl-wasm-integrity.mjs 的核心断言，防止 sidecar 与门漂移）。
//  3) 敏感性：物理参数一变，checksum 必变——否则门检测不到真脱节。
//     改重力 / 步数 / 球初始 X，逐个确认 checksum 与默认不同，且彼此互异
//     （排除「无论怎么改都是同一个常量」的伪敏感）。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumWasm, checksumWasmWith } from './wasm-behavior.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = resolve(ROOT, 'public/vendor/vxl/vxl_phys_wasm.wasm');
const SIDECAR = resolve(ROOT, 'public/vendor/vxl/vxl_wasm.build.json');

function assert(cond, msg) {
  if (!cond) {
    console.error('[wasm-behavior.test] FAIL:', msg);
    process.exit(1);
  }
  console.log('[wasm-behavior.test] ok:', msg);
}

// 1) 确定性
const a = await checksumWasm(WASM);
const a2 = await checksumWasm(WASM);
assert(a === a2, `默认场景两次校验一致 (${a})`);

// 2) 与 sidecar 对账
const { behavior_sha256 } = JSON.parse(readFileSync(SIDECAR, 'utf8'));
assert(
  behavior_sha256 === a,
  `默认场景 checksum == sidecar.behavior_sha256 (${a})`,
);

// 3) 敏感性
const cG = await checksumWasmWith(WASM, { gravityY: -4.0 });
const cS = await checksumWasmWith(WASM, { steps: 90 });
const cX = await checksumWasmWith(WASM, { sphereX: 3.0 });
assert(cG !== a, `重力 -9.81 vs -4.0 的 checksum 不同（门对物理敏感）[${a} vs ${cG}]`);
assert(cS !== a, `180 tick vs 90 tick 的 checksum 不同 [${a} vs ${cS}]`);
assert(cX !== a, `球初始 X 0.8 vs 3.0 的 checksum 不同 [${a} vs ${cX}]`);
assert(cG !== cS && cG !== cX && cS !== cX, '三种扰动两两互异（非巧合常量）');

console.log('[wasm-behavior.test] ALL PASS');
