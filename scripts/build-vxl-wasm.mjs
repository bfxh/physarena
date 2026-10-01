// 构建 BSHSQ-Solver的 wasm 桥并把产物放进 public/vendor/vxl/。
//
// 依赖：Rust 工具链 + wasm32-unknown-unknown 目标（rustup target add wasm32-unknown-unknown）。
// 桥 crate 在 ./wasm-bridge/，path 依赖指向引擎仓的 crates/（具体位置见下方按 Cargo.toml 反推）。
// 引擎门面 crate 名 = vxl-phys（lib 名 vxl_phys），不是品牌名 —— 品牌改名别动依赖键。
// 引擎 crates 保持 `#![forbid(unsafe_code)]`；桥本身零 unsafe 块（本脚本附带一次源码检查）。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'wasm-bridge');
const OUT_DIR = join(ROOT, 'public', 'vendor', 'vxl');
const WASM = join(BRIDGE, 'target', 'wasm32-unknown-unknown', 'release', 'vxl_phys_wasm.wasm');

// 引擎位置从 wasm-bridge/Cargo.toml 的 path 依赖反推——那是本桥与引擎之间唯一的承重耦合。
// 此前这里写的是 `VXL_ENGINE_DIR ?? resolve(ROOT, '..', '')`，但那个常量**只进日志、从不参与
// 构建**：路径指到不存在的目录也照样往下跑，报错落到 cargo 深处。改成按 Cargo.toml 实际解析
// 并逐项校验，接不上就当场停下说清该改哪。（Cargo 的 path 依赖不展开环境变量，所以没有更干净的招。）
// 只取 [dependencies] 段、且跳过注释行——整份 Cargo.toml 拿正则扫会把注释里的示例当成真依赖。
const MANIFEST = readFileSync(join(BRIDGE, 'Cargo.toml'), 'utf8');
const depLines = MANIFEST.split('\n')
  .slice(MANIFEST.split('\n').findIndex((l) => l.trim() === '[dependencies]') + 1)
  .filter((l) => l.trim() && !l.trim().startsWith('#'));
const enginePaths = depLines
  .map((l) => l.match(/path\s*=\s*"([^"]+)"/))
  .filter(Boolean)
  .map((m) => resolve(BRIDGE, m[1]));
if (enginePaths.length === 0) {
  throw new Error('wasm-bridge/Cargo.toml 里找不到 path 依赖，接不到引擎仓');
}
const missing = enginePaths.filter((p) => !existsSync(p));
if (missing.length > 0) {
  throw new Error(
    `引擎 crate 路径不存在：\n  ${missing.join('\n  ')}\n` +
      '⇒ 同步修改 wasm-bridge/Cargo.toml 的 path 依赖（引擎搬家或改名时这里必须一起改）。',
  );
}
const ENGINE = dirname(dirname(enginePaths[0])); // <引擎>/crates/<crate> → 引擎仓根

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
