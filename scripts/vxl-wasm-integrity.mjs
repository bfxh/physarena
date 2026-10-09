// WASM 源码完整性门（CI 用）。
//
// 已提交的 public/vendor/vxl/vxl_phys_wasm.wasm 是一份静态二进制，历史上没有任何
// CI 任务从 BSHSQ Rust 源码重建或校验它——它可以在无人察觉的情况下与源码脱节
//（手改、不同步、换了 rev 没重建）。本门从 vxl_wasm.build.json 钉住的 BSHSQ rev
// 重建 wasm，与已提交的那份做 sha256 逐字节比对；不一致 => 阻断发布。
//
// 复用 npm run build:vxl 的真正构建（含零 unsafe 自检 + path 依赖校验 + cargo 构建），
// 但比对的是「构建前」已提交文件的快照与「重建产物」——因为 build:vxl 会把产物
// 拷贝覆盖回 public/vendor/vxl/，必须拿构建前的快照来比，否则恒等。
//
// 本地调试：设 VXL_INTEGRITY_ENGINE_DIR 指向已有的 BSHSQ checkout 可跳过 clone。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = resolve(ROOT, 'public/vendor/vxl/vxl_wasm.build.json');
const COMMITTED_WASM = resolve(ROOT, 'public/vendor/vxl/vxl_phys_wasm.wasm');
const BRIDGE = resolve(ROOT, 'wasm-bridge');
const BUILT_WASM = resolve(BRIDGE, 'target/wasm32-unknown-unknown/release/vxl_phys_wasm.wasm');

function fail(msg) {
  console.error('[vxl-integrity] FAIL:', msg);
  process.exit(1);
}

if (!existsSync(SIDECAR)) fail('缺少溯源文件 vxl_wasm.build.json（先跑 npm run build:vxl 生成）');
if (!existsSync(COMMITTED_WASM)) fail('缺少已提交 wasm public/vendor/vxl/vxl_phys_wasm.wasm');

const meta = JSON.parse(readFileSync(SIDECAR, 'utf8'));
const { bshsq_rev, bshsq_repo = 'bfxh/BSHSQ', wasm_sha256 } = meta;
if (!bshsq_rev) fail('vxl_wasm.build.json 缺少 bshsq_rev');
console.log(`[vxl-integrity] 钉住 ${bshsq_repo} @ ${bshsq_rev}`);

// 1) 取得 BSHSQ 源码（公开仓；VXL_INTEGRITY_ENGINE_DIR 已设则复用本地 checkout）。
const BSHSQ_SRC = process.env.VXL_INTEGRITY_ENGINE_DIR || '/tmp/bshsq-src';
if (!existsSync(BSHSQ_SRC)) {
  const token = process.env.GITHUB_TOKEN || '';
  const auth = token ? `x-access-token:${token}@` : '';
  const url = `https://${auth}github.com/${bshsq_repo}.git`;
  console.log(`[vxl-integrity] clone ${bshsq_repo} -> ${BSHSQ_SRC}`);
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', url, BSHSQ_SRC], { stdio: 'inherit' });
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: BSHSQ_SRC }).toString().trim();
if (head !== bshsq_rev) {
  console.log(`[vxl-integrity] 切到 ${bshsq_rev}（当前 ${head}）`);
  execFileSync('git', ['fetch', 'origin', bshsq_rev, '--depth', '1'], { cwd: BSHSQ_SRC, stdio: 'inherit' });
  execFileSync('git', ['checkout', '--detach', bshsq_rev], { cwd: BSHSQ_SRC, stdio: 'inherit' });
}

// 2) 满足 wasm-bridge/Cargo.toml 的 path 依赖 ../../BSHSQ/crates。
//    本地开发机 D:/KF/BSHSQ 已真实存在 => 跳过；CI 里该位置不存在 => 建符号链接。
const engineLink = resolve(ROOT, '..', 'BSHSQ');
if (!existsSync(engineLink)) {
  try { rmSync(engineLink, { force: true }); } catch {}
  symlinkSync(BSHSQ_SRC, engineLink, 'dir');
  console.log(`[vxl-integrity] 引擎链接: ${engineLink} -> ${BSHSQ_SRC}`);
}

// 3) 快照「构建前」已提交 wasm 的 sha，随后真正重建（会覆盖 public 里的那份）。
function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
const committedBefore = sha256(COMMITTED_WASM);
console.log(`[vxl-integrity] 已提交(构建前) sha256 ${committedBefore}`);

console.log('[vxl-integrity] 重建（scripts/build-vxl-wasm.mjs，含零 unsafe 自检）');
execFileSync('node', ['scripts/build-vxl-wasm.mjs'], { cwd: ROOT, stdio: 'inherit' });

if (!existsSync(BUILT_WASM)) fail('构建未产出 target/.../vxl_phys_wasm.wasm');
const builtSha = sha256(BUILT_WASM);
console.log(`[vxl-integrity] 重建产物      sha256 ${builtSha}`);

// 4) 一致性：溯源文件记录的 sha 必须等于已提交 wasm（否则溯源文件过期）。
if (wasm_sha256 && wasm_sha256 !== committedBefore) {
  fail(
    `vxl_wasm.build.json 记录的 sha256 (${wasm_sha256}) 与已提交 wasm (${committedBefore}) 不符 ` +
      '—— 溯源文件过期，提交前忘了重跑 npm run build:vxl',
  );
}
// 5) 核心不变量：从钉住源码重建的 wasm 必须等于已提交 wasm。
if (builtSha !== committedBefore) {
  fail(
    `重建 wasm (${builtSha}) 与已提交 wasm (${committedBefore}) 字节不一致 —— ` +
      `已提交 wasm 与 BSHSQ @ ${bshsq_rev} 脱节（手改 / 不同步 / 换了 rev 没重建）`,
  );
}
console.log('[vxl-integrity] OK：已提交 wasm 与钉住源码逐字节一致');
