import { SceneBuilder, rng } from './kit';
import type { Vec3, Quat } from '../core/types';
import type { Scenario } from './types';

/**
 * One articulated humanoid made of capsules.
 *
 * The rig is described in RIG-LOCAL coordinates and converted per body. Joint
 * anchors in this IR are body-local offsets, and for a rig whose bodies all
 * share one yaw the conversion is just `anchor - bodyCentre`: the rotation
 * cancels, which keeps the numbers readable.
 *
 * The first version of this passed world positions as anchors. Rapier accepted
 * them and merely looked wrong; Bullet diverged to NaN on every body.
 */
function ragdoll(b: SceneBuilder, ox: number, oz: number, yaw = 0) {
  const density = 600; // light plastic-ish
  const s = Math.sin(yaw / 2);
  const c = Math.cos(yaw / 2);
  const rot: Quat = [0, s, 0, c];

  /** Rig-local point -> world position. */
  const toWorld = (p: Vec3): Vec3 => [
    ox + p[0] * c + p[2] * s,
    p[1],
    oz - p[0] * s + p[2] * c,
  ];
  const sub = (a: Vec3, from: Vec3): Vec3 => [a[0] - from[0], a[1] - from[1], a[2] - from[2]];

  // Rig landmarks, in rig-local space (x = left/right, y = height, z = forward).
  // Landmark spacing accounts for capsule volumes (halfHeight + radius): the
  // previous table had every parent/child pair spawning interpenetrating
  // (torso/hips alone overlapped by 0.31 m, more than the torso radius), so the
  // rig started with contact forces fighting its joints.
  const P = {
    hips: [0, 2.16, 0] as Vec3,
    torso: [0, 3.15, 0] as Vec3,
    head: [0, 3.95, 0] as Vec3,
    hipL: [-0.2, 1.75, 0] as Vec3,
    hipR: [0.2, 1.75, 0] as Vec3,
    thighL: [-0.2, 1.33, 0] as Vec3,
    thighR: [0.2, 1.33, 0] as Vec3,
    kneeL: [-0.2, 0.905, 0] as Vec3,
    kneeR: [0.2, 0.905, 0] as Vec3,
    shinL: [-0.2, 0.5, 0] as Vec3,
    shinR: [0.2, 0.5, 0] as Vec3,
    shoulderL: [-0.3, 3.0, 0] as Vec3,
    shoulderR: [0.3, 3.0, 0] as Vec3,
    upperArmL: [-0.4, 3.0, 0] as Vec3,
    upperArmR: [0.4, 3.0, 0] as Vec3,
    elbowL: [-0.4, 2.65, 0] as Vec3,
    elbowR: [0.4, 2.65, 0] as Vec3,
    foreArmL: [-0.4, 2.3, 0] as Vec3,
    foreArmR: [0.4, 2.3, 0] as Vec3,
    spine: [0, 2.565, 0] as Vec3,
    neck: [0, 3.72, 0] as Vec3,
  };

  const parts: string[] = [];

  const hips = b.capsule(toWorld(P.hips), 0.19, 0.2, { density, rotation: rot, friction: 0.7, angularDamping: 0.25 });
  const torso = b.capsule(toWorld(P.torso), 0.22, 0.35, { density, rotation: rot, friction: 0.7, angularDamping: 0.25 });
  const head = b.sphere(toWorld(P.head), 0.22, { density, friction: 0.6, angularDamping: 0.3 });
  parts.push(hips.id, torso.id, head.id);

  for (const side of [-1, 1] as const) {
    const upper = side < 0 ? P.upperArmL : P.upperArmR;
    const fore = side < 0 ? P.foreArmL : P.foreArmR;
    const elbow = side < 0 ? P.elbowL : P.elbowR;
    const shoulder = side < 0 ? P.shoulderL : P.shoulderR;

    const upperArm = b.capsule(toWorld(upper), 0.13, 0.22, { density, rotation: rot, friction: 0.7, angularDamping: 0.25 });
    const foreArm = b.capsule(toWorld(fore), 0.12, 0.22, { density, rotation: rot, friction: 0.7, angularDamping: 0.25 });
    parts.push(upperArm.id, foreArm.id);

    b.joint({
      id: `${torso.id}-shoulder${side}`, kind: 'spherical',
      bodyA: torso.id, bodyB: upperArm.id,
      anchorA: sub(shoulder, P.torso), anchorB: sub(shoulder, upper),
    });
    b.joint({
      id: `${upperArm.id}-elbow`, kind: 'revolute',
      bodyA: upperArm.id, bodyB: foreArm.id,
      anchorA: sub(elbow, upper), anchorB: sub(elbow, fore),
      axis: [1, 0, 0], limits: [0.05, 2.4],
    });
  }

  for (const side of [-1, 1] as const) {
    const hip = side < 0 ? P.hipL : P.hipR;
    const thigh = side < 0 ? P.thighL : P.thighR;
    const knee = side < 0 ? P.kneeL : P.kneeR;
    const shin = side < 0 ? P.shinL : P.shinR;

    const upperLeg = b.capsule(toWorld(thigh), 0.15, 0.25, { density, rotation: rot, friction: 0.8, angularDamping: 0.25 });
    const lowerLeg = b.capsule(toWorld(shin), 0.13, 0.25, { density, rotation: rot, friction: 0.8, angularDamping: 0.25 });
    parts.push(upperLeg.id, lowerLeg.id);

    b.joint({
      id: `${hips.id}-hip${side}`, kind: 'spherical',
      bodyA: hips.id, bodyB: upperLeg.id,
      anchorA: sub(hip, P.hips), anchorB: sub(hip, thigh),
    });
    b.joint({
      id: `${upperLeg.id}-knee`, kind: 'revolute',
      bodyA: upperLeg.id, bodyB: lowerLeg.id,
      anchorA: sub(knee, thigh), anchorB: sub(knee, shin),
      axis: [1, 0, 0], limits: [0, 2.2],
    });
  }

  b.joint({
    id: `${hips.id}-spine`, kind: 'spherical',
    bodyA: hips.id, bodyB: torso.id,
    anchorA: sub(P.spine, P.hips), anchorB: sub(P.spine, P.torso),
  });
  b.joint({
    id: `${torso.id}-neck`, kind: 'spherical',
    bodyA: torso.id, bodyB: head.id,
    anchorA: sub(P.neck, P.torso), anchorB: sub(P.neck, P.head),
  });

  return parts;
}

