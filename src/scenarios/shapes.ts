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
];
