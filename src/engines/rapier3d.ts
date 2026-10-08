import type { BodyDesc, EngineMeta, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, collectNotes, quatOr, shapeAabb } from './shared';

export const meta: EngineMeta = {
  id: 'rapier3d',
  name: 'Rapier 3D',
  language: 'Rust',
  backend: 'WASM',
  license: 'Apache-2.0',
  homepage: 'https://rapier.rs',
  accent: '#e8452c',
  blurb: 'Rust 实现的现代求解器，SIMD + 动态 BVH，目前浏览器里综合最快的通用选择。',
  solver: 'Impulse-based (TGS Soft) + 动态 BVH 宽相位',
  status: 'stable',
  capabilities: {
    shapes: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convex', 'trimesh', 'compound'],
    joints: ['fixed', 'revolute', 'prismatic', 'spherical', 'distance'],
    ccd: true,
    sensors: true,
    memoryReport: false,
  },
};

class Rapier3DEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private R: any;
  private world: any;
  private rigidBodies: any[] = [];
  private byId = new Map<string, any>();

  async init(): Promise<void> {
    const mod: any = await import('@dimforge/rapier3d-compat');
    this.R = mod.default ?? mod;
    await this.R.init();
  }

  private colliderDesc(shape: ShapeDesc, note: string): any[] {
    const R = this.R;
    const made: any[] = [];
    const push = (d: any) => { if (d) made.push(d); };

    switch (shape.kind) {
      case 'box': push(R.ColliderDesc.cuboid(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2])); break;
      case 'sphere': push(R.ColliderDesc.ball(shape.radius)); break;
      case 'capsule': push(R.ColliderDesc.capsule(shape.halfHeight, shape.radius)); break;
      case 'cylinder': push(R.ColliderDesc.cylinder(shape.halfHeight, shape.radius)); break;
      case 'cone': push(R.ColliderDesc.cone(shape.halfHeight, shape.radius)); break;
      case 'convex': push(R.ColliderDesc.convexHull(new Float32Array(shape.points))); break;
      case 'trimesh': push(R.ColliderDesc.trimesh(new Float32Array(shape.vertices), new Uint32Array(shape.indices))); break;
      case 'compound': {
        for (const child of shape.children) {
          const kids = this.colliderDesc(child.shape, note);
          for (const k of kids) {
            // ColliderDesc.setTranslation is the (x, y, z) three-argument
            // overload, not the Vector one - passing an object yields NaN and
            // Rapier throws 'The translation components must be numbers'.
            k.setTranslation(child.offset[0], child.offset[1], child.offset[2]);
            if (child.rotation) {
              const q = quatOr(child.rotation);
              k.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
            }
            made.push(k);
          }
        }
        break;
      }
    }
    if (note) this.notes.add(note);
    return made;
  }

  protected buildWorld(desc: { gravity: Vec3; bodies: BodyDesc[]; joints: any[] }): void {
    const R = this.R;
    this.world = new R.World({ x: desc.gravity[0], y: desc.gravity[1], z: desc.gravity[2] });
    this.rigidBodies = [];
    this.byId.clear();
    const notes: string[] = [];

    for (const b of desc.bodies) {
      let bodyDesc: any;
      if (b.type === 'dynamic') bodyDesc = R.RigidBodyDesc.dynamic();
      else if (b.type === 'kinematic') bodyDesc = R.RigidBodyDesc.kinematicPositionBased();
      else bodyDesc = R.RigidBodyDesc.fixed();

      bodyDesc.setTranslation(b.position[0], b.position[1], b.position[2]);
      const q = quatOr(b.rotation);
      bodyDesc.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
      if (b.linearDamping) bodyDesc.setLinearDamping(b.linearDamping);
      if (b.angularDamping) bodyDesc.setAngularDamping(b.angularDamping);
      if (b.ccd) bodyDesc.setCcdEnabled(true);
      if (b.velocity) bodyDesc.setLinvel(b.velocity[0], b.velocity[1], b.velocity[2]);
      if (b.angularVelocity) {
        bodyDesc.setAngvel({ x: b.angularVelocity[0], y: b.angularVelocity[1], z: b.angularVelocity[2] });
      }

      const rb = this.world.createRigidBody(bodyDesc);
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) notes.push(adapted.note);
      const descs = this.colliderDesc(adapted.shape, '');
      if (descs.length === 0) {
        // convexHull() returns null on degenerate input - fall back to an AABB box.
        const bb = shapeAabb(adapted.shape);
        descs.push(R.ColliderDesc.cuboid(
          Math.max(0.02, (bb.max[0] - bb.min[0]) / 2),
          Math.max(0.02, (bb.max[1] - bb.min[1]) / 2),
          Math.max(0.02, (bb.max[2] - bb.min[2]) / 2),
        ));
        notes.push('退化凸包→盒');
      }
      for (const cd of descs) {
        // Rapier sums per-collider mass, so a compound with N colliders would
        // otherwise simulate at N x the declared mass.
        if (b.mass != null) cd.setMass(b.mass / descs.length);
        else cd.setDensity(b.density ?? 1000);
        cd.setFriction(b.friction ?? 0.5);
        cd.setRestitution(b.restitution ?? 0.05);
        if (b.sensor) cd.setSensor(true);
        this.world.createCollider(cd, rb);
      }
      this.rigidBodies.push(rb);
      this.byId.set(b.id, rb);
    }

    // Rapier joints use anchor points in LOCAL body space, which is exactly
    // what our JointDesc stores, so no conversion is needed.
    for (const j of desc.joints) {
      const a = this.byId.get(j.bodyA);
      const b2 = this.byId.get(j.bodyB);
      if (!a || !b2) { this.markSkippedJoint(); continue; }
      try {
        let data: any;
        const ax = (j.axis ?? [0, 1, 0]) as Vec3;
        const v = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });
        switch (j.kind) {
          case 'fixed':
            data = R.JointData.fixed(v(j.anchorA), { x: 0, y: 0, z: 0, w: 1 }, v(j.anchorB), { x: 0, y: 0, z: 0, w: 1 });
            break;
          case 'revolute': data = R.JointData.revolute(v(j.anchorA), v(j.anchorB), v(ax)); break;
          case 'prismatic': data = R.JointData.prismatic(v(j.anchorA), v(j.anchorB), v(ax)); break;
          case 'spherical': data = R.JointData.spherical(v(j.anchorA), v(j.anchorB)); break;
          case 'distance':
            // Rapier has no rigid distance joint. The IR's `distance` means
            // 'hold this separation', so a very stiff spring is the closest
            // equivalent - the IR's soft spring values stretch ~9 m.
            data = R.JointData.spring(j.restLength ?? 0.5, 1e5, 1e2, v(j.anchorA), v(j.anchorB));
            if (j.stiffness != null || j.damping != null) {
              notes.push('distance 关节按刚性弹距近似（stiffness/damping 被忽略；软约束请用 spring）');
            }
            break;
          case 'spring':
            data = R.JointData.spring(
              j.restLength ?? 0.5, j.stiffness ?? 1, j.damping ?? 0.1,
              v(j.anchorA), v(j.anchorB),
            );
            break;
          default:
            this.markSkippedJoint();
            continue;
        }
        if (j.limits && (j.kind === 'revolute' || j.kind === 'prismatic')) {
          try { data.setLimits(j.limits[0], j.limits[1]); } catch { /* not supported for this kind */ }
        }
        const joint = this.world.createImpulseJoint(data, a, b2, true);
        if (j.motor && (j.kind === 'revolute' || j.kind === 'prismatic')) {
          try {
            joint.configureMotorVelocity(j.motor.targetVelocity, j.motor.maxForce || 1000);
          } catch { this.notes.add('电机未生效'); }
        }
      } catch {
        this.markSkippedJoint();
      }
    }

    for (const n of collectNotes(notes)) this.notes.add(n);
  }

  protected stepWorld(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /**
   * 窄相现数：当前处于接触中的碰撞体对数。
   *
   * 走 `narrowPhase.contactPairsWith` 只读遍历，不挂碰撞事件、不改仿真负载
   * —— 对跑分场景来说，给 UI 加一行读数不该给被测引擎的每一步计时添开销。
   */
  private countContactPairs(): number {
    try {
      const np = this.world?.narrowPhase;
      const colliders = this.world?.colliders;
      if (!np || !colliders) return 0;
      let sides = 0;
      for (const c of colliders.getAll()) {
        np.contactPairsWith(c.handle, () => { sides += 1; });
      }
      // 每对从两侧各数一次
      return Math.floor(sides / 2);
    } catch {
      return 0;
    }
  }

  protected syncStates(): void {
    for (let i = 0; i < this.rigidBodies.length; i++) {
      const rb = this.rigidBodies[i];
      const t = rb.translation();
      const r = rb.rotation();
      const lv = rb.linvel();
      const av = rb.angvel();
      const s = this.states[i];
      if (!s) continue;
      s.position[0] = t.x; s.position[1] = t.y; s.position[2] = t.z;
      s.rotation[0] = r.x; s.rotation[1] = r.y; s.rotation[2] = r.z; s.rotation[3] = r.w;
      s.linearVelocity![0] = lv.x; s.linearVelocity![1] = lv.y; s.linearVelocity![2] = lv.z;
      s.angularVelocity![0] = av.x; s.angularVelocity![1] = av.y; s.angularVelocity![2] = av.z;
      s.sleeping = rb.isSleeping();
    }
  }

  applyImpulse(index: number, impulse: Vec3, point?: Vec3): void {
    const rb = this.rigidBodies[index];
    if (!rb) return;
    const imp = { x: impulse[0], y: impulse[1], z: impulse[2] };
    if (point) {
      // Off-centre impulse: apply at the point (r x impulse is computed by
      // Rapier) instead of the old `point * 0.01` torque stand-in.
      rb.applyImpulseAtPoint(imp, { x: point[0], y: point[1], z: point[2] }, true);
    } else {
      rb.applyImpulse(imp, true);
    }
  }

  stats() {
    return {
      bodyCount: this.rigidBodies.length,
      contactCount: this.countContactPairs(),
      notes: {
        contactCount: '窄相检测当前处于接触中的碰撞体对数（现数，不缓存）',
      },
    };
  }

  protected disposeWorld(): void {
    if (this.world) {
      this.world.free();
      this.world = null;
    }
    this.rigidBodies = [];
    this.byId.clear();
  }
}

export function create(): PhysicsEngineBase {
  return new Rapier3DEngine();
}
