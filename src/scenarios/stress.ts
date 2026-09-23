import { SceneBuilder, rng } from './kit';
import type { Scenario } from './types';

export const STRESS_SCENARIOS: Scenario[] = [
  {
    id: 'ccd-onslaught',
    name: 'CCD 穿透地狱',
    group: '极端工况',
    description: '0.05 秒一帧的炮弹打 0.1 米厚的薄墙。不开连续碰撞检测，子弹会直接穿过去——这个场景专门看谁真的实现了 CCD。',
    defaultBodies: 60,
    maxBodies: 400,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      // Fire from x = -140 so the wall impact lands INSIDE the measured window.
      // From the old x = -16 the projectile hit (or tunneled) at step ~4, i.e.
      // entirely inside the 30-step warmup, and the 180 measured steps
      // contained nothing but flight.
      b.ground(400);
      const count = Math.max(2, Math.min(24, Math.round(ctx.bodies / 3)));
      for (let i = 0; i < count; i++) {
        const z = (i - (count - 1) / 2) * 2.4;
        b.box([0, 2, z], [0.05, 2, 1.0], { type: 'static', tag: 'thin-wall' });
        b.sphere([-140, 2, z], 0.3, {
          density: 8000,
          velocity: [260, 0, 0],
          ccd: true,
          friction: 0.3,
          restitution: 0.2,
          tag: 'projectile',
        });
      }
      b.extent = 20;
      return b;
    },
  },
  {
    id: 'ccd-control',
    name: '无 CCD 对照组',
    group: '极端工况',
    description: '与"CCD 穿透地狱"完全相同的场景，但不开连续碰撞检测。用来量化 CCD 到底值多少性能。',
    defaultBodies: 60,
    maxBodies: 400,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      // Same geometry as ccd-onslaught, without CCD, and the same reason for
      // the launch distance (impact must fall inside the measured window).
      b.ground(400);
      const count = Math.max(2, Math.min(24, Math.round(ctx.bodies / 3)));
      for (let i = 0; i < count; i++) {
        const z = (i - (count - 1) / 2) * 2.4;
        b.box([0, 2, z], [0.05, 2, 1.0], { type: 'static', tag: 'thin-wall' });
        b.sphere([-140, 2, z], 0.3, {
          density: 8000,
          velocity: [260, 0, 0],
          ccd: false,
          friction: 0.3,
          restitution: 0.2,
          tag: 'projectile',
        });
      }
      b.extent = 20;
      return b;
    },
  },
  {
    id: 'cannonball',
    name: '炮弹轰墙',
    group: '极端工况',
    description: '重弹以中等速度撞击砖墙，撞击后碎石四散。冲量传递与堆叠被瞬间破坏时的稳定性。',
    defaultBodies: 180,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160);
      const rows = Math.max(3, Math.min(14, Math.round(Math.sqrt(ctx.bodies / 3))));
      const cols = Math.max(3, Math.ceil(Math.sqrt(ctx.bodies / 2)));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          b.box([(c - (cols - 1) / 2) * 0.62, 0.3 + r * 0.62, 0], [0.3, 0.3, 0.3], {
            friction: 0.55, restitution: 0.05,
          });
        }
      }
      b.sphere([-20, 3.2, 0], 0.7, {
        density: 12000, velocity: [55, 1, 0], ccd: true, restitution: 0.1, friction: 0.4, tag: 'shell',
      });
      b.extent = 18;
      return b;
    },
  },
  {
    id: 'small-objects',
    name: '微小物体地狱',
    group: '极端工况',
    description: '2 厘米级的碎块。碰撞边距（collision margin）处理和单精度浮点精度在这里直接暴露。',
    defaultBodies: 500,
    maxBodies: 4000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140, 1, 0, { friction: 0.8 });
      const r = rng(ctx.seed || 51);
      const n = Math.max(20, ctx.bodies);
      const span = Math.sqrt(n) * 0.34;
      for (let i = 0; i < n; i++) {
        const s = 0.008 + r() * 0.014;
        b.box(
          [(r() - 0.5) * span, 0.3 + i * 0.05, (r() - 0.5) * span],
          [s, s, s],
          { friction: 0.5, restitution: 0.05, linearDamping: 0.02 },
        );
      }
      b.extent = Math.max(10, span * 1.1);
      return b;
    },
  },
  {
    id: 'narrow-corridor',
    name: '窄缝拥挤',
    group: '极端工况',
    description: '比物体只宽一点点的通道，几百个盒子被挤着往下灌。接触数量爆炸，是求解器吞吐量的极限测试。',
    defaultBodies: 300,
    maxBodies: 280,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const w = 1.2;
      for (const side of [-1, 1]) {
        b.box([side * (w / 2 + 0.3), 4, 0], [0.3, 4, 3], { type: 'static', tag: 'corridor-wall' });
      }
      // The roof traps the spawn column: the old version climbed a column to
      // 5 + n*0.36 (900 m at n = 2500, 289 of 300 boxes spawned ON the roof)
      // with a 0.36 m stride under 0.52 m boxes. Boxes now spawn on a lattice
      // that actually fits the corridor (2 x 10 x 14 slots, 0.53 m stride),
      // which is why maxBodies became 280.
      b.box([0, 8.4, 0], [w / 2 + 0.6, 0.3, 3], { type: 'static', tag: 'roof' });
      const n = Math.max(20, Math.min(280, ctx.bodies));
      for (let i = 0; i < n; i++) {
        const ix = i % 2;
        const iz = Math.floor(i / 2) % 10;
        const iy = Math.floor(i / 20);
        b.box(
          [(ix - 0.5) * 0.6, 0.8 + iy * 0.53, -2.7 + iz * 0.6],
          [0.26, 0.26, 0.26],
          { friction: 0.4, restitution: 0.03 },
        );
      }
      b.extent = 10;
      return b;
    },
  },
  {
    id: 'mass-ratio',
    name: '质量比悬殊',
    group: '极端工况',
    description: '1 万公斤的铁块压在 0.1 公斤的碎块上。质量矩阵条件数极差，是最容易让求解器崩掉的配置。',
    defaultBodies: 120,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140, 1, 0, { friction: 0.9 });
      const r = rng(ctx.seed || 71);
      const n = Math.max(10, ctx.bodies);
      // Running stack top: the old per-shape stride (0.3 / 1.2) let a light
      // block land inside a heavy one's volume and put the very first heavy
      // block 0.6 m below the ground surface.
      let top = 0.5;
      for (let i = 0; i < n; i++) {
        const light = i % 8 !== 0;
        const s = light ? 0.12 : 1.1;
        const y = top + s;
        top = y + s + 0.05;
        b.box([(r() - 0.5) * 6, y, (r() - 0.5) * 6], [s, s, s], {
          density: light ? 8 : 9000,
          friction: 0.7,
          restitution: 0.02,
        });
      }
      b.extent = 12;
      return b;
    },
  },
  {
    id: 'big-world',
    name: '远离原点',
    group: '极端工况',
    description: '把同一堆箱子放到离原点 5000 米处。引擎内部用 32 位浮点还是双精度，会直接表现为抖动或穿模。',
    defaultBodies: 150,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      const O = 5000;
      b.box([O, -1, 0], [60, 1, 60], { type: 'static', tag: 'ground-far' });
      const r = rng(ctx.seed || 81);
      const n = Math.max(10, ctx.bodies);
      for (let i = 0; i < n; i++) {
        b.box([O + (r() - 0.5) * 8, 0.5 + i * 1.05, (r() - 0.5) * 8], [0.45, 0.45, 0.45], {
          friction: 0.6, restitution: 0.03,
        });
      }
      b.extent = 14;
      return b;
    },
  },
  {
    id: 'fragmentation',
    name: '碎裂堆',
    group: '极端工况',
    description: '预先切碎的大块堆叠，模拟可破坏物体。小碎片 + 大数量 + 长时间休眠唤醒抖动。',
    defaultBodies: 400,
    maxBodies: 3000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160);
      const r = rng(ctx.seed || 91);
      const n = Math.max(20, ctx.bodies);
      const cols = Math.ceil(Math.cbrt(n));
      for (let i = 0; i < n; i++) {
        const ix = i % cols;
        const iy = Math.floor(i / cols) % cols;
        const iz = Math.floor(i / (cols * cols));
        b.box(
          // Jitter reduced below the grid clearance (0.34 - 0.30): the old
          // +-0.05 consumed it and left 10-14 pairs in penetration.
          [(ix - (cols - 1) / 2) * 0.34 + (r() - 0.5) * 0.025,
          0.25 + iy * 0.34,
          (iz - (cols - 1) / 2) * 0.34 + (r() - 0.5) * 0.025],
          [0.15, 0.15, 0.15],
          { friction: 0.65, restitution: 0.02, angularDamping: 0.1 },
        );
      }
      b.extent = Math.max(10, cols * 0.5);
      return b;
    },
  },
  {
    id: 'multi-contact-grid',
    name: '密集接触网格',
    group: '极端工况',
    description: '一层挨一层的方块网格。几乎没有空隙，窄相位配对数量被拉到最大，纯吞吐量测试。',
    defaultBodies: 600,
    maxBodies: 3600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(180);
      const n = Math.max(9, ctx.bodies);
      // side from the CUBE root, so the layer loop actually runs: with
      // side = ceil(sqrt(n)) the first layer always reached n and the grid was
      // silently a single flat sheet ("layer upon layer" never happened).
      const side = Math.max(3, Math.ceil(Math.cbrt(n)));
      const layers = Math.max(2, Math.ceil(n / (side * side)));
      let made = 0;
      for (let l = 0; l < layers && made < n; l++) {
        for (let j = 0; j < side && made < n; j++) {
          for (let i = 0; i < side && made < n; i++, made++) {
            b.box(
              [(i - (side - 1) / 2) * 1.01, 0.5 + l * 1.01, (j - (side - 1) / 2) * 1.01],
              [0.5, 0.5, 0.5],
              { friction: 0.6, restitution: 0.01 },
            );
          }
        }
      }
      b.extent = Math.max(12, side * 0.8);
      return b;
    },
  },

  {
    id: 'stress-long-chain',
    name: '长链条',
    group: '极端工况',
    description:
      '上百节的链条从高处垂下。**约束链的误差会累积**：每一节的微小偏差都沿着链条放大，所以链尾的漂移量直接反映迭代精度。长链被拉伸变长也是最经典的约束软化现象。',
    defaultBodies: 100,
    maxBodies: 300,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(180, 1, 0, { friction: 0.9 });
      const n = Math.max(8, Math.min(240, ctx.bodies));
      const link = 0.36;
      const top = 26;
      const anchor = b.box([0, top + 0.4, 0], [0.5, 0.4, 0.5], { type: 'static', tag: 'anchor' });
      const half = link * 0.45;
      let prev = anchor.id;
      for (let i = 0; i < n; i++) {
        const seg = b.box([0, top - i * link, 0], [half, half, half], {
          friction: 0.4, restitution: 0.02, density: 600, tag: 'rod',
        });
        b.joint({
          id: `link${i}`, kind: 'spherical',
          bodyA: prev, bodyB: seg.id,
          anchorA: [0, i === 0 ? -0.4 : -half, 0], anchorB: [0, half, 0],
        });
        prev = seg.id;
      }
      b.extent = 34;
      return b;
    },
  },

  {
    id: 'stress-many-tiny',
    name: '超多微小球',
    group: '极端工况',
    description:
      '近千个半径 8 cm 的小球挤在浅盘里。**这是接触对数量的极限测试**：球越小越多，宽相位筛选与窄相位精算的开销占比就越明显。多数纯 JS 引擎在这个规模会掉到个位数帧率。',
    defaultBodies: 900,
    maxBodies: 2400,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(200, 1, 0, { friction: 0.7 });
      const r = 0.08;
      const gap = r * 2.1;
      const side = 6;
      // A shallow tray so the balls do not simply spread over the whole floor.
      for (const sx of [-1, 1]) {
        b.box([sx * side, 0.6, 0], [0.3, 0.6, side], { type: 'static', tag: 'wall' });
        b.box([0, 0.6, sx * side], [side, 0.6, 0.3], { type: 'static', tag: 'wall' });
      }
      const n = Math.max(40, ctx.bodies);
      const cols = Math.floor((side * 2) / gap);
      let placed = 0;
      for (let layer = 0; layer < 60 && placed < n; layer++) {
        for (let ix = 0; ix < cols && placed < n; ix++) {
          for (let iz = 0; iz < cols && placed < n; iz++) {
            b.sphere(
              [-side + r + ix * gap, r + 0.1 + layer * gap, -side + r + iz * gap],
              r,
              { friction: 0.5, restitution: 0.02, density: 800, tag: 'ball' },
            );
            placed++;
          }
        }
      }
      b.extent = 18;
      return b;
    },
  },

  {
    id: 'stress-slender-rod',
    name: '细长立杆',
    group: '极端工况',
    description:
      '高宽比 40:1 的细杆立在地上，顶端压着重物。**细长物体是惯量与稳定性的最差组合**：一点数值误差就会慢慢弯折，或者自己抖起来。它也是接触点位置精度最敏感的构型。',
    defaultBodies: 12,
    maxBodies: 60,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.95 });
      const count = Math.max(1, Math.min(8, Math.round(ctx.bodies / 2)));
      const h = 6;
      const radius = h / 20 / 2;   // 40:1 height to width
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const x = Math.cos(a) * 2.4;
        const z = Math.sin(a) * 2.4;
        b.cylinder([x, h / 2, z], radius, h / 2, {
          friction: 0.9, restitution: 0, density: 2000, angularDamping: 0.02,
        });
        b.box([x, h + 0.35, z], [0.28, 0.28, 0.28], {
          friction: 0.8, density: 6000, tag: 'shell',
        });
      }
      b.extent = 14;
      return b;
    },
  },
];
