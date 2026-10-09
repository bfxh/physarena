// 上游漂移探针（nightly 用，仅报告、不阻断）。
//
// 现有门禁只验证「内部一致性」：
//   - vxl wasm 行为 == 钉住 BSHSQ rev 重建（vxl-wasm-integrity）
//   - vendored 引擎 == 锁版本 node_modules（check-vendor-drift）
//   - 部署字节 == 提交字节（verify-live）
// 它们都假设「钉住的源」是对的。但钉住的源会落后于上游而无人察觉：
// BSHSQ 合了修正确定性/正确性的 PR，physarena 的 bshsq_rev 仍停在旧 commit；
// 或锁版本引擎包（Havok/PhysX/ammo）出了新版，lockfile 没跟。
// 这种「源真值已前进、本地钉死未跟进」的漂移，上述任何门都不会红——因为
// 提交物与钉住源始终自洽。本探针补上这最后一块：把「钉死值」对到「上游 HEAD /
// 最新 npm 版本」，发现落后就打 WARN。它是报告性的，绝不阻断 nightly（nightly
// 的哲学就是「只报告、不移动站点」），目的是让钉死过期这件事在 CI 日志/产物里
// 可见，而不是悄悄烂掉。
//
// 全程只读：对 BSHSQ 只做 ls-remote + /tmp 下的 blobless 克隆（绝不改 BSHSQ 仓
// 或 physarena 已提交文件）；对 npm 只做 `npm view <pkg> version`。任何网络/权限
// 失败都降级为 INFO「无法检查」，绝不抛错退出非零。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = resolve(ROOT, 'public/vendor/vxl/vxl_wasm.build.json');

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

const findings = [];
function note(kind, msg) {
  findings.push({ kind, msg });
  console.log(`${kind === 'WARN' ? 'WARN ' : 'INFO '} ${msg}`);
}

const drift = { bshsq: null, vendored: [] };

// ---- 1. BSHSQ pin 漂移：钉死 rev 相对上游默认分支落后多少 commit ----------
try {
  const meta = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const rev = meta.bshsq_rev;
  const repo = meta.bshsq_repo || 'bfxh/BSHSQ';
  if (!rev) {
    note('WARN', 'vxl_wasm.build.json 缺少 bshsq_rev，跳过 BSHSQ 漂移检查');
  } else {
    const remote = `https://github.com/${repo}.git`;
    note('INFO', `BSHSQ pin = ${rev} (repo ${repo})`);
    // 廉价先取上游 HEAD（默认分支 tip）做相等性判断。
    const ls = sh('git', ['ls-remote', remote]);
    const headLine = (ls || '').split('\n').find((l) => /refs\/heads\/(main|master)$/.test(l))
      || (ls || '').split('\n').find((l) => l.endsWith('\tHEAD'));
    const head = headLine ? headLine.split(/\s+/)[0] : null;
    if (!head) {
      note('INFO', `无法 ls-remote ${repo}（网络/权限），BSHSQ 漂移跳过`);
    } else if (head === rev) {
      note('INFO', 'BSHSQ pin 与上游 HEAD 一致（0 commit 落后）');
      drift.bshsq = { rev, head, behind: 0, reachable: true };
    } else {
      // 不等：尝试 blobless 克隆算 behind count（仅在 /tmp，绝不碰 BSHSQ 仓）。
      let behind = null, reachable = null;
      const tmp = '/tmp/bshsq-drift-probe';
      try {
        if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
        // blobless 全量克隆（只省文件内容、保留完整提交历史），这样 rev-list --count
        // 才能算出「钉死 rev 到上游 HEAD」之间的真实落后 commit 数。--depth 1 会丢历史，
        // 导致计数失败。nightly 一天一次、45min 预算，全量 blobless 克隆完全可接受。
        if (sh('git', ['clone', '--filter=blob:none', '--no-checkout', remote, tmp])) {
          // 保险：确保钉死 rev 在本地对象库（极端情况下在其它分支上）。
          sh('git', ['fetch', remote, rev], { cwd: tmp });
          const isAnc = sh('git', ['merge-base', '--is-ancestor', rev, 'HEAD'], { cwd: tmp });
          reachable = isAnc === ''; // 退出码 0 => 是祖先
          const c = sh('git', ['rev-list', '--count', `${rev}..HEAD`], { cwd: tmp });
          if (c && /^\d+$/.test(c)) behind = Number(c);
        }
      } catch {
        /* 降级：保留 behind=null，下面按「不等但无法计数」报告 */
      } finally {
        try { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
      const behindTxt = behind == null ? '（无法计数）' : `（${behind} commit 落后）`;
      const reachTxt = reachable === false ? '；钉死 rev 不在上游默认分支历史线上（可能来自其他分支）' : '';
      note('WARN', `BSHSQ pin 落后于上游 HEAD${behindTxt}${reachTxt} —— 考虑 bump bshsq_rev 到 ${head.slice(0, 12)}…`);
      drift.bshsq = { rev, head, behind, reachable };
    }
  }
} catch {
  note('INFO', '读取 vxl_wasm.build.json 失败，BSHSQ 漂移跳过');
}

// ---- 2. vendored 引擎版本漂移：锁版本 vs npm 最新 -------------------------
try {
  const lock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8'));
  const pkgs = {
    '@babylonjs/havok': 'vendor/havok/HavokPhysics.wasm',
    'physx-js-webidl': 'vendor/physx/physx-js-webidl.wasm',
    'ammojs-typed': 'vendor/ammo/ammo.js',
  };
  for (const [pkg, dest] of Object.entries(pkgs)) {
    const locked = lock.packages?.[`node_modules/${pkg}`]?.version
      || lock.dependencies?.[pkg]?.version;
    const latest = sh('npm', ['view', pkg, 'version']);
    if (!locked) {
      note('INFO', `${pkg} 未在 package-lock 找到锁定版本，跳过`);
      continue;
    }
    if (!latest) {
      note('INFO', `无法 npm view ${pkg}（网络/registry），跳过`);
      continue;
    }
    if (locked !== latest) {
      note('WARN', `${pkg} 锁定 ${locked} < 最新 ${latest} —— vendored ${dest} 可升级（先 npm i ${pkg}@latest 再 npm run vendor）`);
      drift.vendored.push({ pkg, dest, locked, latest });
    } else {
      note('INFO', `${pkg} 锁定 ${locked} == 最新`);
    }
  }
} catch {
  note('INFO', '读取 package-lock.json 失败，vendored 版本漂移跳过');
}

// ---- 汇总（报告性，永远 exit 0）-----------------------------------------
const warns = findings.filter((f) => f.kind === 'WARN');
console.log(`\n[upstream-drift] ${warns.length} 项漂移警告，${findings.length - warns.length} 项信息`);
try {
  mkdirSync('out', { recursive: true });
  writeFileSync('out/upstream-drift.json', JSON.stringify({ when: new Date().toISOString(), drift, warns: warns.length }, null, 2));
} catch { /* 报告是便利物，绝不因此失败 */ }
process.exit(0);
