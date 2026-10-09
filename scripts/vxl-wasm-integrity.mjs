// WASM 源码一致性门（CI 用）。
//
// 已提交的 public/vendor/vxl/vxl_phys_wasm.wasm 是静态二进制，历史上没有任何 CI
// 任务从 BSHSQ Rust 源码重建或校验它——它能在无人察觉的情况下与源码脱节
// （手改、不同步、换了 rev 没重建）。本门从 vxl_wasm.build.json 钉住的 BSHSQ rev
// 重建 wasm，并实例化「已提交」与「重建」两份 wasm、跑同一固定场景，比较**物理输出**
// checksum；再比一次导出符号集合。源码相同 => 物理确定 => checksum/ABI 逐位一致；
// 脱节 / 手改 / 换 rev 没重建 => 不一致 => 阻断发布。
//
// 为什么是「行为比对」而非「逐字节比对」：
// rustc 把「源路径散列（crate disambiguator）」渗进 wasm 的类型/函数索引布局，
// 导致同一份源码在不同构建主机 / 路径上字节不等（已在 CI 实测：同源码 Windows 本地
// 与 Linux CI 字节不同）。但物理行为确定且跨主机一致，所以比行为才能真正抓住
// 「逻辑是否同源」，且与构建主机无关。
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumWasm, listExports } from './wasm-behavior.mjs';

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
const { bshsq_rev, bshsq_repo = 'bfxh/BSHSQ', behavior_sha256 } = meta;
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
// 钉死到溯源文件记录的 rev，并 --force 检出工作树（--no-checkout 克隆后工作树为空，
// 必须真正 checkout 才有 crates/ 源码；--force 同时覆盖任何脏/空状态）。
console.log(`[vxl-integrity] 取并检出 ${bshsq_repo} @ ${bshsq_rev}`);
execFileSync('git', ['fetch', 'origin', bshsq_rev, '--depth', '1'], { cwd: BSHSQ_SRC, stdio: 'inherit' });
execFileSync('git', ['checkout', '--detach', '--force', bshsq_rev], { cwd: BSHSQ_SRC, stdio: 'inherit' });

// 2) 满足 wasm-bridge/Cargo.toml 的 path 依赖 ../../BSHSQ/crates：本地开发机
//    D:/KF/BSHSQ 已真实存在则跳过；CI 里该位置不存在 => 建符号链接。
const engineLink = resolve(ROOT, '..', 'BSHSQ');
if (!existsSync(engineLink)) {
  try { rmSync(engineLink, { force: true }); } catch {}
  symlinkSync(BSHSQ_SRC, engineLink, 'dir');
  console.log(`[vxl-integrity] 引擎链接: ${engineLink} -> ${BSHSQ_SRC}`);
}

// 3) 从钉住 rev 重建 wasm（--locked 锁死依赖版本；只产出到 target/，不覆盖已提交文件）。
console.log('[vxl-integrity] 重建 wasm（cargo build --release --target wasm32-unknown-unknown --locked）');
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--locked'], {
  cwd: BRIDGE,
  stdio: 'inherit',
});
if (!existsSync(BUILT_WASM)) fail('构建未产出 target/.../vxl_phys_wasm.wasm');

// 4) 行为比对：同场景物理输出 checksum + 导出符号集合，已提交 vs 重建。
console.log('[vxl-integrity] 行为比对（固定场景，物理确定 => checksum/ABI 必须逐位一致）');
const committedChk = await checksumWasm(COMMITTED_WASM);
const builtChk = await checksumWasm(BUILT_WASM);
console.log(`[vxl-integrity] 已提交  behavior ${committedChk}`);
console.log(`[vxl-integrity] 重建    behavior ${builtChk}`);

const committedExports = await listExports(COMMITTED_WASM);
const builtExports = await listExports(BUILT_WASM);
const exportDrift = committedExports.filter((e) => !builtExports.includes(e))
  .concat(builtExports.filter((e) => !committedExports.includes(e)));
if (exportDrift.length > 0) {
  fail(`已提交与重建的 wasm 导出符号不一致（脱节）：${exportDrift.join(', ')}`);
}

// 一致性：溯源文件记录的 behavior_sha256 必须等于已提交 wasm（否则溯源文件过期）。
if (behavior_sha256 && behavior_sha256 !== committedChk) {
  fail(
    `vxl_wasm.build.json 记录的 behavior_sha256 (${behavior_sha256}) 与已提交 wasm (${committedChk}) 不符 ` +
      '—— 溯源文件过期，提交前忘了重跑 npm run build:vxl',
  );
}
// 核心不变量：已提交 wasm 的行为必须等于从钉住源码重建的 wasm。
if (committedChk !== builtChk) {
  fail(
    `重建 wasm 的行为 checksum (${builtChk}) 与已提交 wasm (${committedChk}) 不一致 —— ` +
      `已提交 wasm 与 BSHSQ @ ${bshsq_rev} 脱节（手改 / 不同步 / 换了 rev 没重建）`,
  );
}
console.log('[vxl-integrity] OK：已提交 wasm 与钉住源码行为逐位一致');
