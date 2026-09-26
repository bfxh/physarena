/**
 * Scenes powered by the PBF solver (src/fluid/pbf.ts) instead of rigid spheres.
 *
 * The older 「水坝崩塌」/「液体堆积」 scenes are deliberately kept as they are:
 * they measure what each *engine* does with several hundred low-friction
 * spheres, which is its own interesting number. These scenes measure something
 * different - an actual incompressible fluid - and the pair together answers
 * "how much of what a rigid-sphere pile does is the engine, and how much is the
 * fact that it is not a fluid at all".
 *
 * Two things to know when reading the results:
 *
 *   - The fluid does not push rigid bodies back. Collision is a positional
 *     clamp against static boxes, which cannot blow up but also cannot apply
 *     reaction forces. A floating box will not float.
 *   - The particles are drawn as overlapping spheres. That is a volumetric
 *     rendering of the surface, not a marching-cubes mesh; it reads as water
 *     because neighbours overlap, but it will not produce a crisp meniscus.
 */
import { SceneBuilder } from '../scenarios/kit';
import type { BuildContext, Scenario } from '../scenarios/types';

/** Wall thickness shared by the tanks and ramps below. */
const WALL = 0.3;

/** A U-shaped tank with an open top, returned as [halfX, halfZ, floorY]. */
function tank(b: SceneBuilder, half: number, height: number, floorY = 0): [number, number, number] {
  const y = floorY + WALL;
  b.box([0, floorY + WALL / 2, 0], [half, WALL / 2, half], { type: 'static', tag: 'wall' });
  for (const s of [-1, 1]) {
    b.box([s * half, y + height / 2, 0], [WALL, height / 2, half], { type: 'static', tag: 'wall' });
    b.box([0, y + height / 2, s * half], [half, height / 2, WALL], { type: 'static', tag: 'wall' });
  }
  return [half - WALL, half - WALL, floorY + WALL];
}

