// 构建 vxl-phys（RUST WL）的 wasm 桥并把产物放进 public/vendor/vxl/。
//
// 依赖：Rust 工具链 + wasm32-unknown-unknown 目标（rustup target add wasm32-unknown-unknown）。
// 桥 crate 在 ./wasm-bridge/，path 依赖 ../RUST WL/crates（引擎仓）。引擎 crates
// 保持 `#![forbid(unsafe_code)]`；桥本身零 unsafe 块（本脚本附带一次源码检查）。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'wasm-bridge');
const ENGINE = process.env.VXL_ENGINE_DIR ?? resolve(ROOT, '..', 'RUST WL');
const OUT_DIR = join(ROOT, 'public', 'vendor', 'vxl');
const WASM = join(BRIDGE, 'target', 'wasm32-unknown-unknown', 'release', 'vxl_phys_wasm.wasm');

// 零 unsafe 块自检（注释里的字样不算：按行去掉注释后匹配）。
const src = readFileSync(join(BRIDGE, 'src', 'lib.rs'), 'utf8');
const code = src
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
for (const needle of ['unsafe {', 'unsafe fn', 'unsafe impl', 'unsafe trait']) {
  if (code.includes(needle)) {
    throw new Error(`wasm-bridge 出现 ${needle}：本桥约定零 unsafe 代码（只允许 #[unsafe(no_mangle)] 属性）`);
  }
}

console.log(`[vxl-wasm] 构建桥：${BRIDGE}（引擎：${ENGINE}）`);
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
  cwd: BRIDGE,
  stdio: 'inherit',
});

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(WASM, join(OUT_DIR, 'vxl_phys_wasm.wasm'));
console.log(`[vxl-wasm] 产物 → public/vendor/vxl/vxl_phys_wasm.wasm`);
