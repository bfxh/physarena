import { SceneBuilder, rng } from './kit';
import { levelsOf, triangularLevels, type BuildContext, type Scenario } from './types';

const BOX = 0.5;           // box half extent
const PITCH = BOX * 2.02;  // small gap so engines do not start in penetration

function pyramid(b: SceneBuilder, levels: number, bodies: number, jitter = 0) {
  const r = rng(1337);
  const counts = levelsOf(bodies, levels);
  let peak = 0;
  for (let k = 0; k < levels; k++) {
    const n = counts[k];
    // PITCH (1.01) is the level spacing. The old `PITCH * 0.98` made every
    // level penetrate the one below by 1.02 cm, so 210 bodies started in
    // interpenetration instead of resting.
    const y = BOX + k * PITCH;
    if (y + BOX > peak) peak = y + BOX;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * PITCH;
      const jx = jitter ? (r() - 0.5) * jitter : 0;
      const jz = jitter ? (r() - 0.5) * jitter : 0;
      b.box([x + jx, y, jz], [BOX, BOX, BOX], { friction: 0.6, restitution: 0.02 });
    }
  }
  b.extent = Math.max(12, peak * 1.4, (Math.max(...counts) * PITCH) * 0.75);
}

export const STACKING_SCENARIOS: Scenario[] = [
  {
    id: 'pyramid',
    name: '金字塔堆叠',
    group: '堆叠与结构',
    description: '经典静摩擦测试。堆得越高越考验求解器的接触迭代收敛，也最能暴露抖动与缓慢塌陷。',
    defaultBodies: 210,
    maxBodies: 2000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      pyramid(b, triangularLevels(ctx.bodies), ctx.bodies);
      return b;
    },
  },
  {
    id: 'pyramid-jitter',
    name: '抖动金字塔',
    group: '堆叠与结构',
    description: '带随机初始位错的堆叠。真实场景里几乎没有完美对齐的箱子，这个能看出求解器对角穿透的处理。',
    defaultBodies: 210,
    maxBodies: 1500,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      pyramid(b, triangularLevels(ctx.bodies), ctx.bodies, 0.06);
      return b;
    },
  },
  {
    id: 'brick-wall',
    name: '砖墙',
    group: '堆叠与结构',
    description: '错缝砌法的高墙。横向接触链很长，压力会一路传导到地基，考验求解器的接触图遍历顺序。',
    defaultBodies: 200,
    maxBodies: 1600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const hw = 0.6, hh = 0.28, hd = 0.3;
      const perRow = Math.max(4, Math.min(16, Math.round(Math.sqrt(ctx.bodies) * 1.1)));
      const rows = Math.max(3, Math.ceil(ctx.bodies / perRow));
      // Stop once the requested count is reached: the old perRow*rows product
      // silently over-built (200 requested -> 208 bodies).
      let made = 0;
      outer:
      for (let row = 0; row < rows; row++) {
        const offset = row % 2 === 0 ? 0 : hw;
        for (let i = 0; i < perRow; i++) {
          if (made >= ctx.bodies) break outer;
          const x = (i - (perRow - 1) / 2) * (hw * 2 + 0.02) + offset;
          b.box([x, hh + row * (hh * 2 + 0.01), 0], [hw, hh, hd], { friction: 0.7, restitution: 0.01 });
          made++;
        }
      }
      b.extent = Math.max(10, perRow * 1.4, rows * 1.0);
      return b;
    },
  },
  {
    id: 'tower',
    name: '细高塔',
    group: '堆叠与结构',
    description: '单体宽高比极大的塔。对求解器的角速度阻尼与摩擦锥建模非常敏感，稍微差一点就会自己倒。',
    defaultBodies: 60,
    maxBodies: 400,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const n = Math.max(4, ctx.bodies);
      const h = 0.45;
      for (let i = 0; i < n; i++) {
        // 2 cm gap per level: a visible settling drop instead of the old
        // 4 mm slit that made every engine's stack start in resting contact.
        b.box([0, h + i * (h * 2 + 0.02), 0], [0.55, h, 0.55], { friction: 0.8 });
      }
      b.extent = Math.max(9, n * 0.95);
      return b;
    },
  },
  {
    id: 'random-pile',
    name: '随机堆积',
    group: '堆叠与结构',
    description: '分层随机撒放的大小盒子。宽相位（broadphase）效率的照妖镜——物体分布越无序，BVH 质量差别越明显。',
    defaultBodies: 300,
    maxBodies: 3000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140);
      const r = rng(ctx.seed || 7);
      const n = Math.max(10, ctx.bodies);
      // Stratified placement. The old scheme put body i at y = 0.6 + i*0.13
      // with random x/z, so 10+ pairs spawned interpenetrating for every seed
      // (boxes up to 1.04 m across with a 0.13 m stride). A grid layer with a
      // 1.15x safety pitch plus a small jitter keeps every pair clear.
      const side = Math.max(2, Math.floor(Math.sqrt(n)));
      const span = Math.max(3, Math.sqrt(n) * 1.15);
      const step = span / side;
      for (let i = 0; i < n; i++) {
        const layer = Math.floor(i / (side * side));
        const idx = i % (side * side);
        const ix = idx % side;
        const iz = Math.floor(idx / side);
        const s = 0.22 + r() * 0.3;
        const jx = (r() - 0.5) * Math.max(0.05, step - 2 * 0.52);
        const jz = (r() - 0.5) * Math.max(0.05, step - 2 * 0.52);
        b.box(
          [
            (ix - (side - 1) / 2) * step + jx,
            0.6 + layer * 1.15,
            (iz - (side - 1) / 2) * step + jz,
          ],
          [s, s, s],
          { friction: 0.5, restitution: 0.05, rotation: [0, 0, 0, 1] },
        );
      }
      b.extent = Math.max(12, span * 0.9);
      return b;
    },
  },
  {
    id: 'irregular-block-jenga',
    name: '叠叠乐',
    group: '堆叠与结构',
    description: '交错堆叠的长条木块。接触面少、重心偏移大，最能体现求解器在低接触数下的稳定性差异。',
    defaultBodies: 90,
    maxBodies: 540,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const layers = Math.max(3, Math.ceil(ctx.bodies / 3));
      for (let l = 0; l < layers; l++) {
        const y = 0.15 + l * 0.32;
        for (let i = 0; i < 3; i++) {
          if (l % 2 === 0) b.box([0, y, (i - 1) * 1.0], [1.5, 0.15, 0.45], { friction: 0.6 });
          else b.box([(i - 1) * 1.0, y, 0], [0.45, 0.15, 1.5], { friction: 0.6 });
        }
      }
      b.extent = Math.max(9, layers * 0.6);
      return b;
    },
  },
  {
    id: 'sphere-pyramid',
    name: '球体金字塔',
    group: '堆叠与结构',
    description: '球接触是单点接触，没有面接触帮忙稳住。堆得起来说明求解器有像样的接触缓存与热启动。',
    defaultBodies: 120,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.9 });
      const levels = triangularLevels(ctx.bodies);
      const counts = levelsOf(ctx.bodies, levels);
      const d = 0.5;
      let peak = 0;
      for (let k = 0; k < levels; k++) {
        const n = counts[k];
        const y = d + k * d * 1.92;
        peak = y + d;
        for (let i = 0; i < n; i++) {
          b.sphere([(i - (n - 1) / 2) * d * 2.02, y, 0], d, { friction: 0.75, restitution: 0.02 });
        }
      }
      b.extent = Math.max(10, peak * 1.4);
      return b;
    },
  },
  {
    id: 'cylinder-jenga',
    name: '圆柱叠叠乐',
    group: '堆叠与结构',
    description: '圆柱之间是曲面-曲面接触，窄相位比盒子贵得多。每层几个圆柱交错叠高。',
    defaultBodies: 90,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const layers = Math.max(4, Math.ceil(ctx.bodies / 3));
      for (let l = 0; l < layers; l++) {
        const y = 0.4 + l * 0.82;
        for (let i = 0; i < 3; i++) {
          const p = l % 2 === 0
            ? [0, y, (i - 1) * 0.72] as [number, number, number]
            : [(i - 1) * 0.72, y, 0] as [number, number, number];
          b.cylinder(p, 0.35, 0.4, {
            friction: 0.7,
            rotation: l % 2 === 0 ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          });
        }
      }
      b.extent = Math.max(9, layers * 1.0);
      return b;
    },
  },
];
