// 构建 BSHSQ-Solver的 wasm 桥并把产物放进 public/vendor/vxl/。
//
// 依赖：Rust 工具链 + wasm32-unknown-unknown 目标（rustup target add wasm32-unknown-unknown）。
// 桥 crate 在 ./wasm-bridge/，path 依赖指向引擎仓的 crates/（具体位置见下方按 Cargo.toml 反推）。
// 引擎门面 crate 名 = vxl-phys（lib 名 vxl_phys），不是品牌名 —— 品牌改名别动依赖键。
// 引擎 crates 保持 `#![forbid(unsafe_code)]`；桥本身零 unsafe 块（本脚本附带一次源码检查）。
//
// 闭环关键：构建完把「行为 checksum + 字节 hash + 尺寸 + 时间戳」回写进溯源 sidecar
// （vxl_wasm.build.json），使「已提交 wasm」与「sidecar」始终一致。否则开发者跑完
// build:vxl 提交的就是一份 sidecar 过期的 wasm——源码一致性门只能在 push 后才红，
// 且要靠手改 JSON 才能修。脚本一次性把 sidecar 同步好，提交即可过门。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumWasm } from './wasm-behavior.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'wasm-bridge');
const OUT_DIR = join(ROOT, 'public', 'vendor', 'vxl');
const WASM = join(BRIDGE, 'target', 'wasm32-unknown-unknown', 'release', 'vxl_phys_wasm.wasm');
const SIDECAR = join(OUT_DIR, 'vxl_wasm.build.json');

// 引擎位置从 wasm-bridge/Cargo.toml 的 path 依赖反推——那是本桥与引擎之间唯一的承重耦合。
// 此前这里写的是 `VXL_ENGINE_DIR ?? resolve(ROOT, '..', '')`，但那个常量**只进日志、从不参与
// 构建**：路径指到不存在的目录也照样往下跑，报错落到 cargo 深处。改成按 Cargo.toml 实际解析
// 并逐项校验，接不上就当场停下说清该改哪。（Cargo 的 path 依赖不展开环境变量，所以没有更干净的招。）
// 只取 [dependencies] 段、且跳过注释行——整份 Cargo.toml 拿正则扫会把注释里的示例当成真依赖。
function resolveEngine() {
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
  return dirname(dirname(enginePaths[0])); // <引擎>/crates/<crate> → 引擎仓根
}

const SIDECAR_DEFAULTS = {
  bshsq_repo: 'bfxh/BSHSQ',
  verification: 'behavioral (not byte) — see scripts/vxl-wasm-integrity.mjs',
};

/**
 * 重算一份已构建 wasm 的事实并合并进溯源 sidecar，使「已提交 wasm」与
 * 「vxl_wasm.build.json」永不失同步。导出以便单测（无需 BSHSQ checkout / 不需 cargo）。
 * @param {string} wasmPath    刚构建出的 wasm 绝对路径
 * @param {string} engineDir   BSHSQ checkout 根（仅 VXL_UPDATE_REV=1 时反推 rev 用）
 * @param {string} sidecarPath vxl_wasm.build.json 绝对路径
 */
export async function updateSidecar(wasmPath, engineDir, sidecarPath) {
  const bytes = readFileSync(wasmPath);
  const wasmSha = createHash('sha256').update(bytes).digest('hex');
  const behaviorSha = await checksumWasm(wasmPath); // 实例化跑多场景固定物理场景，门强制要求与 wasm 一致

  const prev = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};
  const next = { ...SIDECAR_DEFAULTS, ...prev };

  // 行为 hash 是门强制要求与 wasm 一致的项——必须自动同步，杜绝手改 JSON 出错。
  next.behavior_sha256 = behaviorSha;
  next.wasm_sha256 = wasmSha;
  next.wasm_size_bytes = bytes.byteLength;
  next.last_built = new Date().toISOString();

  // bshsq_rev：默认保留既有钉死值（开发者有意钉某 rev 时不应被覆盖）；
  // 设 VXL_UPDATE_REV=1 时从本地 BSHSQ checkout 的 HEAD 反推，并警告脏树（脏树写入的
  // rev 不含未提交改动，会让一致性门后续红掉）。反推失败则保留既有值。
  if (process.env.VXL_UPDATE_REV) {
    try {
      const rev = execFileSync('git', ['-C', engineDir, 'rev-parse', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (rev) {
        const dirty = execFileSync('git', ['-C', engineDir, 'status', '--porcelain'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (dirty) {
          console.warn('[vxl-wasm] WARN: BSHSQ 工作树有未提交改动，写入的 bshsq_rev 不含这些改动');
        }
        next.bshsq_rev = rev;
      }
    } catch {
      console.warn('[vxl-wasm] WARN: 无法从本地 BSHSQ 反推 bshsq_rev，保留既有值');
    }
  }

  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(sidecarPath, JSON.stringify(next, null, 2) + '\n');
  console.log(
    `[vxl-wasm] sidecar 同步: behavior_sha256=${behaviorSha} wasm_sha256=${wasmSha} (${bytes.byteLength} B)` +
      (process.env.VXL_UPDATE_REV ? ` bshsq_rev=${next.bshsq_rev}` : ''),
  );
  return next;
}

async function main() {
  const ENGINE = resolveEngine();

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

  // 闭环：回写 sidecar，使「已提交 wasm + 溯源文件」一致，提交即可过源码一致性门。
  await updateSidecar(join(OUT_DIR, 'vxl_phys_wasm.wasm'), ENGINE, SIDECAR);
}

// 仅当被直接执行（npm run build:vxl）时才跑构建；被测试当作模块 import 只取 updateSidecar，
// 不触发 cargo 构建 / 不覆写真实 wasm（与 vendor.mjs、wasm-behavior.mjs 的守卫一致）。
if (process.argv[1] && process.argv[1].endsWith('build-vxl-wasm.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
