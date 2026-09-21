import type { EngineMeta, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, massOf, quatOr } from './shared';

export const meta: EngineMeta = {
  id: 'crashcat',
  name: 'Crashcat',
  language: 'TypeScript',
  backend: 'Pure JS',
  license: 'MIT',
  homepage: 'https://github.com/isaac-mason/crashcat',
  accent: '#2f9e7f',
  blurb: '2026 年的纯 TS 新引擎，API 与 Jolt 同构。零 WASM 零加载等待，事件回调不过边界——但 solver 明显年轻。',
  solver: 'Jolt 风格顺序冲量 + 动态 BVH 宽相位',
  status: 'experimental',
  capabilities: {
    shapes: ['box', 'sphere', 'capsule', 'cylinder', 'convex', 'trimesh', 'compound'],
    joints: ['fixed', 'revolute', 'prismatic', 'spherical', 'distance'],
    ccd: true,
    sensors: true,
    memoryReport: false,
  },
};

class CrashcatEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private CC: any;
  private world: any;
  private bodies: any[] = [];
  private byId = new Map<string, any>();
  private layers = { dynamic: 0, fixed: 0 };

  async init(): Promise<void> {
    this.CC = await import('crashcat');
    // Shapes and constraints are registered explicitly - that is what makes the
    // bundle tree-shakeable, and forgetting it makes body creation throw.
    this.CC.registerAll();
  }

  private shape(shape: ShapeDesc): any {
    const CC = this.CC;
    switch (shape.kind) {
      case 'box': return CC.box.create({ halfExtents: shape.halfExtents });
      case 'sphere': return CC.sphere.create({ radius: shape.radius });
      case 'capsule': return CC.capsule.create({ radius: shape.radius, halfHeightOfCylinder: shape.halfHeight });
      case 'cylinder': return CC.cylinder.create({ radius: shape.radius, halfHeight: shape.halfHeight });
      case 'convex': return CC.convexHull.create({ positions: shape.points });
      case 'trimesh': return CC.triangleMesh.create({ positions: shape.vertices, indices: shape.indices });
      case 'compound':
        return CC.compound.create({
          children: shape.children.map((c) => ({
            shape: this.shape(c.shape),
            position: c.offset,
            quaternion: quatOr(c.rotation),
          })),
        });
    }
  }

  protected buildWorld(desc: WorldDesc): void {
    const CC = this.CC;
    const ws = CC.createWorldSettings();
    ws.gravity = [...desc.gravity];
    const bpA = CC.addBroadphaseLayer(ws);
    const bpB = CC.addBroadphaseLayer(ws);
    const layerMoving = CC.addObjectLayer(ws, bpA);
    const layerStatic = CC.addObjectLayer(ws, bpB);
    CC.enableCollision(ws, layerMoving, layerMoving);
    CC.enableCollision(ws, layerMoving, layerStatic);
    this.layers = { dynamic: layerMoving, fixed: layerStatic };

    this.world = CC.createWorld(ws);
    this.bodies = [];
    this.byId.clear();

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);
      const settings: any = {
        motionType:
          b.type === 'dynamic' ? CC.MotionType.DYNAMIC
            : b.type === 'kinematic' ? CC.MotionType.KINEMATIC
              : CC.MotionType.STATIC,
        shape: this.shape(adapted.shape),
        objectLayer: b.type === 'static' ? layerStatic : layerMoving,
        position: [...b.position],
        quaternion: quatOr(b.rotation),
        friction: b.friction ?? 0.5,
        restitution: b.restitution ?? 0.05,
        linearDamping: b.linearDamping ?? 0,
        angularDamping: b.angularDamping ?? 0.05,
        sensor: b.sensor ?? false,
        allowSleeping: true,
      };
      if (b.type === 'dynamic') settings.mass = massOf(b);
      if (b.ccd) {
        // CCD in crashcat is a creation setting (motionQuality on the rigid
        // body). The previous `CC.rigidBody.setMotionQuality(...)` call does
        // not exist in 0.0.5 and silently no-op'd through optional chaining,
        // so `capabilities.ccd: true` was a false claim.
        const mq = CC.MotionQuality?.LINEAR_CAST;
        if (mq !== undefined) settings.motionQuality = mq;
        else this.notes.add('Crashcat 连续碰撞不可用（MotionQuality 缺失）');
      }
      const body = CC.rigidBody.create(this.world, settings);
      if (b.type !== 'static') {
        if (b.velocity) CC.rigidBody.setLinearVelocity(this.world, body, [...b.velocity]);
        if (b.angularVelocity) CC.rigidBody.setAngularVelocity(this.world, body, [...b.angularVelocity]);
      }
      this.bodies.push(body);
      this.byId.set(b.id, body);
    }

    for (const j of desc.joints) {
      const A = this.byId.get(j.bodyA);
      const B = this.byId.get(j.bodyB);
      if (!A || !B) { this.markSkippedJoint(); continue; }
      const space = CC.ConstraintSpace.LOCAL;
      const axis = [...(j.axis ?? [0, 1, 0])] as Vec3;
      const normal: Vec3 = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
      try {
        switch (j.kind) {
          case 'fixed':
            CC.fixedConstraint.create(this.world, {
              bodyIdA: A.id, bodyIdB: B.id,
              point1: [...j.anchorA], point2: [...j.anchorB],
              axisX1: [1, 0, 0], axisY1: [0, 1, 0],
              axisX2: [1, 0, 0], axisY2: [0, 1, 0],
              space,
            });
            break;
          case 'revolute': {
            const hinge = CC.hingeConstraint.create(this.world, {
              bodyIdA: A.id, bodyIdB: B.id,
              pointA: [...j.anchorA], pointB: [...j.anchorB],
              hingeAxisA: axis, hingeAxisB: axis,
              normalAxisA: normal, normalAxisB: normal,
              space,
              limitsMin: j.limits?.[0], limitsMax: j.limits?.[1],
            });
            if (j.motor) {
              // crashcat does support hinge motors (setMotorState +
              // setTargetAngularVelocity + a torque limit on motorSettings);
              // leaving the IR's motor unread made motor-wheel a vehicle that
              // never drives.
              try {
                CC.motorSettings?.setTorqueLimit?.(hinge.motorSettings, j.motor.maxForce);
                CC.hingeConstraint.setMotorState(hinge, CC.MotorState.VELOCITY);
                CC.hingeConstraint.setTargetAngularVelocity(hinge, j.motor.targetVelocity);
              } catch { this.notes.add('Crashcat 铰链电机未启用'); }
            }
            break;
          }
          case 'spherical':
            CC.pointConstraint.create(this.world, {
              bodyIdA: A.id, bodyIdB: B.id,
              pointA: [...j.anchorA], pointB: [...j.anchorB],
              space,
            });
            break;
          case 'prismatic':
            CC.sliderConstraint.create(this.world, {
              bodyIdA: A.id, bodyIdB: B.id,
              pointA: [...j.anchorA], pointB: [...j.anchorB],
              sliderAxisA: axis, sliderAxisB: axis,
              normalAxisA: normal, normalAxisB: normal,
              space,
              limitsMin: j.limits?.[0], limitsMax: j.limits?.[1],
            });
            break;
          case 'distance': case 'spring': {
            const rest = j.restLength ?? 0.5;
            CC.distanceConstraint.create(this.world, {
              bodyIdA: A.id, bodyIdB: B.id,
              pointA: [...j.anchorA], pointB: [...j.anchorB],
              minDistance: rest, maxDistance: rest,
              space,
            });
            break;
          }
          default:
            this.markSkippedJoint();
        }
      } catch {
        this.markSkippedJoint();
      }
    }
  }

  protected stepWorld(dt: number): void {
    this.CC.updateWorld(this.world, undefined, dt);
  }

  protected syncStates(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const s = this.states[i];
      if (!s) continue;
      const p = b.position;
      const q = b.quaternion;
      if (p) { s.position[0] = p[0]; s.position[1] = p[1]; s.position[2] = p[2]; }
      if (q) { s.rotation[0] = q[0]; s.rotation[1] = q[1]; s.rotation[2] = q[2]; s.rotation[3] = q[3]; }
      const dyn = this.desc?.bodies[i]?.type === 'dynamic';
      const mp = b.motionProperties;
      if (dyn && mp?.linearVelocity) {
        s.linearVelocity = [mp.linearVelocity[0], mp.linearVelocity[1], mp.linearVelocity[2]];
        if (mp.angularVelocity) {
          s.angularVelocity = [mp.angularVelocity[0], mp.angularVelocity[1], mp.angularVelocity[2]];
        }
        s.sleeping = !!b.sleeping;
      } else {
        s.sleeping = dyn ? !!b.sleeping : undefined;
      }
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const b = this.bodies[index];
    if (!b) return;
    this.CC.rigidBody.addImpulse(this.world, b, [...impulse]);
  }

  stats() {
    return { bodyCount: this.bodies.length };
  }

  protected disposeWorld(): void {
    if (this.world) {
      for (const b of this.bodies) {
        try { this.CC.rigidBody.remove(this.world, b); } catch { /* already pooled */ }
      }
      this.world = null;
    }
    this.bodies = [];
    this.byId.clear();
  }
}

export function create(): PhysicsEngineBase {
  return new CrashcatEngine();
}