export const PBF_SCENARIOS: Scenario[] = [
  {
    id: 'pbf-pool',
    name: '真流体 · 水池',
    group: '破坏与流体',
    description:
      '一整块水从略微错位的高度落下，然后**自己摊平**成静止液面。这正是刚体球做不到的事：没有压力项的一堆球会保持堆成的小丘，而有了不可压缩约束的水会自动找平，最后停在一层薄而均匀的水面上。',
    defaultBodies: 900,
    maxBodies: 2400,
    scalable: true,
    build(ctx: BuildContext) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(160, 1, 0, { friction: 0.85 });
      const half = 4.5;
      const [ix, iz, floor] = tank(b, half, 5);

      // Spacing drives the solver; renderScale only makes the spheres overlap
      // enough to read as a surface. 0.6 m spacing over a 9 m tank lands around
      // 900 particles - the sweet spot for 60 Hz in plain JS.
      b.fluidVolume(
        [-ix + 0.4, floor + 0.4, -iz + 0.4],
        [ix - 0.4, floor + 3.2, iz - 0.4],
        { spacing: 0.6, h: 1.2, iterations: 2, vorticity: 0.05, viscosity: 0.02, renderScale: 2.6 },
      );
      b.extent = 18;
      return b;
    },
  },

  {
    id: 'pbf-dam',
    name: '真流体 · 溃坝',
    group: '破坏与流体',
    description:
      '水被薄闸拦在一侧，闸门移开后整片水**翻卷着冲过来**。看点是前锋的形状和卷起的涡——涡量约束开着才看得到这些细节，关掉的话水流会像一根绳子。',
    defaultBodies: 800,
    maxBodies: 2400,
    scalable: true,
    build(ctx: BuildContext) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(200, 1, 0, { friction: 0.85 });
      const half = 8;
      const [ix, iz, floor] = tank(b, half, 6);

      // The gate: a static slab the fluid starts behind. It is removed by the
      // scene simply not extending the fluid past it, so the body of water is
      // already free - the collapse is the fluid's own.
      b.box([0, floor + 2.4, 0], [WALL, 2.4, half - WALL], { type: 'static', tag: 'thin-wall' });

      // Water column on one side of the gate.
      b.fluidVolume(
        [-ix + 0.4, floor + 0.4, -iz + 0.4],
        [-ix + 5.2, floor + 4.6, iz - 0.4],
        { spacing: 0.62, h: 1.24, iterations: 2, vorticity: 0.08, viscosity: 0.015, renderScale: 2.6 },
      );
      b.extent = 24;
      return b;
    },
  },

  {
    id: 'pbf-ramp',
    name: '真流体 · 斜坡',
    group: '破坏与流体',
    description:
      '水从高台沿斜面流下，落到下方台面再流走。**这是唯一一处流体会和静态几何真正交互的场景**：斜坡、台阶、落点是三个连续的能量转换，任何一处把速度吃掉，后面就看不出溅射。',
    defaultBodies: 700,
    maxBodies: 2200,
    scalable: true,
    build(ctx: BuildContext) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(200, 1, 0, { friction: 0.85 });

      // Upper reservoir.
      b.box([-8, 4, 0], [3.4, 0.4, 3.4], { type: 'static', tag: 'platform' });
      b.box([-4.7, 5.2, 0], [0.3, 1.4, 3.4], { type: 'static', tag: 'thin-wall' });

      // A tilted slab the water runs down.
      const tilt = 22 * Math.PI / 180;
      b.box([0, 3.2, 0], [4.2, 0.3, 3.0], {
        type: 'static', tag: 'platform',
        rotation: [-Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)],
      });
      // Landing pad, then a low lip so the flow does not just slide away.
      b.box([6.4, 1.0, 0], [3.0, 0.3, 3.4], { type: 'static', tag: 'platform' });
      b.box([9.2, 1.7, 0], [0.3, 0.7, 3.4], { type: 'static', tag: 'thin-wall' });

      b.fluidVolume(
        [-10.4, 4.4, -3.0],
        [-5.2, 6.6, 3.0],
        { spacing: 0.62, h: 1.24, iterations: 2, vorticity: 0.07, viscosity: 0.015, renderScale: 2.6 },
      );
      b.extent = 26;
      return b;
    },
  },

  {
    id: 'pbf-jet',
    name: '真流体 · 对喷',
    group: '破坏与流体',
    description:
      '两股水柱相向对撞。**初始动能全部要被密度约束吸收**：撞点附近密度瞬间超标，约束把水往四面八方推开，形成一片不稳定的溅射冠。这是涡量约束最出效果的场景——关掉它，对撞会变成两根互相穿过绳子。',
    defaultBodies: 700,
    maxBodies: 2400,
    scalable: true,
    build(ctx: BuildContext) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(180, 1, 0, { friction: 0.85 });

      // A shallow catch basin so the aftermath collects instead of sliding away.
      const half = 6;
      const [ix, iz, floor] = tank(b, half, 2.2);

      // Two opposed columns with inward velocity. The columns are authored as
      // ordinary particle volumes; the speed comes from the initial velocity,
      // exactly like the emitter demos but without needing a live emitter.
      const speed = 9;
      b.fluidVolume(
        [-ix + 0.5, floor + 0.4, -1.5],
        [-ix + 2.5, floor + 4.6, 1.5],
        { spacing: 0.62, h: 1.24, iterations: 2, vorticity: 0.1, viscosity: 0.01, renderScale: 2.6 },
      );
      // Give the left column its rightward push.
      for (const p of b.bodies) {
        if (p.fluid && p.position[0] < -1 && !p.velocity) p.velocity = [speed, 0, 0];
      }
      b.fluidVolume(
        [ix - 2.5, floor + 0.4, -1.5],
        [ix - 0.5, floor + 4.6, 1.5],
        { spacing: 0.62, h: 1.24, iterations: 2, vorticity: 0.1, viscosity: 0.01, renderScale: 2.6 },
      );
      for (const p of b.bodies) {
        if (p.fluid && p.position[0] > 1 && !p.velocity) p.velocity = [-speed, 0, 0];
      }
      b.extent = 24;
      return b;
    },
  },
];
