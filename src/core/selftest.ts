import type { BodyDesc, BodyState, JointDesc, Vec3, WorldDesc, IPhysicsEngine } from './types';
import type { EngineEntry } from '../engines/registry';
import { SceneBuilder, icosaPoints, rockPoints, rng } from '../scenarios/kit';

export type ProbeStatus = 'pass' | 'degraded' | 'fail';

export interface ProbeResult {
  probeId: string;
  probeName: string;
  group: string;
  status: ProbeStatus;
  detail: string;
}

export interface SelfTestRow {
  engineId: string;
  engineName: string;
  language: string;
  backend: string;
  bootMs: number;
  bootOk: boolean;
  bootError?: string;
  results: ProbeResult[];
  passCount: number;
  failCount: number;
  degradedCount: number;
}

interface Probe {
  id: string;
  name: string;
  group: string;
  /** Steps to run before checking. */
  steps: number;
  build(): WorldDesc;
  /** Returns null when fine, or a human-readable failure reason. */
  check(states: BodyState[]): string | null;
  /**
   * Some probes can only fail because the engine does not report the value at
   * all. Those count as a degradation, not as a defect.
   */
  unreportedIsDegraded?: boolean;
}

const G: Vec3 = [0, -9.81, 0];

function allFinite(states: BodyState[]): string | null {
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const vals = [...s.position, ...s.rotation];
    if (vals.some((x) => !Number.isFinite(x))) return `刚体 #${i} 出现 NaN/Inf 位姿`;
  }
  return null;
}

// ---------------------------------------------------------------- shape probes

/** Ground + one body dropped from y = 5; checks it comes to rest in a sane band. */
function dropProbe(
  id: string,
  name: string,
  shape: BodyDesc['shape'],
  restLow: number,
  restHigh: number,
  extra: Partial<BodyDesc> = {},
): Probe {
  return {
    id, name, group: '形状', steps: 180,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(60, 1, 0, { friction: 0.9 });
      b.raw({
        id: 'probe-body',
        shape,
        type: 'dynamic',
        position: [0, 5, 0],
        rotation: [0, 0, 0, 1],
        density: 1000,
        friction: 0.7,
        restitution: 0.05,
        angularDamping: 0.2,
        ...extra,
      });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const y = states[1]?.position[1];
      if (y === undefined) return '缺少刚体状态';
      if (y < restLow || y > restHigh) return `静止高度 y=${y.toFixed(3)}，期望 ${restLow}~${restHigh}`;
      return null;
    },
  };
}

// ---------------------------------------------------------------- joint probes

const ANCHOR_HALF = 0.2;
const BODY_HALF = 0.4;

/** Rotates a body-local offset into world space. */
function worldPoint(pos: Vec3, q: [number, number, number, number], local: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * local[2] - z * local[1]);
  const ty = 2 * (z * local[0] - x * local[2]);
  const tz = 2 * (x * local[1] - y * local[0]);
  return [
    pos[0] + local[0] + w * tx + (y * tz - z * ty),
    pos[1] + local[1] + w * ty + (z * tx - x * tz),
    pos[2] + local[2] + w * tz + (x * ty - y * tx),
  ];
}

interface JointProbeOptions {
  axis?: Vec3;
  limits?: [number, number];
  restLength?: number;
  /** Allowed separation of the two anchor points, in metres. */
  tolerance?: number;
}

/**
 * Static anchor + hanging body, placed so the constraint is ALREADY satisfied
 * at t = 0.
 *
 * That matters: a probe that starts violated measures the solver's catch-up
 * transient, not whether the constraint holds. The first version of this file
 * put both anchors at the body centres one metre apart, which made every
 * position joint look broken on every engine.
 */
