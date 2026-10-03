# PhysArena 修复台账（2026-09-15 完成）

入口：`C:\Users\lbx13\WorkBuddy\2026-09-15-07-43-53\physarena` → 拷贝到 `D:\开发\physarena`。
三路静态审视（引擎适配器 31 项 / 场景库 44 项 / UI+自检 24 项）全部逐条处置；
动态验证（**当轮口径**）：19 探针 × 9 引擎 **0 失败**（`out/selftest-joints.json`），
跑分 9 引擎 × 8 场景全部完成。**⚠️ 探针在 2026-09-21 扩到 21 项后这不再代表当前状态**，
现行口径见 `README.md`「兼容性自检矩阵」一节（21 探针、10 格红，锚 `out/selftest-cleanup20261003.json`）。

## 状态总览

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | 引擎适配器（速度读取/泄漏/CCD/质量/传感器/电机/材质释放） | ✅ 完成 |
| 2 | 自检空探针（3 个）+ 跑分睡眠感知 + 活跃度口径 | ✅ 完成 |
| 3 | 场景几何 20+ 处（互穿/入土/名实不符/关节违例） | ✅ 完成 |
| 4 | UI/渲染/导入（暂停黑屏/进度/互斥/重试/取景/NaN/注入/排序） | ✅ 完成 |
| 5 | 新增第 9 引擎 BSHSQ-Solver（wasm 桥，零 unsafe）+ 跑分对比 | ✅ 完成 |

## 关键实测证据

- **自检矩阵（前）**：原版构建 `out/selftest-before.json` —— 8 引擎 0 失败，但
  `shape-trimesh` / `stability-ccd` 读静态体（永不可能失败）、`stability-energy`
  缺位置断言 ⇒ 一部分"全绿"是假的。
- **自检矩阵（后，19 探针当轮）**：`out/selftest.json` / `out/selftest-joints.json` ——
  9 引擎 0 失败；修好探针后抓出的真实差异：PhysX CCD 实测不生效（隔离复现：场景+body
  标志、4 MB scratch、`ccdMaxPasses=4` 全开仍穿透 240 m/s 弹丸；15 m/s 对照正常）⇒
  capability 改 `ccd:false`，矩阵如实降级；cannon/cannon-es 三角网缺失被如实标注。
  **⚠️ 勘误（2026-10-03）**：本节此前引用的 `out/selftest-final.json` **实测不是 0 失败**——
  它是 21 探针版本、9 引擎合计 10 格红（与 `out/selftest-fixverify.json` 逐格相同）。
  0 失败的那两份是 19 探针时代的快照。
- **跑分（后）**：`out/bench-after.json` —— 9 引擎 × 8 场景；睡眠感知窗口生效
  （每个静止场景给出 `sleep_onset_step`）。8 场景平均 p50（ms）：
  PhysX 0.29 / Havok 0.35 / Oimo 0.56 / Jolt 0.63 / Rapier 0.72 / Crashcat 1.09 /
  Bullet 2.06 / **BSHSQ-Solver 2.71** / cannon-es 47.5（含一格 30 s 超限）。
- **构建与类型**：`npm run typecheck` 0 报错；`npm run build` 通过；
  `npm run build:vxl` 产出 354 KB 桥 wasm（桥自带 3 项单测 + 零 unsafe 源码自检）。

## 新增资产

- `src/engines/vxl.ts` + registry 第 9 项：BSHSQ-Solveradapter。
- `wasm-bridge/`：独立工作区的桥 crate（batch ABI，零 unsafe；`vxl_abi` 版本化）。
- `scripts/build-vxl-wasm.mjs`、`scripts/arena-drive.mjs`（无头驱动：selftest/bench）、
  `scripts/arena-probe-only.mjs`、`scripts/arena-probe.mjs`、若干隔离探针
  （`arena-ccd-probe` / `arena-cyl-probe` / `arena-enum-probe` / `vxl-cone-probe`）。
- `package.json`：`build:vxl`、`drive:selftest`、`drive:bench`。

## 已知残留（如实记录）

- **cannon-es 布娃娃群 356 ms/步**（触及 30 s 单格上限、样本不完整）：凸包胶囊
  × 12 次迭代的病态窄相，属该引擎自身特性；跑分表已标注。
- **BSHSQ-Solver 关节未接桥**：facade 尚无关节 API（mech 域在引擎路线图里），
  声明为不支持并在每个关节场景标注。
- **PhysX CCD**：上游绑定/集成层面的实测结论已写入其 README「已知限制」；
  若后续版本修复，把 `capabilities.ccd` 改回 `true` 即可（标志代码已就位）。
- **Mimosa 扫描**：本次未取得完整结论（scanner_enobufs），按兼容策略继续，
  **不宣称项目安全**。

## 复现命令

```bash
cd /d/开发/physarena
npm run typecheck && npm run build          # 静态与构建
npm run build:vxl                            # 需要 Rust + wasm32 目标
npm run preview &                            # 4173
ARENA_TAG=after node scripts/arena-drive.mjs bench     # → out/bench-after.json
ARENA_TAG=final node scripts/arena-drive.mjs selftest # → out/selftest-final.json
```
