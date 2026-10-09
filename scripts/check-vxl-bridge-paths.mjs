// 守卫：wasm-bridge/Cargo.toml 的引擎 path 依赖必须是可移植的
// `../../BSHSQ/crates/<name>`，绝不能是绝对盘符路径（如 `Z:/BSHSQ`、
// `D:/KF/BSHSQ`）或 UNIX 绝对路径（`/home/.../BSHSQ`）。
//
// 为什么是硬门：CI 在 physarena 仓里靠 `../../BSHSQ` + 符号链接把引擎源码
// 接到 wasm-bridge 旁边；一旦某个 path 被改成本地绝对路径，本地能编过、CI 却
// 找不到引擎 crate 而静默断裂（2026-10-09 本地就发生过 `Z:/BSHSQ` 误改，
// 差点被推上去）。此脚本在 CI 里最先跑，绝对路径一律红。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARGO = resolve(ROOT, 'wasm-bridge/Cargo.toml');
const text = readFileSync(CARGO, 'utf8');

const re = /^([\w-]+)\s*=\s*\{\s*[^}]*path\s*=\s*"([^"]+)"\s*\}/gm;
const errors = [];
let m;
while ((m = re.exec(text)) !== null) {
  const name = m[1];
  const p = m[2];
  if (!name.startsWith('vxl-')) continue; // 只守引擎门面 crate
  const expect = `../../BSHSQ/crates/${name}`;
  if (p !== expect) {
    errors.push(
      `依赖 ${name} 的 path 必须是相对路径 "${expect}"，但当前是 "${p}"` +
        '（绝对路径会让 CI 靠符号链接解析不到引擎 crate，静默断裂）',
    );
  }
}

if (errors.length > 0) {
  console.error('[vxl-bridge-paths] FAIL:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('[vxl-bridge-paths] OK：所有 vxl-* 引擎依赖均为可移植的 ../../BSHSQ/crates/<name>');