function jointProbe(
  id: string,
  name: string,
  kind: JointDesc['kind'],
  opts: JointProbeOptions = {},
): Probe {
  const anchorY = 10;
  const attachY = anchorY - ANCHOR_HALF;
  const aLocal: Vec3 = [0, -ANCHOR_HALF, 0];
  const rope = kind === 'distance' || kind === 'spring';
  const rest = opts.restLength ?? 1.2;
  // The gap keeps the two jointed bodies from touching each other. Without
  // it the probe measures the engine's contact response between the anchor
  // and the hanging body instead of the constraint - which pushed them 0.6 m
  // apart on Jolt and PhysX.
  const gap = 0.25;
  const bLocal: Vec3 = rope ? [0, 0, 0] : [0, BODY_HALF + gap, 0];
  const bodyY = rope ? attachY - rest : attachY - BODY_HALF - gap;
  const tolerance = opts.tolerance ?? 0.2;

  return {
    id, name, group: '约束', steps: 240,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(80);
      b.box([0, anchorY, 0], [ANCHOR_HALF, ANCHOR_HALF, ANCHOR_HALF], { type: 'static', tag: 'anchor' });
      // No ccd here: this probe measures constraints, and a CCD request would
      // add "no CCD" notes to every joint row on engines that lack it.
      b.box([0, bodyY, 0], [BODY_HALF, BODY_HALF, BODY_HALF], { density: 500, friction: 0.5 });
      b.joint({
        id: 'probe-joint',
        kind,
        bodyA: b.bodies[1].id,
        bodyB: b.bodies[2].id,
        anchorA: aLocal,
        anchorB: bLocal,
        axis: opts.axis ?? [0, 0, 1],
        limits: opts.limits,
        restLength: rest,
        // Only the spring kind reads these; putting them on a distance joint
        // is meaningless data (and every adapter is right to ignore it).
        stiffness: kind === 'spring' ? 1 : undefined,
        damping: kind === 'spring' ? 0.3 : undefined,
      });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const A = states[1];
      const B = states[2];
      if (!A || !B) return '缺少刚体状态';
      const pa = worldPoint(A.position, A.rotation, aLocal);
      const pb = worldPoint(B.position, B.rotation, bLocal);
      const d = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
      if (rope) {
        if (Math.abs(d - rest) > 0.35) return `锚点间距 ${d.toFixed(2)} m，期望 ≈ ${rest} m`;
      } else if (d > tolerance) {
        return `锚点分离 ${d.toFixed(3)} m（上限 ${tolerance} m）`;
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------- probe set

export const PROBES: Probe[] = [
  dropProbe('shape-sphere', '球体下落静止', { kind: 'sphere', radius: 0.4 }, 0.32, 0.55),
  dropProbe('shape-box', '盒体下落静止', { kind: 'box', halfExtents: [0.4, 0.4, 0.4] }, 0.32, 0.55),
  // Capsules may legally end up on their side (half height = radius = 0.3),
// which is what Bullet does; the band accepts both rest poses.
dropProbe('shape-capsule', '胶囊下落静止', { kind: 'capsule', radius: 0.3, halfHeight: 0.4 }, 0.26, 0.78),
  dropProbe('shape-cylinder', '圆柱下落静止', { kind: 'cylinder', radius: 0.4, halfHeight: 0.4 }, 0.32, 0.6),
  // Cone: most engines receive a convex-hull approximation whose stable rest
  // poses include tilted ones (measured: a 16-gon pyramid rests with its centre
  // at y = 0.178, lowest vertex -5 mm = contact skin, i.e. a legal pose). The
  // lower bound only has to catch sinking through the ground.
  dropProbe('shape-cone', '圆锥下落静止', { kind: 'cone', radius: 0.4, halfHeight: 0.5 }, 0.12, 0.62),
  dropProbe('shape-convex', '凸包下落静止', { kind: 'convex', points: icosaPoints(0.4) }, 0.3, 0.6),
  dropProbe('shape-wide-hull', '32 点凸包', { kind: 'convex', points: rockPoints(0.4, rng(7), 32) }, 0.28, 0.6),
  // A dumbbell rests on its two end spheres, so it cannot topple the way a
  // box+sphere stack does - which is what makes the expected height meaningful
  // rather than a coin flip.
  dropProbe('shape-compound', '复合体下落静止', {
    kind: 'compound',
    children: [
      { shape: { kind: 'sphere', radius: 0.3 }, offset: [-0.6, 0, 0] },
      { shape: { kind: 'sphere', radius: 0.3 }, offset: [0.6, 0, 0] },
      { shape: { kind: 'box', halfExtents: [0.6, 0.1, 0.1] }, offset: [0, 0, 0] },
    ],
  }, 0.22, 0.45),
  {
    id: 'shape-trimesh',
    name: '三角网地形承载',
    group: '形状',
    steps: 220,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      const verts: number[] = [];
      const idx: number[] = [];
      const N = 8;
      for (let iz = 0; iz <= N; iz++) {
        for (let ix = 0; ix <= N; ix++) verts.push(ix - N / 2, 0, iz - N / 2);
      }
      for (let iz = 0; iz < N; iz++) {
        for (let ix = 0; ix < N; ix++) {
          const a = iz * (N + 1) + ix, c = a + 1, d = a + N + 1, e = d + 1;
          idx.push(a, d, c, c, d, e);
        }
      }
      b.trimesh([0, 0, 0], verts, idx, { friction: 0.8 });
      b.sphere([0, 6, 0], 0.45, { density: 1000, friction: 0.7, restitution: 0.05 });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      // The dynamic sphere is bodies[1]: bodies[0] is the STATIC terrain, whose
      // y is 0 forever - reading it made this probe unfailable.
      const y = states[1]?.position[1];
      if (y === undefined) return '缺少刚体状态';
      if (y < -0.5) return `球体穿过三角网掉到 y=${y.toFixed(2)}`;
      if (y > 2) return `球体没有落到三角网上（y=${y.toFixed(2)}）`;
      return null;
    },
  },

  // ---------------------------------------------------------------- 追加（RUST WL 侧 P5，2026-09-21）
  // **"陷在网格里的体能否被顶出来"**——`shape-trimesh` 只测"落上去别掉穿"，
  // 判据带宽 −0.5…2（r=0.45 时下陷 0.95 m 也算过），且地形是平的。
  // 本条把体**直接生成在网格内部**（穿隧/传送都会造成这种起始态），
  // 看它是否被推回正确静置高度 `y = r`：
  //   · 正确：顶出到 y ≈ 0.45
  //   · 缺陷（RUST WL 侧定位到的机制）：被"远方擦着的三角形"的幽灵接触按住 ⇒ 原地不动
  //     （`sd = (center−q)·n` 是**投影量**，远三角形也能给出 depth≈0；且桶剪枝
  //      `max_d = radius+skin ≈ 0.22 m` 会把真正托着它的那张面所在桶剪掉 ⇒ 自锁）
  {
    id: 'shape-trimesh-sunk',
    name: '陷网球体能否顶出',
    group: '形状',
    steps: 220,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      const verts: number[] = [];
      const idx: number[] = [];
      const N = 8;
      for (let iz = 0; iz <= N; iz++) {
        for (let ix = 0; ix <= N; ix++) verts.push(ix - N / 2, 0, iz - N / 2);
      }
      for (let iz = 0; iz < N; iz++) {
        for (let ix = 0; ix < N; ix++) {
          const a = iz * (N + 1) + ix,
            c = a + 1,
            d = a + N + 1,
            e = d + 1;
          idx.push(a, d, c, c, d, e);
        }
      }
      b.trimesh([0, 0, 0], verts, idx, { friction: 0.8 });
      // 半径 0.45 的球，**球心放在地表之下 0.20 m**（穿透 0.65 m，但未穿出背面）。
      b.sphere([0, -0.2, 0], 0.45, { density: 1000, friction: 0.7, restitution: 0.05 });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const y = states[1]?.position[1];
      if (y === undefined) return '缺少刚体状态';
      const want = 0.45;
      if (y < want - 0.05) {
        return `陷网球未被顶出：y=${y.toFixed(3)}，期望 ${want}（差 ${(want - y).toFixed(3)} m）`;
      }
      return null;
    },
  },

  // ---------------------------------------------------------------- 追加（RUST WL 侧 P5，2026-09-21）
  // **取舍的代价侧**：起伏三角网上的静置高度有多准。
  // 上面两条把它拆成两半：`shape-trimesh-sunk` 量"可恢复性"（只有 8/9 会掉穿），
  // 本条量"静置高度准确性"——RUST WL 侧那个 `sd` 投影量机制会让体有"幽灵支撑"，
  // 可能停在偏低的位置；容差**故意收紧到 3 cm**，好让偏差直接以数字报出来（跨引擎可比）。
  {
    id: 'shape-trimesh-hilly',
    name: '起伏三角网静置高度',
    group: '形状',
    // 900 tick（15 s）：300 tick 时本引擎的盒子**还在下坡翻滚里**（Rust 侧同场景轨迹显示
    // t=225 才安静下来、|v| 仍在 0.004~0.064 之间摆）⇒ 300 tick 取到的是**瞬态**不是静置。
    steps: 900,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      const N = 8;
      const S = 4; // ±4 m、1 m 格距
      const H = (x: number, z: number) => 0.25 * Math.sin(0.8 * x) + 0.2 * Math.cos(0.9 * z);
      const verts: number[] = [];
      const idx: number[] = [];
      for (let iz = 0; iz <= N; iz++) {
        for (let ix = 0; ix <= N; ix++) {
          const x = -S + (2 * S * ix) / N;
          const z = -S + (2 * S * iz) / N;
          verts.push(x, H(x, z), z);
        }
      }
      for (let iz = 0; iz < N; iz++) {
        for (let ix = 0; ix < N; ix++) {
          const a = iz * (N + 1) + ix,
            c = a + 1,
            d = a + N + 1,
            e = d + 1;
          idx.push(a, d, c, c, d, e);
        }
      }
      b.trimesh([0, 0, 0], verts, idx, { friction: 0.9 });
      // 盒放在 (0,0) 的平缓处（该点是 H 的驻点附近），半高 0.35。
      b.box([0, H(0, 0) + 2.5, 0], [0.35, 0.35, 0.35], {
        density: 1000,
        friction: 0.9,
        restitution: 0.02,
      });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const s = states[1];
      if (!s) return '缺少刚体状态';
      // 历代判据都栽在"拿高度当接触"上（第一/二版：中心高度 ⇒ 斜停误判；第三版：
      // 最高角点 ⇒ 9 引擎全挂；第四版：最低角点 ⇒ 分不开"悬空"与"跨凹"）。
      // 第五版改量**底面接触**，见下。
      const [qx, qy, qz, qw] = s.rotation;
      const rot = (v: [number, number, number]): [number, number, number] => {
        // q·v·q⁻¹ 展开（行主序；单位四元数）
        const [x, y, z] = v;
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        return [
          x + qw * tx + (qy * tz - qz * ty),
          y + qw * ty + (qz * tx - qx * tz),
          z + qw * tz + (qx * ty - qy * tx),
        ];
      };
      // **判据第六版：全身采样**。前几版都栽在同一件事上——刚性盒在起伏地面上
      // **本来就不会每个角都贴地**：跨凹处时最低角点离地、压凸处时四角全离地，
      // 那都是几何必然。而且盒子翻滚后**可能躺在任何一面**上（甚至翻过来），
      // 所以"底面"这个说法本身就不成立。
      // 唯一站得住的判据是：**盒体表面有没有任何一处贴着地形**。于是六个面 × 7×7
      // 采样（含全部棱与角，共 294 点）取 (y − H(x,z)) 的最小值：
      //  ≈0 或负 = 有支撑；全为正 = 整块盒子悬在空中（真悬空）。
      // 格距 1 m 下网格弦与解析面偏差上限 ±0.02 ⇒ 门限取 0.03/0.05，是参考噪声的 1.5~2.5 倍。
      const H = (x: number, z: number) => 0.25 * Math.sin(0.8 * x) + 0.2 * Math.cos(0.9 * z);
      const half = 0.35;
      const K = 7;
      let minGap = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        for (const sgn of [-1, 1]) {
          for (let i = 0; i < K; i++) {
            for (let j = 0; j < K; j++) {
              const u = -half + (2 * half * i) / (K - 1);
              const v = -half + (2 * half * j) / (K - 1);
              const l: [number, number, number] = [0, 0, 0];
              l[axis] = sgn * half;
              l[(axis + 1) % 3] = u;
              l[(axis + 2) % 3] = v;
              const c = rot(l);
              const wx = s.position[0] + c[0];
              const wy = s.position[1] + c[1];
              const wz = s.position[2] + c[2];
              minGap = Math.min(minGap, wy - H(wx, wz));
            }
          }
        }
      }
      if (minGap < -0.03) {
        return `盒体穿透地形 ${(-minGap).toFixed(3)} m（pos=(${s.position.map((v) => v.toFixed(3)).join(', ')})）`;
      }
      if (minGap > 0.05) {
        return `盒体悬空：全身最低采样点离地 ${minGap.toFixed(3)} m（pos=(${s.position.map((v) => v.toFixed(3)).join(', ')})）`;
      }
      return null;
    },
  },


  jointProbe('joint-spherical', '球形铰链悬挂', 'spherical'),
  jointProbe('joint-revolute', '转动关节悬挂', 'revolute'),
  jointProbe('joint-fixed', '固定关节悬挂', 'fixed', { tolerance: 0.3 }),
  jointProbe('joint-prismatic', '棱柱关节悬挂', 'prismatic', { axis: [1, 0, 0] }),
  jointProbe('joint-distance', '距离关节悬挂', 'distance', { restLength: 1.2, tolerance: 0.4 }),

  {
    id: 'stability-stack',
    name: '5 层堆叠不塌陷',
    group: '稳定性',
    steps: 360,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(60, 1, 0, { friction: 0.9 });
      for (let k = 0; k < 5; k++) {
        b.box([0, 0.5 + k * 1.01, 0], [0.5, 0.5, 0.5], { friction: 0.7, restitution: 0.01 });
      }
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const top = states[5] ?? states[states.length - 1];
      if (!top) return '缺少刚体状态';
      const [x, y, z] = top.position;
      if (y < 4.0) return `顶层掉到 y=${y.toFixed(2)}（塌了）`;
      if (Math.hypot(x, z) > 1.2) return `顶层滑出 ${Math.hypot(x, z).toFixed(2)} m`;
      return null;
    },
  },
  {
    id: 'stability-ccd',
    name: 'CCD 挡住高速弹丸',
    group: '稳定性',
    steps: 120,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(80);
      b.box([0, 2, 0], [0.05, 2, 4], { type: 'static', tag: 'thin-wall' });
      b.sphere([-14, 2, 0], 0.3, {
        density: 9000,
        ccd: true,
        friction: 0.3,
        restitution: 0.1,
        velocity: [240, 0, 0],
      });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      // bodies[2] is the projectile (0 ground, 1 wall). The wall's x is 0
      // forever, so reading states[1] meant this probe could never fail.
      const x = states[2]?.position[0];
      if (x === undefined) return '缺少刚体状态';
      // A projectile that never got its initial velocity would otherwise look
      // exactly like a CCD stop: still sitting at the spawn point.
      if (Math.abs(x + 14) < 5) {
        return `弹丸几乎停在出生点 x=${x.toFixed(2)}（未获得初速度）`;
      }
      if (x > 1.0) return `弹丸穿透薄墙，跑到 x=${x.toFixed(2)}`;
      return null;
    },
  },
  {
    id: 'stability-sleep',
    name: '静置后进入休眠',
    group: '稳定性',
    unreportedIsDegraded: true,
    steps: 600,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(60, 1, 0, { friction: 0.8 });
      b.box([0, 0.5, 0], [0.5, 0.5, 0.5], { friction: 0.7 });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const s = states[1];
      if (!s) return '缺少刚体状态';
      if (s.sleeping === undefined) return '引擎未上报休眠状态';
      if (s.sleeping === false) return '静置 10 秒后仍未休眠';
      return null;
    },
  },
  {
    id: 'stability-energy',
    name: '自由落体无异常增益',
    group: '稳定性',
    unreportedIsDegraded: true,
    steps: 90,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(60);
      b.sphere([0, 20, 0], 0.4, { density: 1000, friction: 0.5, restitution: 0 });
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      const s = states[1];
      if (!s) return '缺少刚体状态';
      // Position first: a body that never falls (no gravity, no integration, a
      // dropped initial state) reports vy = 0 and used to pass.
      const y = s.position[1];
      if (y > 14) {
        return `自由落体 1.5 秒后仍在 y=${y.toFixed(1)}（从 20 m 落下应约到 9 m）`;
      }
      const vy = s.linearVelocity?.[1];
      // 1.5 s of free fall from rest is 14.7 m/s downward; anything wildly
      // different means the integrator is injecting or losing energy.
      if (vy !== undefined && Math.abs(vy) > 20) {
        return `1.5 秒后竖直速度为 ${vy.toFixed(1)} m/s（应约 -14.7）`;
      }
      if (vy === undefined) return '引擎未上报速度（无法验证能量）';
      return null;
    },
  },
  {
    id: 'stability-distinct',
    name: '刚体位姿互不相同',
    group: '稳定性',
    steps: 200,
    build() {
      const b = new SceneBuilder();
      b.gravity = G;
      b.ground(60, 1, 0, { friction: 0.9 });
      // Spaced so nothing touches, so every body must settle at its own x.
      // This is the one check that catches an adapter handing back the same
      // body handle for every index: it would report one x N times, and none
      // of the other probes notice because they only ever read "a" body.
      // (Jolt did exactly this - 41 instances all at (0, 8.41, 0) - and the
      // rest of this matrix stayed green.)
      for (let i = 0; i < 8; i++) {
        b.box([-4.2 + i * 1.2, 0.6, 0], [0.4, 0.4, 0.4], { friction: 0.7, restitution: 0.01 });
      }
      return b.finish();
    },
    check(states) {
      const nan = allFinite(states);
      if (nan) return nan;
      // Dynamic bodies only: the static ground contributes x = 0 to the set,
      // which used to leave a free slot for one aliased pair.
      const xs = states.slice(1).map((s) => Math.round(s.position[0] * 10) / 10);
      const distinct = new Set(xs).size;
      if (distinct < 8) {
        return `只有 ${distinct} 个互不相同的 x（8 个盒子应各自落位）——多个索引读到了同一个刚体`;
      }
      const spread = Math.max(...xs) - Math.min(...xs);
      if (spread < 7) return `x 跨度只有 ${spread.toFixed(1)} m（应约 8.4）`;
      return null;
    },
  },
];

