import type { EngineMeta, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, quatToEulerDeg, quatOr, shapeVolume } from './shared';

export const meta: EngineMeta = {
  id: 'oimo',
  name: 'Oimo.js',
  language: 'JavaScript',
  backend: 'Pure JS',
  license: 'MIT',
  homepage: 'https://github.com/lo-th/Oimo.js',
  accent: '#7c8fa8',
  blurb: '十年前的老牌 JS 引擎，只认球/盒/圆柱。放在这里是作为"纯 JS 老一代"的性能基线。',
  solver: 'Sequential Impulse + 可选 BVH/SAP/暴力宽相位',
  status: 'stable',
  capabilities: {
    shapes: ['box', 'sphere', 'cylinder'],
    // oimo's jointDistance accepts the anchors but does not hold the bodies
    // (measured: 9.4 m of drift across 4 s), so it is not offered.
    joints: ['revolute', 'spherical', 'prismatic'],
    ccd: false,
    sensors: false,
    memoryReport: false,
  },
};

/** oimo's config vocabulary. Compound is not supported, so it degrades upstream. */
function oimoShape(shape: ShapeDesc): { type: string; size: number[] } {
  switch (shape.kind) {
    case 'box': return { type: 'box', size: [shape.halfExtents[0] * 2, shape.halfExtents[1] * 2, shape.halfExtents[2] * 2] };
    case 'sphere': return { type: 'sphere', size: [shape.radius] };
    case 'cylinder': return { type: 'cylinder', size: [shape.radius, shape.halfHeight * 2] };
    default: return { type: 'box', size: [0.5, 0.5, 0.5] };
  }
}

class OimoEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private O: any;
  private world: any;
  private bodies: any[] = [];
  private byId = new Map<string, any>();

  async init(): Promise<void> {
    // "oimo"'s package.json points `module` at the ES build, which is what Vite
    // resolves; the named exports (World, Vec3, ...) come from there.
    this.O = await import('oimo');
    if (!this.O.World) {
      throw new Error('oimo: 未找到 World 导出（module 构建未生效）');
    }
  }

  protected buildWorld(desc: WorldDesc): void {
    const O = this.O;
    this.world = new O.World({ timestep: 1 / 60, iterations: 10, broadphase: 2 });
    this.world.gravity.fromArray(desc.gravity);

    this.bodies = [];
    this.byId.clear();

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);
      const s = oimoShape(adapted.shape);
      const cfg: any = {
        type: s.type,
        size: s.size,
        pos: b.position,
        rot: quatToEulerDeg(b.rotation),
        move: b.type !== 'static',
        kinematic: b.type === 'kinematic',
        // oimo's body config is density-only (no `mass` key), so an explicit
        // IR mass is converted back to the equivalent density.
        density: b.mass != null
          ? b.mass / Math.max(1e-6, shapeVolume(adapted.shape))
          : (b.density ?? 1000),
        friction: b.friction ?? 0.5,
        restitution: b.restitution ?? 0.05,
        name: b.id,
        // Do NOT pass `sleep`. oimo merges unknown config keys onto the body
        // and `body.sleep` is a method - overwriting it with `true` breaks the
        // island sleep logic and freezes every body at its spawn position.
        neverSleep: false,
      };
      const body = this.world.add(cfg);
      if (b.type !== 'static') {
        if (b.velocity) body.linearVelocity.set(...b.velocity);
        if (b.angularVelocity) body.angularVelocity.set(...b.angularVelocity);
      }
      this.bodies.push(body);
      this.byId.set(b.id, body);
    }

    for (const j of desc.joints) {
      const A = this.byId.get(j.bodyA);
      const B = this.byId.get(j.bodyB);
      if (!A || !B) { this.markSkippedJoint(); continue; }
      const type =
        j.kind === 'revolute' ? 'jointHinge'
          : j.kind === 'spherical' ? 'jointBall'
            : j.kind === 'distance' || j.kind === 'spring' ? null
              : j.kind === 'prismatic' ? 'jointPrisme'
                : null;
      if (!type) { this.markSkippedJoint(); continue; }
      // oimo's World.add does `min = o.min || 57.29578`, so a legitimate 0
      // limit would be replaced by 1 rad (ragdoll knees became [1.0, 2.2]).
      // Map exact zeros to a tiny non-zero degree value.
      const toDeg = (r: number): number => {
        const d = (r * 180) / Math.PI;
        if (Math.abs(d) < 1e-4) return d < 0 ? -1e-4 : 1e-4;
        return d;
      };
      try {
        this.world.add({
          type,
          body1: A,
          body2: B,
          pos1: j.anchorA,
          pos2: j.anchorB,
          axe1: j.axis ?? [0, 1, 0],
          axe2: j.axis ?? [0, 1, 0],
          min: j.limits ? toDeg(j.limits[0]) : undefined,
          max: j.limits ? toDeg(j.limits[1]) : undefined,
          // Hinges take a motor ([targetVelocity, maxForce]); other kinds have
          // no limitMotor in this build.
          ...(j.kind === 'revolute' && j.motor
            ? { motor: [j.motor.targetVelocity, j.motor.maxForce] }
            : {}),
          collision: false,
        });
      } catch {
        this.markSkippedJoint();
      }
    }
  }

  protected stepWorld(dt: number): void {
    this.world.timeStep = dt;
    this.world.step();
  }

  protected syncStates(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const s = this.states[i];
      if (!s) continue;
      const p = b.position;
      const o = b.orientation;
      s.position[0] = p.x; s.position[1] = p.y; s.position[2] = p.z;
      s.rotation[0] = o.x; s.rotation[1] = o.y; s.rotation[2] = o.z; s.rotation[3] = o.w;
      const lv = b.linearVelocity, av = b.angularVelocity;
      s.linearVelocity![0] = lv.x; s.linearVelocity![1] = lv.y; s.linearVelocity![2] = lv.z;
      s.angularVelocity![0] = av.x; s.angularVelocity![1] = av.y; s.angularVelocity![2] = av.z;
      s.sleeping = !!b.sleeping;
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const b = this.bodies[index];
    if (b?.applyImpulse) b.applyImpulse(new this.O.Vec3(...impulse));
  }

  stats() {
    return { bodyCount: this.bodies.length };
  }

  protected disposeWorld(): void {
    if (this.world) {
      this.world.clear();
      this.world = null;
    }
    this.bodies = [];
    this.byId.clear();
  }
}

export function create(): PhysicsEngineBase {
  return new OimoEngine();
}
