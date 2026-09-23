import { SceneBuilder, heightfieldMesh, icosaPoints, rockPoints, rng } from './kit';
import type { Scenario } from './types';

export const SHAPE_SCENARIOS: Scenario[] = [
  {
    id: 'mixed-convex',
    name: '凸包混战',
    group: '碰撞形状',
    description: '全部是随机不规则凸包。窄相位只能走 GJK/EPA 通用路径，没有原始体快路径可以偷懒。',
    defaultBodies: 200,
    maxBodies: 1500,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.8 });
      const r = rng(ctx.seed || 101);
      const n = Math.max(10, ctx.bodies);
      const span = Math.sqrt(n) * 0.9;
      for (let i = 0; i < n; i++) {
        const size = 0.28 + r() * 0.3;
        // Stride 0.75: hulls reach 1.14*size (up to 0.66 m) and 0.55 left
        // 3 pairs interpenetrating.
        b.convex(
          [(r() - 0.5) * span, 0.75 + i * 0.75, (r() - 0.5) * span],
          rockPoints(size, r, 8 + Math.floor(r() * 8)),
          { friction: 0.6, restitution: 0.08, density: 800 },
        );
      }
      b.extent = Math.max(12, span * 0.9);
      return b;
    },
  },
  {
    id: 'shape-zoo',
    name: '形状动物园',
    group: '碰撞形状',
    description: '球、盒、胶囊、圆柱、圆锥、凸包混在一层里。一次性看出哪些引擎缺哪些原始体、近似得有多离谱。',
    defaultBodies: 140,
    maxBodies: 1000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.8 });
      const r = rng(ctx.seed || 111);
      const n = Math.max(6, ctx.bodies);
      const span = Math.sqrt(n) * 0.95;
      for (let i = 0; i < n; i++) {
        const p: [number, number, number] = [
          (r() - 0.5) * span,
          // Stride 0.9: the capsule (0.84 m tall) and cylinder were taller
          // than the old 0.62 stride and spawned intersecting their neighbours.
          0.7 + i * 0.9,
          (r() - 0.5) * span,
        ];
        switch (i % 6) {
          case 0: b.sphere(p, 0.3, { friction: 0.5, restitution: 0.2 }); break;
          case 1: b.box(p, [0.27, 0.27, 0.27], { friction: 0.55 }); break;
          case 2: b.capsule(p, 0.2, 0.22, { friction: 0.5, rotation: [0.2, 0, 0, 0.98] }); break;
          case 3: b.cylinder(p, 0.28, 0.26, { friction: 0.55 }); break;
          case 4: b.cone(p, 0.3, 0.32, { friction: 0.5 }); break;
          default: b.convex(p, icosaPoints(0.32), { friction: 0.5, density: 700 }); break;
        }
      }
      b.extent = Math.max(12, span * 0.95);
      return b;
    },
  },
  {
    id: 'compound-crates',
    name: '复合体货箱',
    group: '碰撞形状',
    description: '每个物体由多个子形状拼成（箱体 + 支脚 + 顶部凸包）。复合形状是引擎内部树状结构的效率测试。',
    defaultBodies: 90,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });
      const r = rng(ctx.seed || 121);
      const n = Math.max(4, ctx.bodies);
      const cols = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) {
        const x = ((i % cols) - (cols - 1) / 2) * 1.9;
        const z = (Math.floor(i / cols) - (cols - 1) / 2) * 1.9;
        const w = 0.5 + r() * 0.25;
        // The cylinder foot reaches down to -1.2w in body space; the old fixed
        // y = 0.8 buried it for w > 2/3 (2/3 of all crates). Spawn from the foot.
        const y = 1.2 * w + 0.01;
        b.compound(
          [x, y + Math.floor(i / (cols * cols)) * 1.7, z],
          [
            { shape: { kind: 'box', halfExtents: [w, w * 0.7, w] }, offset: [0, 0, 0] },
            { shape: { kind: 'sphere', radius: w * 0.35 }, offset: [0, w * 0.95, 0] },
            { shape: { kind: 'cylinder', radius: w * 0.18, halfHeight: w * 0.5 }, offset: [w * 0.7, -w * 0.7, 0] },
            { shape: { kind: 'box', halfExtents: [w * 0.9, 0.08, 0.12] }, offset: [-w * 0.2, -w * 0.78, 0] },
          ],
          { density: 600, friction: 0.65, restitution: 0.03 },
        );
      }
      b.extent = Math.max(11, cols * 1.5);
      return b;
    },
  },
  {
    id: 'trimesh-terrain',
    name: '三角网地形',
    group: '碰撞形状',
    description: '起伏的三角网格地形上滚落几何体。三角网是静态几何的必经之路，也是最慢的窄相位路径。',
    defaultBodies: 200,
    maxBodies: 1200,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      const size = 90;
      const seg = 24;
      const { vertices, indices } = heightfieldMesh(size, seg, (x, z) => {
        return (
          Math.sin(x * 0.13) * 1.6 +
          Math.cos(z * 0.11) * 1.4 +
          Math.sin((x + z) * 0.05) * 1.1
        );
      });
      b.trimesh([0, 0, 0], vertices, indices, { friction: 0.7, restitution: 0.05, tag: 'terrain' });
      const r = rng(ctx.seed || 131);
      const n = Math.max(10, ctx.bodies);
      for (let i = 0; i < n; i++) {
        const kind = i % 3;
        // Capped column: y = 14 + i*0.7 reached 153 m for n = 200, so two
        // thirds of the bodies were still in free fall when the window ended.
        const p: [number, number, number] = [
          (r() - 0.5) * 30,
          14 + (i % 12) * 1.2 + r() * 0.5,
          (r() - 0.5) * 30,
        ];
        if (kind === 0) b.sphere(p, 0.36, { friction: 0.45, restitution: 0.25 });
        else if (kind === 1) b.box(p, [0.32, 0.32, 0.32], { friction: 0.55, restitution: 0.05 });
        else b.cylinder(p, 0.3, 0.34, { friction: 0.5, restitution: 0.1 });
      }
      b.extent = 26;
      return b;
    },
  },
  {
    id: 'capsule-rain',
    name: '胶囊雨',
    group: '碰撞形状',
    description: '几百个胶囊从天而降。胶囊是角色控制器的标准碰撞体，也是许多引擎里唯一"非盒非球"的原始体。',
    defaultBodies: 300,
    maxBodies: 2000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.75 });
      const r = rng(ctx.seed || 141);
      const n = Math.max(10, ctx.bodies);
      const span = Math.sqrt(n) * 1.0;
      for (let i = 0; i < n; i++) {
        const rad = 0.16 + r() * 0.12;
        // y stratified by index: a capsule AABB is up to 1.0 m tall, and the
        // old uniform y in [2, 28] left 11-12 pairs overlapping at spawn.
        b.capsule(
          [(r() - 0.5) * span, 1.2 + (i % 24) * 1.15 + r() * 0.3, (r() - 0.5) * span],
          rad,
          rad * (1.2 + r() * 1.4),
          { friction: 0.6, restitution: 0.06, density: 900, angularDamping: 0.12 },
        );
      }
      b.extent = Math.max(13, span * 0.85);
      return b;
    },
  },
  {
    id: 'sensor-field',
    name: '传感器区域',
    group: '碰撞形状',
    description: '触发体（trigger / sensor）只检测不响应。支持与否直接决定这个引擎能不能做游戏逻辑，跑分里也单列。',
    defaultBodies: 160,
    maxBodies: 1000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.7 });
      b.box([0, 2.5, 0], [7, 2.5, 0.05], { type: 'static', sensor: true, tag: 'sensor' });
      const r = rng(ctx.seed || 151);
      const n = Math.max(10, ctx.bodies);
      for (let i = 0; i < n; i++) {
        b.sphere([(r() - 0.5) * 6, 6 + r() * 16 + i * 0.5, (r() - 0.5) * 22], 0.28, {
          friction: 0.5,
          restitution: 0.1,
          velocity: [0, 0, -1 - r() * 3],
        });
      }
      b.extent = 14;
      return b;
    },
  },

  {
    id: 'shape-zoo-hard',
    name: '硬骨头形状',
    group: '碰撞形状',
    description:
      '圆锥、凸包、三角网一起下落。这三个恰好是各引擎支持度最参差的地方——圆锥常被降级成圆柱或凸包，三角网在部分引擎里只支持静态。**哪些被悄悄近似了，看右栏「本场景 × 当前引擎」。**',
    defaultBodies: 48,
    maxBodies: 200,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });
      const rnd = rng(ctx.seed || 71);
      const n = Math.max(6, ctx.bodies);
      for (let i = 0; i < n; i++) {
        const x = (rnd() - 0.5) * 9;
        const z = (rnd() - 0.5) * 9;
        const y = 2 + (i / n) * 12;
        const kind = i % 3;
        if (kind === 0) {
          b.cone([x, y, z], 0.55, 0.8, { friction: 0.6, restitution: 0.03, tag: 'ball' });
        } else if (kind === 1) {
          b.convex([x, y, z], rockPoints(0.62, rnd, 14), { friction: 0.65, restitution: 0.02 });
        } else {
          const m = heightfieldMesh(1.2, 3, (mx, mz) => Math.sin(mx * 3) * Math.cos(mz * 3) * 0.16);
          b.trimesh([x, y, z], m.vertices, m.indices, { friction: 0.6, restitution: 0.05 });
        }
      }
      b.extent = 16;
      return b;
    },
  },

  {
    id: 'shape-shells',
    name: '薄壳堆叠',
    group: '碰撞形状',
    description:
      '厚度只有 6 cm 的板子叠成塔。**薄壳是深度求解的噩梦**：接触面积极小、法线容易翻转，不少求解器会让它们互相渗透或持续抖动。薄板的厚度精度也是各引擎差别最大的地方之一。',
    defaultBodies: 24,
    maxBodies: 120,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140, 1, 0, { friction: 0.9 });
      const n = Math.max(4, Math.min(60, ctx.bodies));
      for (let i = 0; i < n; i++) {
        b.box([0, 0.06 + i * 0.14, 0], [1.4, 0.03, 1.4], {
          friction: 0.75, restitution: 0, density: 2400,
        });
      }
      b.extent = 12;
      return b;
    },
  },

  {
    id: 'shape-slices',
    name: '薄片雨',
    group: '碰撞形状',
    description:
      '上百张薄片从高处飘落。薄片落地时常常**边角先触**，接触法线几乎贴着片平面——这是最容易触发穿透与抖动的姿态，也是检验休眠判定是否可靠的好场景。',
    defaultBodies: 140,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(180, 1, 0, { friction: 0.85 });
      const rnd = rng(ctx.seed || 83);
      const n = Math.max(12, ctx.bodies);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const rad = rnd() * 5;
        b.box(
          [Math.cos(a) * rad, 3 + (i / n) * 14, Math.sin(a) * rad],
          [0.5, 0.02, 0.5],
          {
            rotation: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1],
            friction: 0.7, restitution: 0, density: 1200, angularDamping: 0.1,
          },
        );
      }
      b.extent = 16;
      return b;
    },
  },
];