export interface SelfTestProgress {
  engineName: string;
  probeName: string;
  index: number;
  total: number;
}

/**
 * Boots every engine and runs the probe matrix against it.
 *
 * Deliberately separate from the benchmark: the benchmark measures how fast an
 * engine is, this measures whether it does the right thing at all.
 */
export async function runSelfTest(
  engines: EngineEntry[],
  onProgress?: (p: SelfTestProgress) => void,
  yieldToUi: () => Promise<void> = () => new Promise((r) => setTimeout(r, 0)),
  probeFilter?: string[],
): Promise<SelfTestRow[]> {
  const probes = probeFilter
    ? PROBES.filter((p) => probeFilter.includes(p.id))
    : PROBES;
  const rows: SelfTestRow[] = [];
  const total = engines.length * probes.length;
  let index = 0;

  for (const entry of engines) {
    const row: SelfTestRow = {
      engineId: entry.meta.id,
      engineName: entry.meta.name,
      language: entry.meta.language,
      backend: entry.meta.backend,
      bootMs: 0,
      bootOk: false,
      results: [],
      passCount: 0,
      failCount: 0,
      degradedCount: 0,
    };

    let engine: IPhysicsEngine | null = null;
    const t0 = performance.now();
    try {
      engine = await entry.boot();
      row.bootMs = performance.now() - t0;
      row.bootOk = true;
    } catch (e) {
      row.bootMs = performance.now() - t0;
      row.bootError = e instanceof Error ? e.message : String(e);
    }

    if (!engine) {
      for (const p of probes) {
        row.results.push({
          probeId: p.id, probeName: p.name, group: p.group,
          status: 'fail', detail: `引擎启动失败：${row.bootError}`,
        });
        row.failCount++;
        index++;
        onProgress?.({ engineName: entry.meta.name, probeName: p.name, index, total });
      }
      rows.push(row);
      await yieldToUi();
      continue;
    }

    try {
      for (const probe of probes) {
        onProgress?.({ engineName: entry.meta.name, probeName: probe.name, index, total });
        await yieldToUi();
        let status: ProbeStatus = 'pass';
        let detail = '通过';
        try {
          engine.build(probe.build());
          for (let i = 0; i < probe.steps; i++) engine.step(1 / 60);
          const states = engine.readStates();
          const problem = probe.check(states);
          const eng = engine as unknown as { notes?: Set<string>; skippedJoints?: number };
          const notes = eng.notes ? [...eng.notes] : [];
          const skipped = eng.skippedJoints ?? 0;
          const degraded = notes.length > 0 || skipped > 0;
          if (problem) {
            // A probe that tests a capability the engine explicitly declares
            // unsupported is a degradation, not a defect: the CCD probe would
            // otherwise mark every CCD-less engine as failing a test it never
            // claimed to pass (the wall is transparent for them by design).
            const caps = engine.meta.capabilities;
            if (probe.id === 'stability-ccd' && !caps.ccd) {
              status = 'degraded';
              detail = `引擎声明不支持 CCD，薄墙穿透属预期（${problem}）`;
            } else if (probe.unreportedIsDegraded && /未上报/.test(problem)) {
              status = 'degraded';
              detail = problem;
            } else if (degraded && probe.group === '约束') {
              // On a joint probe an unsupported constraint is far more often
              // the cause than a solver defect - but the measured evidence
              // must survive into the detail string.
              status = 'degraded';
              detail = `引擎不支持该约束（${notes.join('、') || '关节被跳过'}）：${problem}`;
            } else {
              status = 'fail';
              detail = problem;
            }
          } else if (degraded) {
            status = 'degraded';
            detail = `通过，但${notes.join('、') || `跳过了 ${skipped} 个关节`}`;
          }
        } catch (e) {
          status = 'fail';
          detail = e instanceof Error ? e.message : String(e);
        }

        row.results.push({ probeId: probe.id, probeName: probe.name, group: probe.group, status, detail });
        if (status === 'pass') row.passCount++;
        else if (status === 'degraded') row.degradedCount++;
        else row.failCount++;
        index++;
      }
    } finally {
      // A throw from onProgress / yieldToUi must never leak the engine.
      engine.dispose();
    }

    rows.push(row);
    await yieldToUi();
  }

  return rows;
}

export function selfTestToCsv(rows: SelfTestRow[]): string {
  const head = ['engine', 'language', 'backend', 'boot_ms', 'probe', 'group', 'status', 'detail'];
  const out = [head.join(',')];
  for (const r of rows) {
    for (const p of r.results) {
      const cells = [
        r.engineName, r.language, r.backend, r.bootMs.toFixed(0),
        p.probeName, p.group, p.status, p.detail.replace(/"/g, "'"),
      ];
      out.push(cells.map((c) => (c.includes(',') ? `"${c}"` : c)).join(','));
    }
  }
  return out.join('\n');
}
