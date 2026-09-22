/**
 * Destruction, fluids and extreme pressure.
 *
 * The earlier groups cover structure (does it stand up) and dynamics (does it
 * fly). This group covers the two things the earlier ones cannot:
 *
 *  - **destruction**, i.e. what a boolean cut actually asks of a solver: a body
 *    that was one piece of matter becomes N pieces that must immediately stop
 *    interpenetrating. That is a deep-penetration recovery problem, and solvers
 *    differ wildly on it.
 *  - **fluids**, approximated with particle clusters. No engine here has SPH
 *    built in, but a few hundred low-friction spheres in a confined volume is
 *    the classic stand-in for water, and it is a contact-count stress test that
 *    no rigid-body stack produces (bodies touch each other on all sides at
 *    near-zero separation).
 *
 * "Pressure" scenes push the same idea to the point where iterative solvers
 * demonstrably lose: a very heavy mass resting on a bed of light bodies, and a
 * column tall enough that a per-step error of 1e-4 compounds into visible lean.
 */
import type { Scenario } from './types';
import { SceneBuilder, rng } from './kit';

/**
 * Water-like particle: slides freely, loses almost nothing to bounce.
 *
 * The tag matters as much as the physics: every fluid particle is drawn in the
 * same blue (see colorFor). Without it the particles come out in eight palette
 * hues and the pool reads as a pile of balls rather than as water.
 */
const FLUID = {
  friction: 0.04,
  restitution: 0.01,
  angularDamping: 0.5,
  linearDamping: 0.06,
  density: 1000,
  tag: 'fluid',
} as const;

/** Same motion, different material: the carved box is filled with grain, not water. */
const GRAIN = { ...FLUID, tag: 'grain', friction: 0.45, angularDamping: 0.7 } as const;

