import { SceneBuilder, rng } from './kit';
import type { BuildContext, Scenario } from './types';

export const DYNAMICS_SCENARIOS: Scenario[] = [
  {
    id: 'domino',
    name: '多米诺',
    group: '经典动力学',
    description: '单排连锁倾倒。检验求解器在长时间接触序列里是否漏掉冲量——漏一次链就断。',
    defaultBodies: 150,
    maxBodies: 1500,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      const n = Math.max(8, ctx.bodies);
      // Ground sized from the row: at the max body count the outer dominoes
      // used to stand past the floor edge and fall out of the world.
      b.ground(Math.max(200, n * 0.7), 1, 0, { friction: 0.85 });
      const h = 0.6, t = 0.08;
      for (let i = 0; i < n; i++) {
        b.box([-n * 0.25 + i * 0.5, h, 0], [t, h, 0.32], { friction: 0.55, restitution: 0.02, angularDamping: 0.02 });
      }
      // the pusher
      b.box([-n * 0.25 - 0.55, h, 0], [0.25, 0.25, 0.25], { density: 4000, velocity: [3.2, 0, 0], friction: 0.6, tag: 'pusher' });
      b.extent = Math.max(12, n * 0.3);
      return b;
    },
  },
  {
    id: 'domino-spiral',
    name: '螺旋多米诺',
    group: '经典动力学',
    description: '沿螺旋线摆放的多米诺。转向处接触法线方向突变，是求解器摩擦方向处理的试金石。',
    defaultBodies: 180,
    maxBodies: 1200,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });
      const n = Math.max(16, ctx.bodies);
      const h = 0.55;
      // Arc-length spacing instead of a constant angle step. With a fixed
      // angular step the outer dominoes sat 2.9-14 m apart (their reach is
      // ~1.17 m), so the chain broke long before the end - and there was no
      // pusher at all, so nothing ever fell.
      const spacing = 0.75;
      const pts: [number, number][] = [];
      let t = 0;
      for (let i = 0; i < n; i++) {
        const r = 2.5 + (i / n) * 14;
        if (i > 0) t += spacing / Math.max(0.5, r);
        pts.push([Math.cos(t) * r, Math.sin(t) * r]);
        const yaw = -t + Math.PI / 2;
        const s = Math.sin(yaw / 2), c = Math.cos(yaw / 2);
        b.box([pts[i][0], h, pts[i][1]], [0.07, h, 0.3], {
          friction: 0.55,
          restitution: 0.02,
          rotation: [0, s, 0, c],
        });
      }
      // Pusher behind the first domino, along the chain tangent.
      const dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1];
      const len = Math.max(1e-6, Math.hypot(dx, dz));
      b.box(
        [pts[0][0] - (dx / len) * 0.7, h, pts[0][1] - (dz / len) * 0.7],
        [0.22, 0.22, 0.22],
        { density: 4000, velocity: [(dx / len) * 3.2, 0, (dz / len) * 3.2], friction: 0.6, tag: 'pusher' },
      );
      b.extent = 18;
      return b;
    },
  },
  {
    id: 'ramp-roll',
    name: '斜坡滚落',
    group: '经典动力学',
    description: '球、圆柱、盒子同时从斜坡滚下。滚动摩擦、角速度积分、休眠策略的差异会直接表现为落点不同。',
    defaultBodies: 60,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140);
      const ang = -Math.PI / 10;
      const s = Math.sin(ang / 2), c = Math.cos(ang / 2);
      const rot: [number, number, number, number] = [0, 0, s, c];
      b.box([0, 4.2, -6], [12, 0.3, 6], { type: 'static', rotation: rot, friction: 0.6, tag: 'ramp' });
      const r = rng(ctx.seed || 3);
      const n = Math.max(6, ctx.bodies);
      for (let i = 0; i < n; i++) {
        const lane = (i % 6) - 2.5;
        const row = Math.floor(i / 6);
        // Shift the shape assignment per row so shape and lane are not
        // perfectly correlated.
        const kind = (i + row) % 3;
        const p: [number, number, number] = [lane, 6.2 + row * 1.1, -8 + r() * 1.5];
        if (kind === 0) b.sphere(p, 0.45, { friction: 0.4, restitution: 0.15 });
        // Axle must be along Z for a slope that descends in X; the old
        // [0,0,sqrt1/2,sqrt1/2] pointed the cylinders down the slope.
        else if (kind === 1) b.cylinder(p, 0.45, 0.45, { friction: 0.4, restitution: 0.1, rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
        // tan(18 deg) = 0.325: 0.45 friction pinned the boxes on the slope.
        else b.box(p, [0.42, 0.42, 0.42], { friction: 0.22, restitution: 0.05 });
      }
      b.extent = 20;
      return b;
    },
  },
  {
    id: 'newton-cradle',
    name: '牛顿摆',
    group: '经典动力学',
    description: '球形摆链。多体冲量传递要求求解器迭代足够多次，迭代不足会看到能量凭空消失。',
    defaultBodies: 20,
    maxBodies: 120,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const n = Math.max(3, Math.min(24, ctx.bodies));
      const r = 0.4;
      const top = 4.0;
      // Pendulum length. The old spherical joint pinned the ball's anchor
      // point to the anchor cube's CENTRE, so every ball spawned 0.55 m away
      // from where its joint wanted it (1.69 m for the displaced ball) and the
      // first step was a constraint-violation correction, not a cradle.
      // A distance constraint with the ball's centre as the anchor is the
      // actual pendulum model.
      const L = 0.6;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * (r * 2 + 0.004);
        const anchor = b.box([x, top, 0], [0.06, 0.06, 0.06], { type: 'static', tag: 'anchor' });
        const dx = i === 0 ? -0.5 : 0;
        const dy = -Math.sqrt(Math.max(1e-6, L * L - dx * dx));
        const ball = b.sphere(
          [x + dx, top + dy, 0],
          r,
          { density: 8000, restitution: 0.98, friction: 0.1, ccd: true, tag: 'ball' },
        );
        b.joint({
          id: `cradle-${i}`,
          kind: 'distance',
          bodyA: anchor.id,
          bodyB: ball.id,
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: L,
        });
      }
      b.extent = Math.max(10, n * 0.6);
      return b;
    },
  },
  {
    id: 'spinning-tops',
    name: '陀螺群',
    group: '经典动力学',
    description: '高速自转的圆锥。角动量积分的稳定性、陀螺效应处理，各家差别巨大。',
    defaultBodies: 40,
    maxBodies: 300,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.5 });
      const r = rng(ctx.seed || 11);
      const n = Math.max(4, ctx.bodies);
      const cols = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) {
        const x = ((i % cols) - (cols - 1) / 2) * 2.4;
        const z = (Math.floor(i / cols) - (cols - 1) / 2) * 2.4;
        // Apex DOWN (rotation 1,0,0,0 = 180 deg about X): the old scene stood
        // the cones on their flat bases 0.3 m in the air, so nothing precessed.
        b.cone([x, 0.62, z], 0.45, 0.6, {
          density: 6000,
          friction: 0.35,
          angularDamping: 0.005,
          linearDamping: 0.005,
          angularVelocity: [0, 28, 0],
          rotation: [1, 0, 0, 0],
          tag: 'top',
        });
      }
      b.extent = Math.max(10, cols * 1.8);
      return b;
    },
  },
  {
    id: 'bouncy-balls',
    name: '弹力球雨',
    group: '经典动力学',
    description: '高回弹系数的球持续弹跳。恢复系数建模和能量衰减最直观的场景，跑久了能看出谁先把能量抹平。',
    defaultBodies: 200,
    maxBodies: 2000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { restitution: 0.92, friction: 0.3 });
      const r = rng(ctx.seed || 21);
      const n = Math.max(8, ctx.bodies);
      const span = Math.sqrt(n) * 0.85;
      for (let i = 0; i < n; i++) {
        const rad = 0.18 + r() * 0.22;
        b.sphere([(r() - 0.5) * span, 1 + r() * 26, (r() - 0.5) * span], rad, {
          restitution: 0.9,
          friction: 0.25,
          linearDamping: 0.005,
          density: 900,
        });
      }
      b.extent = Math.max(14, span * 0.8);
      return b;
    },
  },
  {
    id: 'ball-pit',
    name: '球坑',
    group: '经典动力学',
    description: '大量球堆在一个浅盆里。密集接触 + 高频休眠/唤醒切换，最费窄相位。',
    defaultBodies: 400,
    maxBodies: 3000,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      const R = Math.max(4, Math.cbrt(ctx.bodies) * 1.4);
      b.ground(160, 1, 0, { friction: 0.7 });
      const n4 = 4;
      for (let i = 0; i < n4; i++) {
        const a = (i / n4) * Math.PI * 2;
        // Walls must be tangent to the ring: a rotation about Y by a + pi/2.
        // The old quaternion rotated about X, which laid the 90/270 degree
        // walls flat as mid-air shelves and left the pit fenced on two sides.
        // Panels are also long enough to actually enclose it (~quarter arc).
        b.box([Math.cos(a) * R, 1.5, Math.sin(a) * R], [R * 0.75, 1.5, 0.4], {
          type: 'static',
          rotation: [0, Math.sin((a + Math.PI / 2) / 2), 0, Math.cos((a + Math.PI / 2) / 2)],
          tag: 'wall',
        });
      }
      const r = rng(ctx.seed || 5);
      const n = Math.max(20, ctx.bodies);
      // Jittered lattice instead of the old index-correlated drop: the 0.035 m
      // y stride put 29-35 sphere pairs in penetration at spawn.
      const side = Math.ceil(Math.cbrt(n));
      for (let i = 0; i < n; i++) {
        const ix = i % side;
        const iy = Math.floor(i / side) % side;
        const iz = Math.floor(i / (side * side));
        b.sphere(
          [
            (ix - (side - 1) / 2) * 0.7 + (r() - 0.5) * 0.04,
            0.4 + iy * 0.72,
            (iz - (side - 1) / 2) * 0.7 + (r() - 0.5) * 0.04,
          ],
          0.32,
          { friction: 0.45, restitution: 0.1, density: 800 },
        );
      }
      b.extent = Math.max(12, R * 1.9);
      return b;
    },
  },
  {
    id: 'free-fall-ladder',
    name: '阶梯下落',
    group: '经典动力学',
    description: '从不同高度同时释放。全部落地所需时间只由重力决定，是检验各引擎 dt 处理是否一致的最简基准。',
    defaultBodies: 80,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160);
      const n = Math.max(8, ctx.bodies);
      for (let i = 0; i < n; i++) {
        b.box([0, 3 + i * 1.6, (i % 8) * 1.1 - 4], [0.35, 0.35, 0.35], { friction: 0.4, restitution: 0.1 });
      }
      b.extent = 16;
      return b;
    },
  },
  {
    id: 'teeter-totter',
    name: '跷跷板平衡',
    group: '经典动力学',
    description: '一块自由转动的板，两端轻重悬殊。求解器的质量矩阵与迭代次数在这里会被无限放大。',
    defaultBodies: 30,
    maxBodies: 240,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140);
      const pivot = b.box([0, 0.85, 0], [0.25, 0.25, 0.25], { type: 'static', tag: 'pivot' });
      const plank = b.box([0, 1.38, 0], [5, 0.08, 1.2], { density: 1400, friction: 0.6, tag: 'plank' });
      b.joint({
        id: 'seesaw',
        kind: 'revolute',
        bodyA: pivot.id,
        bodyB: plank.id,
        anchorA: [0, 0, 0],
        // The plank centre sits 0.53 m above the pivot centre; without this
        // offset the joint demanded the two CENTRES coincide and yanked the
        // plank down into the pivot block.
        anchorB: [0, -0.53, 0],
        axis: [0, 0, 1],
        limits: [-0.7, 0.7],
      });
      const n = Math.max(1, Math.min(40, Math.floor(ctx.bodies / 4)));
      for (let i = 0; i < n; i++) {
        b.box([-4.4 + (i % 4) * 0.7, 2.6 + Math.floor(i / 4) * 0.65, (i % 3 - 1) * 0.7], [0.3, 0.3, 0.3], { density: 400, friction: 0.6 });
      }
      for (let i = 0; i < Math.min(n, 3); i++) {
        b.box([4.4, 2.2 + i * 0.65, 0], [0.3, 0.3, 0.3], { density: 12000, friction: 0.6 });
      }
      b.extent = 12;
      return b;
    },
  },
  {
    id: 'rotating-platform',
    name: '旋转平台',
    group: '经典动力学',
    description: '运动学（kinematic）平台上的散落盒子。考验引擎对 kinematic 体的速度推导和摩擦传递。',
    defaultBodies: 120,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140);
      // The platform must actually spin: without angularVelocity the scene was
      // a static disc under a pile of boxes and tested nothing about kinematic
      // velocity deduction.
      b.cylinder([0, 0.5, 0], 5, 0.5, {
        type: 'kinematic', friction: 0.9, tag: 'platform', angularVelocity: [0, 1.2, 0],
      });
      const r = rng(ctx.seed || 13);
      const n = Math.max(6, ctx.bodies);
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2;
        const rad = r() * 4.2;
        b.box([Math.cos(a) * rad, 1.6 + (i / n) * 8, Math.sin(a) * rad], [0.26, 0.26, 0.26], {
          friction: 0.6,
          restitution: 0.05,
        });
      }
      b.extent = 14;
      return b;
    },
  },

  {
    id: 'domino-circle',
    name: '环形多米诺',
    group: '经典动力学',
    description:
      '一圈多米诺向心倒。和直线多米诺不同的是，牌与牌之间是**斜向**接触——链式传播能不能绕回起点，取决于求解器对侧向力矩和摩擦锥的处理，直线多米诺测不到这一点。',
    defaultBodies: 60,
    maxBodies: 200,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140, 1, 0, { friction: 0.9 });
      const n = Math.max(12, Math.min(120, ctx.bodies));
      const radius = 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // Each tile faces along the tangent, so falling into the next one is
        // the only way the chain can propagate.
        const half = a / 2 + Math.PI / 4;
        b.box(
          [Math.cos(a) * radius, 1.1, Math.sin(a) * radius],
          [0.5, 1.0, 0.09],
          {
            rotation: [0, Math.sin(half), 0, Math.cos(half)],
            friction: 0.6,
            restitution: 0.01,
            density: 900,
          },
        );
      }
      b.sphere([radius + 2.2, 1.1, 0], 0.3, {
        density: 4000, velocity: [-10, 0, 0], tag: 'projectile',
      });
      b.extent = radius * 2.6;
      return b;
    },
  },

  {
    id: 'bowling-pins',
    name: '保龄球阵',
    group: '经典动力学',
    description:
      '十个瓶 + 一发重球。瓶是细长的圆柱、间距极小，倒下的瓶会**连锁碰撞**十来次——这是接触数在短时间内连续翻倍的场景，也是各引擎「碰撞后是否抖动」最容易看出来的地方。',
    defaultBodies: 40,
    maxBodies: 120,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140, 1, 0, { friction: 0.7 });
      // Standard ten-pin triangle, one lane.
      const rows = Math.max(2, Math.min(6, Math.round(ctx.bodies / 8)));
      const dx = 0.75;
      const dz = 0.9;
      let id = 0;
      for (let row = 0; row < rows; row++) {
        for (let k = 0; k <= row; k++) {
          b.cylinder(
            [(k - row / 2) * dx, 0.75, row * dz],
            0.22, 0.75,
            { friction: 0.5, restitution: 0.05, density: 700, tag: 'ball' },
          );
          id++;
        }
      }
      void id;
      b.sphere([0, 0.45, -3.2], 0.45, {
        density: 3000, friction: 0.4, restitution: 0.05,
        velocity: [0, 0, 11], tag: 'projectile',
      });
      b.extent = 12;
      return b;
    },
  },

  {
    id: 'avalanche',
    name: '雪崩',
    group: '经典动力学',
    description:
      '斜坡上密铺两百多个球，初始静止。给顶端一颗球一个侧向推力，整片就滑下来——**起始条件是亚稳的**，所以能不能滑坡、滑多远，完全取决于摩擦与接触求解的一致性。',
    defaultBodies: 260,
    maxBodies: 1500,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(200, 1, 0, { friction: 0.9 });
      // A 24-degree slope built from a long static slab.
      const slope = 24 * Math.PI / 180;
      b.box([0, 4, 0], [9, 0.4, 11], {
        type: 'static', rotation: [-Math.sin(slope / 2), 0, 0, Math.cos(slope / 2)],
        tag: 'platform', friction: 0.55,
      });
      const r = 0.32;
      const gap = r * 2.06;
      const n = Math.max(40, ctx.bodies);
      const cols = 9;
      let placed = 0;
      for (let layer = 0; layer < 12 && placed < n; layer++) {
        for (let ix = 0; ix < cols && placed < n; ix++) {
          for (let iz = 0; iz < cols && placed < n; iz++) {
            b.sphere(
              [(ix - (cols - 1) / 2) * gap, 5.4 + layer * gap, (iz - (cols - 1) / 2) * gap],
              r,
              { friction: 0.35, restitution: 0.02, density: 500, angularDamping: 0.2 },
            );
            placed++;
          }
        }
      }
      b.sphere([0, 8, -7], 0.5, {
        density: 5000, velocity: [0, 0, 12], tag: 'projectile',
      });
      b.extent = 26;
      return b;
    },
  },

  {
    id: 'carom',
    name: '撞球台',
    group: '经典动力学',
    description:
      '一张带边库的台面，十几颗球同时互相撞击。**球与球、球与库边的能量分配**是这里唯一要看的东西：恢复系数差 0.02，几秒后球的位置分布就完全不同。',
    defaultBodies: 18,
    maxBodies: 60,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.6 });
      const halfX = 5;
      const halfZ = 2.6;
      const r = 0.3;
      // Bed and four cushions.
      b.box([0, 0.4, 0], [halfX, 0.4, halfZ], { type: 'static', tag: 'platform', friction: 0.25 });
      b.box([-halfX - 0.2, 0.8, 0], [0.2, 0.4, halfZ + 0.2], { type: 'static', tag: 'wall', restitution: 0.9 });
      b.box([halfX + 0.2, 0.8, 0], [0.2, 0.4, halfZ + 0.2], { type: 'static', tag: 'wall', restitution: 0.9 });
      b.box([0, 0.8, -halfZ - 0.2], [halfX + 0.2, 0.4, 0.2], { type: 'static', tag: 'wall', restitution: 0.9 });
      b.box([0, 0.8, halfZ + 0.2], [halfX + 0.2, 0.4, 0.2], { type: 'static', tag: 'wall', restitution: 0.9 });

      const rnd = rng(ctx.seed || 29);
      const n = Math.max(4, Math.min(40, ctx.bodies));
      for (let i = 0; i < n; i++) {
        b.sphere(
          [(rnd() - 0.5) * halfX * 1.4, 0.8, (rnd() - 0.5) * halfZ * 1.4],
          r,
          {
            density: 1600, friction: 0.15, restitution: 0.92,
            linearDamping: 0.05, angularDamping: 0.2,
            velocity: [(rnd() - 0.5) * 8, 0, (rnd() - 0.5) * 8],
            tag: 'ball',
          },
        );
      }
      b.extent = 14;
      return b;
    },
  },
];