export const JOINT_SCENARIOS: Scenario[] = [
  {
    id: 'chain-hinge',
    name: '铰链链',
    group: '约束与关节',
    description: '一长串球形铰链。约束求解器的迭代次数在这里被直接量化：迭代少的会明显拉伸。',
    defaultBodies: 40,
    maxBodies: 400,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const n = Math.max(4, ctx.bodies);
      const link = 0.6;
      let prev = b.box([0, 8, 0], [0.15, 0.15, 0.15], { type: 'static', tag: 'anchor' });
      for (let i = 0; i < n; i++) {
        const cur = b.sphere([link * (i + 1), 8, 0], 0.17, { density: 2000, friction: 0.4, ccd: true });
        b.joint({
          id: `link-${i}`, kind: 'spherical',
          bodyA: prev.id, bodyB: cur.id,
          anchorA: [link / 2, 0, 0], anchorB: [-link / 2, 0, 0],
        });
        prev = cur;
      }
      b.extent = Math.max(12, n * 0.7);
      return b;
    },
  },
  {
    id: 'rope-bridge',
    name: '绳桥',
    group: '约束与关节',
    description: '两端固定的悬索桥再加桥面板。长约束链 + 二次接触，是约束求解器和接触求解器互相干扰的典型。',
    defaultBodies: 70,
    maxBodies: 500,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160);
      const span = 24;
      const n = Math.max(8, Math.min(64, Math.round(ctx.bodies / 4)));
      const dx = span / n;
      // Cable joint points follow the sag curve; planks are laid BETWEEN
      // consecutive points and tilted to match. The previous version placed
      // flat planks, never jointed the far anchor, swapped the first link's
      // anchors (0.68 m apart), and ignored the sag in every anchor and
      // restLength (up to 0.24 m of misalignment per link).
      const pts: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push([-span / 2 + span * t, 6.5 - Math.sin(t * Math.PI) * 1.4]);
      }
      const zDeck = -2.2;
      const zcA = -1.4; // local z of the main cable (zDeck - 1.4)
      const zcB = 1.4;  // local z of the brace cable (zDeck + 1.4)
      const leftAnchor = b.box([pts[0][0], pts[0][1], zDeck], [0.2, 0.2, 0.2], { type: 'static', tag: 'anchor' });
      const centres: [number, number][] = [];
      const plankIds: string[] = [];
      let prevId = leftAnchor.id;
      for (let i = 0; i < n; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const ang = Math.atan2(y1 - y0, x1 - x0);
        const quat: [number, number, number, number] = [0, 0, Math.sin(ang / 2), Math.cos(ang / 2)];
        const plank = b.box([cx, cy, zDeck], [dx * 0.5, 0.12, 1.6], {
          density: 900, friction: 0.7, rotation: quat,
        });
        centres.push([cx, cy]);
        plankIds.push(plank.id);
        // Both ends of the link sit exactly on the sag curve, so no joint (and
        // no distance rest-length) starts violated.
        b.joint({
          id: `cable-${i}`, kind: 'spherical',
          bodyA: prevId, bodyB: plank.id,
          anchorA: i === 0 ? [0, 0, 0] : [dx * 0.5, 0, zcA],
          anchorB: [-dx * 0.5, 0, zcA],
        });
        prevId = plank.id;
      }
      const rightAnchor = b.box([pts[n][0], pts[n][1], zDeck], [0.2, 0.2, 0.2], { type: 'static', tag: 'anchor' });
      b.joint({
        id: `cable-${n}`, kind: 'spherical',
        bodyA: prevId, bodyB: rightAnchor.id,
        anchorA: [dx * 0.5, 0, zcA], anchorB: [0, 0, 0],
      });
      // Second cable at the other rail: a distance constraint between
      // consecutive plank CENTRES (offset to the far rail), sized from the
      // actual build-time separation. It makes the deck torsionally stiff.
      for (let i = 1; i < plankIds.length; i++) {
        const [ax, ay] = centres[i - 1];
        const [bx, by] = centres[i];
        b.joint({
          id: `brace-${i}`, kind: 'distance',
          bodyA: plankIds[i - 1], bodyB: plankIds[i],
          anchorA: [0, 0, zcB], anchorB: [0, 0, zcB],
          restLength: Math.hypot(bx - ax, by - ay),
        });
      }
      const r = rng(ctx.seed || 31);
      const load = Math.max(2, Math.floor(ctx.bodies / 12));
      for (let i = 0; i < load; i++) {
        const pi = Math.floor(r() * plankIds.length);
        const p = b.bodies.find((x) => x.id === plankIds[pi])!;
        b.box([p.position[0], p.position[1] + 0.6 + (i % 3) * 0.55, p.position[2] + (r() - 0.5) * 1.6], [0.26, 0.26, 0.26], {
          density: 700, friction: 0.6,
        });
      }
      b.extent = 18;
      return b;
    },
  },
  {
    id: 'ragdoll',
    name: '布娃娃群',
    group: '约束与关节',
    description: '每具 10 个刚体 + 10 个关节的铰接人形。关节数量与刚体数同量级时，约束求解器的效率就是全部。',
    defaultBodies: 100,
    maxBodies: 600,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(140, 1, 0, { friction: 0.8 });
      const r = rng(ctx.seed || 17);
      const per = 10;
      const count = Math.max(1, Math.min(50, Math.round(ctx.bodies / per)));
      const cols = Math.ceil(Math.sqrt(count));
      for (let i = 0; i < count; i++) {
        const x = ((i % cols) - (cols - 1) / 2) * 3.2;
        const z = (Math.floor(i / cols) - (cols - 1) / 2) * 3.2;
        ragdoll(b, x, z, r() * Math.PI * 2);
      }
      b.extent = Math.max(12, cols * 3.4);
      return b;
    },
  },
  {
    id: 'hanging-tower',
    name: '悬挂塔',
    group: '约束与关节',
    description: '一串用固定关节硬连起来的方块，从高处摆动。检验固定关节（fixed joint）是否真的一点不软。',
    defaultBodies: 40,
    maxBodies: 300,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const n = Math.max(3, ctx.bodies);
      // Anchor height follows the chain length: the old fixed x = n*0.35 for
      // EVERY box put the whole chain 13 m sideways of its own joint (13.35 m
      // first-link violation) and buried boxes i >= 23 in the ground.
      const top = 3 + n * 0.62;
      const upper = b.box([0, top, 0], [0.2, 0.2, 0.2], { type: 'static', tag: 'anchor' });
      let prev = upper;
      for (let i = 0; i < n; i++) {
        const y = top - (i + 1) * 0.62;
        const cur = b.box([0, y, 0], [0.3, 0.3, 0.3], { density: 1500, friction: 0.5 });
        b.joint({
          id: `rigid-${i}`, kind: 'fixed',
          bodyA: prev.id, bodyB: cur.id,
          // Anchor points on the shared face between the two links.
          anchorA: [0, -0.31, 0], anchorB: [0, 0.31, 0],
        });
        prev = cur;
      }
      b.extent = Math.max(12, n * 0.7);
      return b;
    },
  },
  {
    id: 'slider-crank',
    name: '曲柄滑块机构',
    group: '约束与关节',
    description: '棱柱（prismatic）+ 转动关节混合闭环。闭环约束是很多求解器最容易出错的形态。',
    defaultBodies: 20,
    maxBodies: 120,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const count = Math.max(1, Math.min(8, Math.round(ctx.bodies / 4)));
      const yMech = 2.3;   // moving parts, clear of the rail slab (top = 2.1)
      const ySlider = 2.42; // slider is tall enough to hit the slab at 2.3
      for (let c = 0; c < count; c++) {
        const ox = (c - (count - 1) / 2) * 6;
        const base = b.box([ox, 2.0, 0], [3.4, 0.1, 0.6], { type: 'static', tag: 'rail' });
        // Geometry laid out so every joint's two anchors coincide in world
        // space at t = 0. The previous version spawned the crank and rod
        // entirely INSIDE the static rail slab and put the pivots 0.8 m apart.
        const crank = b.box([ox - 1.5, yMech, 0], [0.8, 0.1, 0.14], { density: 1200, friction: 0.4, tag: 'crank' });
        const rod = b.box([ox + 0.3, yMech, 0], [1.0, 0.1, 0.14], { density: 900, friction: 0.4, tag: 'rod' });
        const slider = b.box([ox + 1.3, ySlider, 0], [0.4, 0.32, 0.32], { density: 2000, friction: 0.5, tag: 'slider' });
        // Single revolute carrying the motor (the old scene declared the same
        // joint twice, once with the motor, over-constraining the pair).
        b.joint({
          id: `crank-pivot-${c}`, kind: 'revolute',
          bodyA: base.id, bodyB: crank.id, anchorA: [-1.5, 0.3, 0], anchorB: [0, 0, 0],
          axis: [0, 0, 1],
          motor: { targetVelocity: 6, maxForce: 40000 },
        });
        b.joint({
          id: `crank-rod-${c}`, kind: 'revolute',
          bodyA: crank.id, bodyB: rod.id, anchorA: [0.8, 0, 0], anchorB: [-1.0, 0, 0],
          axis: [0, 0, 1],
        });
        b.joint({
          id: `rod-slider-${c}`, kind: 'revolute',
          bodyA: rod.id, bodyB: slider.id,
          anchorA: [1.0, 0, 0], anchorB: [0, yMech - ySlider, 0],
          axis: [0, 0, 1],
        });
        b.joint({
          id: `slider-rail-${c}`, kind: 'prismatic',
          bodyA: base.id, bodyB: slider.id,
          anchorA: [1.3, ySlider - 2.0, 0], anchorB: [0, 0, 0],
          axis: [1, 0, 0], limits: [-3, 3],
        });
      }
      b.extent = 14;
      return b;
    },
  },
  {
    id: 'motor-wheel',
    name: '电机车轮',
    group: '约束与关节',
    description: '带角速度电机的轮子。约束里的电机（motor）实现质量差别很大，是"能不能做载具"的分水岭。',
    defaultBodies: 24,
    maxBodies: 160,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.95 });
      const count = Math.max(1, Math.min(8, Math.round(ctx.bodies / 3)));
      for (let c = 0; c < count; c++) {
        const ox = (c - (count - 1) / 2) * 2.4;
        const chassis = b.box([ox, 1.4, 0], [0.9, 0.18, 0.5], { density: 700, friction: 0.6, tag: 'chassis' });
        for (const side of [-1, 1]) {
          // Wheels clear of the chassis half-depth (0.5 + 0.1 + gap).
          const wheel = b.cylinder([ox, 1.0, side * 0.65], 0.42, 0.1, {
            density: 2000,
            friction: 1.2,
            rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            tag: 'wheel',
          });
          b.joint({
            id: `axle-${c}-${side}`, kind: 'revolute',
            bodyA: chassis.id, bodyB: wheel.id,
            anchorA: [0, -0.4, side * 0.65], anchorB: [0, 0, 0],
            // The axle is Z: the wheel cylinders are X-rotated so their axis is
            // world Z. Axis [1,0,0] made the motor spin them about the travel
            // direction instead of rolling.
            axis: [0, 0, 1],
            motor: { targetVelocity: -14, maxForce: 8000 },
          });
        }
      }
      b.extent = 14;
      return b;
    },
  },
  {
    id: 'spring-net',
    name: '弹簧网格',
    group: '约束与关节',
    description: '用距离约束织成的刚性距离网格。约束链的迭代收敛差异会表现为网格的拉伸与抖动。',
    defaultBodies: 120,
    maxBodies: 900,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120);
      const side = Math.max(3, Math.min(20, Math.round(Math.sqrt(ctx.bodies))));
      const step = 0.6;
      const ids: string[][] = [];
      for (let j = 0; j < side; j++) {
        ids.push([]);
        for (let i = 0; i < side; i++) {
          const fixed = j === 0;
          const body = b.sphere(
            [(i - (side - 1) / 2) * step, 8 - j * step * 0.15, j * step],
            0.13,
            { density: 500, friction: 0.4, type: fixed ? 'static' : 'dynamic', tag: fixed ? 'pinned' : 'cloth' },
          );
          ids[j].push(body.id);
        }
      }
      const link = (a: string, bId: string, i: number, j: number, di: number, dj: number) => {
        b.joint({
          id: `spring-${i}-${j}-${di}-${dj}`, kind: 'distance',
          bodyA: a, bodyB: bId,
          anchorA: [0, 0, 0], anchorB: [0, 0, 0],
          restLength: step * Math.hypot(di, dj),
        });
      };
      for (let j = 0; j < side; j++) {
        for (let i = 0; i < side; i++) {
          if (i + 1 < side) link(ids[j][i], ids[j][i + 1], i, j, 1, 0);
          if (j + 1 < side) link(ids[j][i], ids[j + 1][i], i, j, 0, 1);
          if (i + 1 < side && j + 1 < side) link(ids[j][i], ids[j + 1][i + 1], i, j, 1, 1);
        }
      }
      const r = rng(ctx.seed || 41);
      // Drop the load over the cloth's middle: the old z = side*0.6 + 1 put it
      // 1.12 m past the far edge, so it always fell through empty space.
      const netZ = ((side - 1) / 2) * step;
      for (let i = 0; i < Math.max(1, Math.floor(ctx.bodies / 40)); i++) {
        b.sphere([(r() - 0.5) * side * 0.5, 12 + i * 1.2, netZ + (r() - 0.5) * 1.5], 0.35, { density: 3000, friction: 0.5 });
      }
      b.extent = Math.max(10, side * 0.8);
      return b;
    },
  },

  {
    id: 'crane',
    name: '塔吊',
    group: '约束与关节',
    description:
      '塔身 → 转台 → 吊臂 → 吊索 → 重物，四级串联。**链越长误差越会累积**：吊物最终摆多大幅度、多久停下，直接反映各引擎约束求解的精度与阻尼建模。',
    defaultBodies: 12,
    maxBodies: 40,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(180, 1, 0, { friction: 0.9 });
      const towerH = 13;

      const tower = b.box([0, towerH / 2, 0], [0.7, towerH / 2, 0.7], { type: 'static', tag: 'wall' });
      const slew = b.box([0, towerH + 0.35, 0], [1.1, 0.35, 1.1], {
        friction: 0.4, density: 4000, tag: 'chassis',
      });
      b.joint({
        id: 'slew-joint', kind: 'revolute',
        bodyA: tower.id, bodyB: slew.id,
        anchorA: [0, towerH + 0.35, 0], anchorB: [0, 0, 0],
        axis: [0, 1, 0],
      });

      const mastY = towerH + 0.7;
      // Jib: a long beam pivoting on the turntable, counterweighted.
      const jib = b.box([4.5, mastY + 0.35, 0], [4.5, 0.35, 0.5], {
        friction: 0.5, density: 2200, tag: 'rod',
      });
      b.joint({
        id: 'jib-joint', kind: 'revolute',
        bodyA: slew.id, bodyB: jib.id,
        anchorA: [0, 0.35, 0], anchorB: [-4.5, 0, 0],
        axis: [0, 1, 0],
      });
      b.box([-0.9, mastY + 0.35, 0], [0.9, 0.5, 0.5], {
        friction: 0.5, density: 9000, tag: 'pusher',
      });

      // Slung load on a distance constraint - the part that swings.
      const load = b.box([8.4, mastY - 3.6, 0], [0.6, 0.6, 0.6], {
        friction: 0.5, density: 6000, tag: 'shell',
      });
      b.joint({
        id: 'cable', kind: 'distance',
        bodyA: jib.id, bodyB: load.id,
        anchorA: [4.2, 0, 0], anchorB: [0, 0.6, 0],
        restLength: 3.4, stiffness: 1, damping: 0.15,
      });

      b.extent = 22;
      return b;
    },
  },

  {
    id: 'piston-bank',
    name: '四缸活塞',
    group: '约束与关节',
    description:
      '四个曲柄滑块机构并联，共用同一根曲轴。**关节数量对求解器是线性到平方级的压力**：这里的重点不是单缸能不能动，而是四缸同时运动时约束之间会不会互相打架。',
    defaultBodies: 16,
    maxBodies: 48,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = [0, 0, 0];
      b.ground(120, 1, -6, { friction: 0.8 });

      const spacing = 1.6;
      const n = Math.max(1, Math.min(6, Math.round(ctx.bodies / 4)));
      for (let i = 0; i < n; i++) {
        const z = (i - (n - 1) / 2) * spacing;
        // Crank disc, pinned to the world, spun by a motor.
        const crank = b.cylinder([0, 3, z], 0.7, 0.18, {
          rotation: [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)],
          density: 4000, tag: 'wheel', friction: 0.3,
        });
        const anchor = b.box([0, 3, z], [0.16, 0.16, 0.16], { type: 'static', tag: 'pivot' });
        b.joint({
          id: `crank${i}`, kind: 'revolute',
          bodyA: anchor.id, bodyB: crank.id,
          anchorA: [0, 0, 0], anchorB: [0, 0, 0],
          axis: [0, 0, 1],
          motor: { targetVelocity: 6, maxForce: 4000 },
        });
        // Connecting rod from the crank pin to the piston.
        const rod = b.box([1.5, 3, z], [1.5, 0.14, 0.14], {
          friction: 0.4, density: 1800, tag: 'rod',
        });
        b.joint({
          id: `rod${i}`, kind: 'revolute',
          bodyA: crank.id, bodyB: rod.id,
          anchorA: [0.62, 0, 0], anchorB: [-1.5, 0, 0],
          axis: [0, 0, 1],
        });
        // Cylinder that the piston slides in (visual + guidance).
        b.box([4.4, 3, z], [1.4, 0.5, 0.5], { type: 'static', tag: 'wall', friction: 0.1 });
        const piston = b.box([3.6, 3, z], [0.45, 0.42, 0.42], {
          friction: 0.08, density: 2600, tag: 'slider',
        });
        b.joint({
          id: `pin${i}`, kind: 'prismatic',
          bodyA: piston.id, bodyB: rod.id,
          anchorA: [0, 0, 0], anchorB: [1.5, 0, 0],
          axis: [1, 0, 0],
          limits: [-1.2, 1.2],
        });
      }
      b.extent = 16;
      return b;
    },
  },

  {
    id: 'suspension-span',
    name: '悬索桥',
    group: '约束与关节',
    description:
      '主缆由距离关节串成，垂着若干吊索拉住桥面。**载荷会沿整条缆重分布**——放了重物之后桥面下沉多少、主缆形状怎么变，是约束刚度与迭代次数共同作用的结果。',
    defaultBodies: 46,
    maxBodies: 120,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(200, 1, 0, { friction: 0.85 });
      const span = 24;
      const towers = [-span / 2, span / 2];
      const topY = 11;
      for (const x of towers) {
        b.box([x, topY / 2, 0], [0.5, topY / 2, 3], { type: 'static', tag: 'wall' });
      }
      // Main cable: a chain of links sagging between the two towers.
      const links = Math.max(8, Math.min(28, Math.round(ctx.bodies / 2)));
      let prev: string | null = null;
      const cableY = (t: number) => topY + 0.4 - Math.sin(t * Math.PI) * 3.2;
      const cableIds: string[] = [];
      for (let i = 0; i <= links; i++) {
        const t = i / links;
        const x = towers[0] + t * span;
        const seg = b.box([x, cableY(t), 0], [span / links / 2 + 0.02, 0.14, 0.14], {
          friction: 0.6, density: 2400, tag: 'rod',
        });
        cableIds.push(seg.id);
        if (prev) {
          b.joint({
            id: `cable${i}`, kind: 'distance',
            bodyA: prev, bodyB: seg.id,
            anchorA: [span / links / 2, 0, 0], anchorB: [-span / links / 2, 0, 0],
            restLength: 0.05, stiffness: 1, damping: 0.3,
          });
        }
        prev = seg.id;
      }
      // Deck: a line of slabs hung off the cable by short distance constraints.
      const deckSegs = Math.max(6, Math.min(20, Math.round(ctx.bodies / 3)));
      const deckY = 4.2;
      let prevDeck: string | null = null;
      for (let i = 0; i < deckSegs; i++) {
        const x = towers[0] + 2 + (i / (deckSegs - 1)) * (span - 4);
        const slab = b.box([x, deckY, 0], [span / deckSegs / 2 - 0.05, 0.16, 2.2], {
          friction: 0.75, density: 3200, tag: 'platform',
        });
        const ci = Math.round((i / (deckSegs - 1)) * links);
        b.joint({
          id: `hanger${i}`, kind: 'distance',
          bodyA: cableIds[Math.min(links, ci)], bodyB: slab.id,
          anchorA: [0, -0.14, 0], anchorB: [0, 0.16, 0],
          restLength: Math.max(0.4, cableY(ci / links) - deckY),
          stiffness: 1, damping: 0.2,
        });
        if (prevDeck) {
          b.joint({
            id: `deck${i}`, kind: 'distance',
            bodyA: prevDeck, bodyB: slab.id,
            anchorA: [span / deckSegs / 2, 0, 0], anchorB: [-span / deckSegs / 2, 0, 0],
            restLength: 0.05, stiffness: 1, damping: 0.3,
          });
        }
        prevDeck = slab.id;
      }
      // The load it has to carry.
      for (let i = 0; i < Math.max(1, Math.floor(ctx.bodies / 20)); i++) {
        b.box([(i - 0.5) * 2.2, deckY + 1.6, 0], [0.6, 0.6, 0.6], {
          density: 7000, friction: 0.6, tag: 'shell',
        });
      }
      b.extent = 30;
      return b;
    },
  },

  {
    id: 'ragdoll-pile',
    name: '布娃娃堆',
    group: '约束与关节',
    description:
      '六个布娃娃从同一高度落下、堆在一起。**关节软约束 + 大量自碰撞**是最难同时满足的两件事：拉不住就会散架，拉太紧就会穿透。堆叠之后的姿态稳定性是最好的判据。',
    defaultBodies: 60,
    maxBodies: 160,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });
      const count = Math.max(1, Math.min(10, Math.round(ctx.bodies / 10)));
      for (let d = 0; d < count; d++) {
        const a = (d / count) * Math.PI * 2;
        const cx = Math.cos(a) * 1.6;
        const cz = Math.sin(a) * 1.6;
        const y0 = 12 + d * 0.05;
        const torso = b.capsule([cx, y0 + 1.2, cz], 0.28, 0.55, {
          density: 900, friction: 0.6, tag: 'chassis',
        });
        const head = b.sphere([cx, y0 + 2.35, cz], 0.26, { density: 800, friction: 0.6, tag: 'ball' });
        b.joint({
          id: `neck${d}`, kind: 'spherical',
          bodyA: torso.id, bodyB: head.id,
          anchorA: [0, 0.55, 0], anchorB: [0, -0.26, 0],
        });
        for (const side of [-1, 1]) {
          const leg = b.capsule([cx + side * 0.34, y0, cz], 0.2, 0.5, {
            density: 800, friction: 0.6, tag: 'chassis',
          });
          b.joint({
            id: `hip${d}-${side}`, kind: 'spherical',
            bodyA: torso.id, bodyB: leg.id,
            anchorA: [side * 0.3, -0.55, 0], anchorB: [0, 0.5, 0],
          });
        }
      }
      b.extent = 18;
      return b;
    },
  },
];