export const HAVOC_SCENARIOS: Scenario[] = [
  {
    id: 'bool-slice',
    name: '布尔切割',
    group: '破坏与流体',
    description:
      '一个 4 m 立方体被布尔切割成 8 块，切面完全贴合、零间隙。切开的那一帧起，求解器就要处理 12 对互相穿透的接触面——这是深度穿透恢复能力的直接考验。',
    defaultBodies: 8,
    maxBodies: 64,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.8 });

      // Cuts per axis. 1 = whole cube, 2 = 8 pieces, 3 = 27 pieces.
      const cuts = Math.max(1, Math.min(3, Math.round(Math.cbrt(Math.max(1, ctx.bodies)))));
      const h = 2 / cuts;
      const y0 = 4;
      for (let i = 0; i < cuts; i++) {
        for (let j = 0; j < cuts; j++) {
          for (let k = 0; k < cuts; k++) {
            b.box(
              [(i - (cuts - 1) / 2) * h, y0 + (j - (cuts - 1) / 2) * h, (k - (cuts - 1) / 2) * h],
              // 0.5% shrink per face so the stack is *just* clear of itself.
              // Exact contact would make the scene's outcome a race between the
              // solver's penetration recovery and the first frame's impulses.
              [h / 2 - h * 0.005, h / 2 - h * 0.005, h / 2 - h * 0.005],
              { friction: 0.55, restitution: 0.02, tag: 'chassis' },
            );
          }
        }
      }
      // A shell arriving at 40 m/s does the cutting in practice.
      b.sphere([-10, y0, 0], 0.4, {
        density: 4000,
        velocity: [40, 0, 0],
        ccd: true,
        restitution: 0.1,
        tag: 'projectile',
      });
      b.extent = 12;
      return b;
    },
  },

  {
    id: 'bool-carve',
    name: '布尔挖空',
    group: '破坏与流体',
    description:
      '实心块被布尔挖空成一个开口箱，里面灌满颗粒。挖空结构意味着碰撞体只有薄壁，没有任何内部支撑——薄壁与颗粒的接触是这里唯一的承载路径。',
    defaultBodies: 140,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.8 });

      const half = 3;
      const wall = 0.25;
      const height = 3;
      // Floor + three walls, all static: the "carved" shell.
      b.box([0, wall, 0], [half, wall, half], { type: 'static', tag: 'wall' });
      b.box([-half, wall + height / 2, 0], [wall, height / 2, half], { type: 'static', tag: 'wall' });
      b.box([half, wall + height / 2, 0], [wall, height / 2, half], { type: 'static', tag: 'wall' });
      b.box([0, wall + height / 2, -half], [half, height / 2, wall], { type: 'static', tag: 'wall' });

      const r = 0.3;
      const n = Math.max(20, ctx.bodies);
      const cols = Math.max(2, Math.floor((half * 2 - wall) / (r * 2.05)));
      const perLayer = cols * cols;
      const layers = Math.ceil(n / perLayer);
      for (let i = 0; i < n; i++) {
        const ix = i % cols;
        const iz = Math.floor(i / cols) % cols;
        const iy = Math.floor(i / perLayer);
        if (iy >= layers) break;
        b.sphere(
          [
            -half + wall + r + ix * r * 2.05,
            wall + r + 0.05 + iy * r * 2.05,
            -half + wall + r + iz * r * 2.05,
          ],
          r,
          { ...GRAIN },
        );
      }
      // One heavy shot at the open face, to make the shell show its loading.
      b.sphere([0, wall + height * 0.6, -12], 0.5, {
        density: 5000,
        velocity: [0, 0, 26],
        ccd: true,
        tag: 'projectile',
      });
      b.extent = 12;
      return b;
    },
  },

  {
    id: 'destruct-tower',
    name: '破坏塔',
    group: '破坏与流体',
    description:
      '细长塔的腰部做了弱连接（低摩擦、轻微缝隙）。一发炮弹打腰部：能不能保住上半截，取决于求解器怎么处理「上方几百个质量压在一层松接触上」。',
    defaultBodies: 60,
    maxBodies: 300,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.85 });

      const perLevel = 4;
      const levels = Math.max(4, Math.floor(ctx.bodies / perLevel));
      const h = 0.5;
      const span = 0.62;
      const waist = Math.floor(levels * 0.28);
      for (let l = 0; l < levels; l++) {
        const weak = l >= waist && l < waist + 2;
        for (let i = 0; i < perLevel; i++) {
          const a = (i / perLevel) * Math.PI * 2 + (l % 2 ? Math.PI / perLevel : 0);
          b.box(
            [Math.cos(a) * span, h + l * (h * 2 + 0.015), Math.sin(a) * span],
            [h * 0.96, h, h * 0.96],
            {
              friction: weak ? 0.08 : 0.7,
              restitution: 0.01,
              density: weak ? 600 : 900,
            },
          );
        }
      }
      const hitY = h + waist * (h * 2 + 0.015);
      b.sphere([-14, hitY, 0], 0.45, {
        density: 5000,
        velocity: [46, 0, 0],
        ccd: true,
        tag: 'projectile',
      });
      b.extent = 16;
      return b;
    },
  },

  {
    id: 'destruct-bridge',
    name: '断桥',
    group: '破坏与流体',
    description:
      '多跨桥面由距离关节串成一条链，两端固定。抽掉中间一跨的支撑后，链条必须靠约束自己吊住——关节实现得对不对，这里一眼可见。',
    defaultBodies: 24,
    maxBodies: 80,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.8 });

      const spans = Math.max(6, Math.min(24, ctx.bodies));
      const seg = 2.2;
      const y = 6;
      const ids: string[] = [];
      // Two static abutments anchor the chain.
      b.box([-(spans / 2 + 0.6) * seg, y - 0.6, 0], [0.8, 0.6, 2], { type: 'static', tag: 'wall' });
      b.box([(spans / 2 + 0.6) * seg, y - 0.6, 0], [0.8, 0.6, 2], { type: 'static', tag: 'wall' });

      for (let i = 0; i < spans; i++) {
        const deck = b.box(
          [(i - (spans - 1) / 2) * seg, y, 0],
          [seg / 2 - 0.02, 0.12, 1.6],
          { friction: 0.7, restitution: 0.01, density: 800, tag: 'platform' },
        );
        ids.push(deck.id);
      }
      // Distance joints pin each deck to its neighbour: the chain is the bridge.
      for (let i = 1; i < ids.length; i++) {
        b.joint({
          id: `span${i}`,
          kind: 'distance',
          bodyA: ids[i - 1],
          bodyB: ids[i],
          anchorA: [seg / 2, 0, 0],
          anchorB: [-seg / 2, 0, 0],
          restLength: 0.04,
          stiffness: 1,
          damping: 0.2,
        });
      }
      // The load: a heavy ball dropped on the middle of the span.
      b.sphere([0, y + 9, 0], 0.9, { density: 6000, tag: 'shell' });
      b.extent = spans * seg;
      return b;
    },
  },

  {
    id: 'fluid-dam-break',
    name: '水坝崩塌',
    group: '破坏与流体',
    description:
      '一池低摩擦颗粒被薄坝拦在高台上。坝体被击穿后颗粒整体塌落——每颗粒子四面都贴着邻居，接触对数量会瞬间冲到刚体数的三倍以上，是接触求解的极限测试。',
    defaultBodies: 320,
    maxBodies: 2000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(200, 1, 0, { friction: 0.85 });

      const r = 0.22;
      const gap = r * 2.06;
      const cols = 9;
      const rows = 9;
      const depth = 6;
      const baseY = 5;
      const x0 = -9;

      // High plateau the pool sits on.
      b.box([x0 + (cols * gap) / 2, baseY / 2, 0], [(cols * gap) / 2 + 0.6, baseY / 2, (depth * gap) / 2 + 0.6], {
        type: 'static',
        tag: 'platform',
      });
      // Thin dam wall holding the pool in.
      b.box([x0 + cols * gap + 0.25, baseY + 0.9, 0], [0.25, 0.9, (depth * gap) / 2 + 0.6], {
        type: 'static',
        tag: 'thin-wall',
      });

      const n = Math.max(40, ctx.bodies);
      let placed = 0;
      outer:
      for (let iy = 0; iy < rows; iy++) {
        for (let iz = 0; iz < depth; iz++) {
          for (let ix = 0; ix < cols; ix++) {
            if (placed >= n) break outer;
            b.sphere(
              [x0 + r + ix * gap, baseY + r + 0.05 + iy * gap, -((depth * gap) / 2) + r + iz * gap],
              r,
              { ...FLUID },
            );
            placed++;
          }
        }
      }
      // Break the dam.
      b.sphere([x0 + cols * gap + 6, baseY + 1.4, 0], 0.5, {
        density: 6000,
        velocity: [-48, 0, 0],
        ccd: true,
        tag: 'projectile',
      });
      b.extent = 26;
      return b;
    },
  },

  {
    id: 'fluid-pool',
    name: '液体堆积',
    group: '破坏与流体',
    description:
      '颗粒垂直落进 U 形池。看点不是流动而是**静止堆高**：颗粒最终堆积的高度直接反映接触求解的穿透补偿——补偿过强会「浮」起来，不足会陷进池底。',
    defaultBodies: 400,
    maxBodies: 2200,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });

      const half = 4;
      const wall = 0.3;
      const height = 5;
      b.box([0, wall, 0], [half, wall, half], { type: 'static', tag: 'wall' });
      b.box([-half, wall + height / 2, 0], [wall, height / 2, half], { type: 'static', tag: 'wall' });
      b.box([half, wall + height / 2, 0], [wall, height / 2, half], { type: 'static', tag: 'wall' });
      b.box([0, wall + height / 2, -half], [half, height / 2, wall], { type: 'static', tag: 'wall' });
      b.box([0, wall + height / 2, half], [half, height / 2, wall], { type: 'static', tag: 'wall' });

      const r = 0.22;
      const gap = r * 2.06;
      const cols = Math.max(2, Math.floor((half * 2 - wall * 2) / gap));
      const perLayer = cols * cols;
      const n = Math.max(40, ctx.bodies);
      const layers = Math.ceil(n / perLayer);
      const rnd = rng(ctx.seed || 17);
      let placed = 0;
      for (let layer = layers - 1; layer >= 0 && placed < n; layer--) {
        for (let iy = 0; iy < cols && placed < n; iy++) {
          for (let iz = 0; iz < cols && placed < n; iz++) {
            b.sphere(
              [
                -half + wall + r + iy * gap,
                wall + r + 0.1 + (layer + 1) * gap,
                -half + wall + r + iz * gap + (rnd() - 0.5) * 0.02,
              ],
              r,
              { ...FLUID },
            );
            placed++;
          }
        }
      }
      b.extent = 14;
      return b;
    },
  },

  {
    id: 'pressure-vise',
    name: '液压夹',
    group: '破坏与流体',
    description:
      '一块 8 倍密度的重块砸在薄床上，把几百个轻刚体挤向两侧。质量比 8:1 加上密闭几何，是迭代求解器最容易崩的形态：底部接触先饱和，然后整块下沉。',
    defaultBodies: 180,
    maxBodies: 1200,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.9 });

      const r = 0.4;
      const gap = r * 2.05;
      const cols = 9;
      const n = Math.max(24, ctx.bodies);
      const rows = Math.ceil(n / (cols * cols));
      let placed = 0;
      outer:
      for (let iy = 0; iy < rows; iy++) {
        for (let iz = 0; iz < cols; iz++) {
          for (let ix = 0; ix < cols; ix++) {
            if (placed >= n) break outer;
            b.sphere(
              [(ix - (cols - 1) / 2) * gap, r + 0.05 + iy * gap, (iz - (cols - 1) / 2) * gap],
              r,
              { friction: 0.5, restitution: 0.01, density: 300, angularDamping: 0.3 },
            );
            placed++;
          }
        }
      }
      // Side walls so the material can only escape upward - a confined bed.
      const span = (cols * gap) / 2 + 0.5;
      b.box([-span, 3, 0], [0.4, 3, span], { type: 'static', tag: 'wall' });
      b.box([span, 3, 0], [0.4, 3, span], { type: 'static', tag: 'wall' });
      // The press: an 8x density mass, released from just above the bed.
      b.box([0, 5.2, 0], [span - 0.5, 0.9, span - 0.5], {
        density: 2400,
        friction: 0.6,
        restitution: 0.01,
        tag: 'pusher',
      });
      b.extent = span * 2;
      return b;
    },
  },

  {
    id: 'pressure-column',
    name: '高压柱',
    group: '破坏与流体',
    description:
      '一柱到底的单点堆叠：N 层方块，每层只有一个接触面。每步 1e-4 的求解误差会沿着柱体线性累积，所以柱顶的水平漂移是衡量求解器「够不够准」最灵敏的指标。',
    defaultBodies: 40,
    maxBodies: 160,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.95 });

      const h = 0.5;
      const levels = Math.max(3, Math.min(160, ctx.bodies));
      for (let l = 0; l < levels; l++) {
        b.box(
          [0, h + l * (h * 2 + 0.004), 0],
          [h * 0.98, h, h * 0.98],
          { friction: 0.9, restitution: 0, angularDamping: 0.2, density: 1200 },
        );
      }
      b.extent = 10 + levels * 0.02;
      return b;
    },
  },

  {
    id: 'fluid-cascade',
    name: '液体瀑布',
    group: '破坏与流体',
    description:
      '颗粒从高处一级级跌落到三层台面上。看点不是流动速度，而是**每次落点重新铺开**：粒子从自由落体撞进静止堆，接触对数量在几帧内暴涨十几倍，是接触求解最难受的瞬间。',
    defaultBodies: 260,
    maxBodies: 1600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });

      const r = 0.2;
      const gap = r * 2.06;
      // Three stepped ledges: each one catches the flow and spills it onward.
      const ledges: [number, number, number][] = [
        [-6, 14, 3],
        [1, 10, 3],
        [7, 6.5, 3],
      ];
      for (const [x, y, halfZ] of ledges) {
        b.box([x, y, 0], [3.2, 0.25, halfZ], { type: 'static', tag: 'platform' });
        b.box([x + 3.1, y + 0.35, 0], [0.2, 0.35, halfZ], { type: 'static', tag: 'thin-wall' });
      }

      const n = Math.max(40, ctx.bodies);
      const cols = 7;
      const perLayer = cols * cols;
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const ix = i % cols;
        const iz = Math.floor(i / cols) % cols;
        const iy = Math.floor(i / perLayer);
        if (placed >= n) break;
        b.sphere(
          [-6 + (ix - (cols - 1) / 2) * gap, 16 + r + iy * gap, (iz - (cols - 1) / 2) * gap],
          r,
          { ...FLUID },
        );
        placed++;
      }
      b.extent = 22;
      return b;
    },
  },

  {
    id: 'fluid-drain',
    name: '液体排空',
    group: '破坏与流体',
    description:
      '一池颗粒从底部的小孔漏出。孔径只有粒子直径的三倍，粒子必须**互相推挤着排队通过**——这是接触求解在瓶颈几何下的连续稳定性测试，也是各种穿透/抖动的放大镜。',
    defaultBodies: 280,
    maxBodies: 1500,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.8 });

      const half = 3.4;
      const wall = 0.3;
      const height = 4;
      const r = 0.2;
      const gap = r * 2.06;
      // A floor with a gap in the middle: four static slabs leaving a hole.
      const hole = gap * 3;
      const slab = (half - hole) / 2;
      for (const sx of [-1, 1]) {
        b.box([sx * (hole + slab), wall, 0], [slab, wall, half], { type: 'static', tag: 'wall' });
      }
      for (const sz of [-1, 1]) {
        b.box([0, wall, sz * (hole + slab)], [hole, wall, slab], { type: 'static', tag: 'wall' });
      }
      // Side walls of the tank.
      for (const sx of [-1, 1]) {
        b.box([sx * half, wall + height / 2, 0], [wall, height / 2, half], { type: 'static', tag: 'wall' });
        b.box([0, wall + height / 2, sx * half], [half, height / 2, wall], { type: 'static', tag: 'wall' });
      }

      const n = Math.max(30, ctx.bodies);
      const cols = Math.max(2, Math.floor((half * 2 - wall * 2) / gap));
      let placed = 0;
      for (let layer = 0; layer < 40 && placed < n; layer++) {
        for (let iy = 0; iy < cols && placed < n; iy++) {
          for (let iz = 0; iz < cols && placed < n; iz++) {
            b.sphere(
              [
                -half + wall + r + iy * gap,
                wall + r + 0.1 + layer * gap,
                -half + wall + r + iz * gap,
              ],
              r,
              { ...FLUID },
            );
            placed++;
          }
        }
      }
      b.extent = 14;
      return b;
    },
  },

  {
    id: 'destruct-wall',
    name: '逐层打穿',
    group: '破坏与流体',
    description:
      '四道独立的砖墙排成一列，一发高速弹丸依次打穿。每一道墙都是**全新的初始接触状态**，所以这一场能连续看到四次「撞击瞬间」——比单面墙更能暴露恢复系数与穿透补偿的差异。',
    defaultBodies: 180,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.8 });

      const rnd = rng(ctx.seed || 53);
      const rows = 8;
      const cols = 5;
      const bw = 0.5;
      const bh = 0.45;
      let n = 0;
      const max = Math.max(20, ctx.bodies);
      for (let w = 0; w < 4; w++) {
        const z = -6 + w * 4;
        for (let iy = 0; iy < rows; iy++) {
          const off = iy % 2 ? bw * 0.5 : 0;
          for (let ix = 0; ix < cols; ix++) {
            if (n >= max) break;
            b.box(
              [(ix - (cols - 1) / 2) * bw * 1.02 + off, 0.3 + iy * bh * 1.02, z + (rnd() - 0.5) * 0.01],
              [bw * 0.49, bh * 0.49, 0.22],
              { friction: 0.7, restitution: 0.02, density: 1500 },
            );
            n++;
          }
        }
      }
      b.sphere([-14, 3.2, 0], 0.4, {
        density: 8000,
        velocity: [60, 0, 0],
        ccd: true,
        restitution: 0.05,
        tag: 'projectile',
      });
      b.extent = 20;
      return b;
    },
  },

  {
    id: 'destruct-columns',
    name: '承重柱失效',
    group: '破坏与流体',
    description:
      '四根柱子撑着一块平台，弹丸从侧面逐根打断。真正难的不是打断，而是**打断之后**：平台失去支撑时的力矩、剩余柱子的侧向受力、以及最终倒塌的姿态，全都依赖接触求解的稳定性。',
    defaultBodies: 60,
    maxBodies: 300,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.9 });

      const span = 3.2;
      const segH = 0.5;
      const levels = Math.max(3, Math.min(12, Math.floor(ctx.bodies / 12)));
      const positions: [number, number][] = [
        [-span, -span], [span, -span], [span, span], [-span, span],
      ];
      for (const [px, pz] of positions) {
        for (let l = 0; l < levels; l++) {
          b.box(
            [px, segH + l * segH * 2.02, pz],
            [0.42, segH, 0.42],
            { friction: 0.75, restitution: 0.01, density: 1400 },
          );
        }
      }
      // The slab the columns are holding up.
      const top = segH + levels * segH * 2.02;
      b.box([0, top + 0.4, 0], [span + 0.9, 0.4, span + 0.9], {
        friction: 0.8, restitution: 0, density: 1900, tag: 'roof',
      });
      b.sphere([-12, top * 0.35, -span], 0.45, {
        density: 9000,
        velocity: [52, 0, 0],
        ccd: true,
        tag: 'projectile',
      });
      b.extent = 16;
      return b;
    },
  },
];
