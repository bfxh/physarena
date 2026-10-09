// vendor 漂移门（CI 用）：public/vendor/ 下的引擎载荷（Havok/PhysX/Bullet 的 wasm、
// ammo.js）是从 node_modules 里对应锁版本引擎包拷出来的派生产物——源真值是
// package-lock.json 锁死的 npm 引擎版本。构建时 prebuild 会重跑 vendor.mjs 覆盖它们，
// 所以「线上部署」的那份永远等于锁版本产物、可复现；但「仓库里提交的」那份可能滞后：
// 有人只改了 package.json 里的引擎版本号、忘了本地重跑 npm run vendor，提交上去的
// vendor/*.wasm 就和锁版本对不上了（与 BSHSQ wasm 脱节是同一类缺口）。
//
// 本门直接比对「仓库已提交的 public/vendor/<f>」与「锁版本 node_modules 里拷出的 <f>」
// 是否逐字节一致；不一致 => 提交前忘了同步 vendor，红。比对走字节，不依赖 git autocrlf，
// 跨平台稳。TARGETS 与 vendor.mjs 共用同一份，避免两张表漂移。
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './vendor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const pub = join(root, 'public');

let failures = 0;
for (const [src, dest] of TARGETS) {
  const from = join(nm, src);
  const to = join(pub, dest);
  if (!existsSync(from)) {
    console.error(`[vendor-drift] FAIL: 锁版本源缺失 ${src}（npm ci 后不应发生）`);
    failures++;
    continue;
  }
  if (!existsSync(to)) {
    console.error(`[vendor-drift] FAIL: 已提交 vendor 缺失 ${dest}（需提交 vendor 产物）`);
    failures++;
    continue;
  }
  const a = readFileSync(from);
  const b = readFileSync(to);
  if (a.byteLength !== b.byteLength || !a.equals(b)) {
    console.error(
      `[vendor-drift] FAIL: ${dest} 与锁版本 ${src} 逐字节不一致（提交前忘了跑 npm run vendor）`,
    );
    failures++;
  } else {
    console.log(`[vendor-drift] ok: ${dest} == 锁版本 ${src} (${a.byteLength} B)`);
  }
}

if (failures > 0) {
  console.error(`[vendor-drift] ${failures} 处 vendor 漂移，阻断`);
  process.exit(1);
}
console.log('[vendor-drift] OK：所有 vendored 引擎载荷与锁版本逐字节一致');
