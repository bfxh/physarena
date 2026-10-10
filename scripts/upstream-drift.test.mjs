// 漂移探针回归测试（无 cargo、秒级，CI/PR 直接跑）。
//
// 锁死 sh() 的契约 —— 这是本脚本踩过的真 bug：
//   git clone / npm view 成功时进度只写 stderr，stdout 为空字符串。调用方若用真值判断
//   `if (sh(...))`，'' 是 falsy，成功的命令会被当成失败，整个「取落后 commit 数」分支
//   被静默跳过，表现就是永远「无法计数」（查了很久才发现根因是这个，不是 git 的问题）。
// 契约：成功 => 返回字符串（可能 ''）；失败 => null。判失败必须用 `!== null`。
// 本测试让这个坑不可能悄悄复现。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sh, parseDefaultHead, runDrift } from './check-upstream-drift.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1) 成功且 stdout 有内容 => 返回该字符串
const withOut = sh(process.execPath, ['-e', "console.log('hello')"]);
check('sh: 成功且 stdout 有内容 => 返回该字符串', withOut === 'hello', JSON.stringify(withOut));

// 2) 成功但只写 stderr（clone/npm view 的真实形态）=> 返回空字符串，不是 null
const stderrOnly = sh(process.execPath, ['-e', "console.error('progress only')"]);
check('sh: 成功但仅 stderr 输出 => 返回空字符串 ""', stderrOnly === '', JSON.stringify(stderrOnly));
check('sh: 成功但仅 stderr 输出 => 不是 null', stderrOnly !== null, JSON.stringify(stderrOnly));

// 3) 上面这条正是真 bug 现场：真值判断会把它误判为失败
check('sh: 真值判断会把「成功且仅 stderr」误判为失败（故必须 !== null）',
  !stderrOnly && stderrOnly !== null,
  `truthy=${!!stderrOnly} !==null=${stderrOnly !== null}`);

// 4) 失败（非零退出）=> 返回 null
const failed = sh(process.execPath, ['-e', 'process.exit(3)']);
check('sh: 失败（非零退出）=> 返回 null', failed === null, JSON.stringify(failed));

// 5) 不存在的命令 => 返回 null（而不是抛异常）
const missing = sh('__definitely_not_a_command__', ['--x']);
check('sh: 命令不存在 => 返回 null（不抛异常）', missing === null, JSON.stringify(missing));

// 6) __diag 回调在失败时被触发（诊断路径可用）
let diagGot = null;
sh(process.execPath, ['-e', 'process.exit(1)'], { __diag: (m) => { diagGot = m; } });
check('sh: 失败时触发 __diag 诊断回调', typeof diagGot === 'string' && diagGot.length > 0, String(diagGot).slice(0, 40));

// 7) parseDefaultHead 解析真实 ls-remote 形态
const lsSample = [
  'abc123\trefs/heads/feature-x',
  'c5d580736e75b6b1f9e2a3c4d5e6f7a8b9c0d1e2f\trefs/heads/main',
  'deadbeef\trefs/tags/v1',
].join('\n');
check('parseDefaultHead: 从 ls-remote 输出取默认分支 tip',
  parseDefaultHead(lsSample) === 'c5d580736e75b6b1f9e2a3c4d5e6f7a8b9c0d1e2f', String(parseDefaultHead(lsSample)));
check('parseDefaultHead: 无 HEAD 行时返回 null', parseDefaultHead('') === null && parseDefaultHead(null) === null);

// 8) runDrift 无论网络/环境如何都不抛异常，且返回结构化结果（报告性脚本的硬要求）
let ran = null, threw = null;
try { ran = runDrift(); } catch (e) { threw = e; }
check('runDrift: 任何环境下都不抛异常（报告性脚本不得红掉 nightly）', threw === null, threw ? String(threw.message) : '');
check('runDrift: 返回结构化结果', !!ran && typeof ran === 'object' && typeof ran.warns === 'number'
  && Array.isArray(ran.findings) && !!ran.drift, JSON.stringify({ warns: ran?.warns, findings: ran?.findings?.length }));

// 9) 真实性：证明 sh 在真实 git 场景下的形态（用临时仓库，不依赖网络）
try {
  const d = mkdtempSync(join(tmpdir(), 'drift-t-'));
  const src = join(d, 'src');
  sh('git', ['init', '-q', src]);
  sh('git', ['-C', src, 'config', 'user.email', 'a@b.c']);
  sh('git', ['-C', src, 'config', 'user.name', 't']);
  writeFileSync(join(src, 'a.txt'), 'a');
  sh('git', ['-C', src, 'add', '.']);
  sh('git', ['-C', src, 'commit', '-q', '-m', 'c0']);
  const cl = join(d, 'clone');
  const cloneRes = sh('git', ['clone', '-q', src, cl]);
  check('sh: 真实 git clone 成功时返回空字符串（bug 现场复现）',
    cloneRes !== null && cloneRes === '', JSON.stringify(cloneRes));
  check('sh: 真实 git clone 用 !== null 判定为成功', cloneRes !== null, JSON.stringify(cloneRes));
  const count = sh('git', ['rev-list', '--count', 'HEAD'], { cwd: cl });
  check('sh: 真实 git rev-list 返回数字', count !== null && /^\d+$/.test(count), JSON.stringify(count));
  rmSync(d, { recursive: true, force: true });
} catch (e) {
  check('sh: 真实 git 场景（临时仓库）', false, String(e?.message || e));
}

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
if (failedChecks.length) {
  console.log('FAILED:\n' + failedChecks.map((f) => `  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`).join('\n'));
  process.exit(1);
}
