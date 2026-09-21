import type { ImportedModel } from '../ui/importer';
import { SceneBuilder, rng } from './kit';
import type { Scenario } from './types';

/**
 * Turns a user-supplied model (already reduced to a convex hull) into a proper
 * benchmark scenario: a shower of the models landing on a ground plane.
 *
 * Every engine consuming the same hull means the comparison stays meaningful
 * even though the shape is arbitrary.
 */
export function importedScenario(model: ImportedModel): Scenario {
  return {
    id: `import:${model.name}`,
    name: `导入模型 · ${model.name}`,
    group: '碰撞形状',
    description:
      `自定义模型凸包（${model.vertexCount} 个顶点，源模型 ${model.sourceTriangles} 个三角面）` +
      `从空中落下堆叠。想换物体只要重新拖入文件即可。`,
    defaultBodies: 60,
    maxBodies: 400,
    scalable: true,
    build(ctx) {
      const b = new SceneBuilder();
      b.gravity = ctx.gravity;
      b.ground(120, 1, 0, { friction: 0.85 });
      const r = rng(ctx.seed || 4242);
      const n = Math.max(4, ctx.bodies);
      const span = Math.sqrt(n) * 1.15;
      for (let i = 0; i < n; i++) {
        b.convex(
          [(r() - 0.5) * span, 3 + i * 1.5, (r() - 0.5) * span],
          model.points,
          {
            density: 900,
            friction: 0.6,
            restitution: 0.05,
            rotation: [0, Math.sin(r() * Math.PI), 0, Math.cos(r() * Math.PI)],
          },
        );
      }
      b.extent = Math.max(12, span * 0.95);
      return b;
    },
  };
}
