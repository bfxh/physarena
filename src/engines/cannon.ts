import type { EngineMeta, EngineStats, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { hullFromPoints } from './hull';
import { adaptShape, coneHullPoints, quatOr, shapeVolume } from './shared';

export const meta: EngineMeta = {
  id: 'cannon-es',
  name: 'cannon-es',
  language: 'TypeScript',
  backend: 'Pure JS',
  license: 'MIT',
  homepage: 'https://github.com/pmndrs/cannon-es',
  accent: '#f0a03a',
  blurb: 'cannon.js 的现代化续作，零 WASM 零加载等待。体量小到手就能改，但 JS 标量求解器上限有限。',
  solver: 'Sequential Impulse (Gauss-Seidel) + SAP 宽相位',
  status: 'stable',
  capabilities: {
    shapes: ['box', 'sphere', 'cylinder', 'cone', 'convex', 'trimesh', 'compound'],
    joints: ['fixed', 'revolute', 'spherical', 'distance'],
    ccd: false,
    sensors: true,
    memoryReport: false,
  },
};

/** cannon-es has no per-body friction, so materials are quantised and paired. */
function q(v: number): number {
  return Math.round(v * 10) / 10;
}

class CannonEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private C: any;
  private world: any;
  private bodies: any[] = [];
  private byId = new Map<string, any>();
  private materials = new Map<string, any>();
  private contactPairs = new Set<string>();

  async init(): Promise<void> {
    this.C = await import('cannon-es');
  }

  private material(friction: number, restitution: number): any {
    const key = `${q(friction)}|${q(restitution)}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new this.C.Material(key);
      this.materials.set(key, m);
    }
    return m;
  }

  private contact(fa: any, fb: any): void {
    const key = fa.id < fb.id ? `${fa.id}|${fb.id}` : `${fb.id}|${fa.id}`;
    if (this.contactPairs.has(key)) return;
    this.contactPairs.add(key);
    const fa_ = Number(fa.name.split('|')[0]);
    const fb_ = Number(fb.name.split('|')[0]);
    const ra = Number(fa.name.split('|')[1]);
    const rb = Number(fb.name.split('|')[1]);
    this.world.addContactMaterial(new this.C.ContactMaterial(fa, fb, {
      friction: Math.sqrt(fa_ * fb_),
      restitution: Math.max(ra, rb),
    }));
  }

  private buildShapes(shape: ShapeDesc): { shape: any; offset?: Vec3; rotation?: any }[] {
    const C = this.C;
    switch (shape.kind) {
      case 'box':
        return [{ shape: new C.Box(new C.Vec3(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2])) }];
      case 'sphere':
        return [{ shape: new C.Sphere(shape.radius) }];
      case 'cylinder':
        // cannon-es Cylinder is Y-aligned in 0.19+, matching every other engine here.
        return [{ shape: new C.Cylinder(shape.radius, shape.radius, shape.halfHeight * 2, 18) }];
      case 'convex':
        return [{ shape: this.polyhedron(shape.points) }];
      case 'cone':
        // cannon-es has no cone primitive and a hand-built hull for it floats
        // (verified: rests at y=1.03 instead of ~0.5). Its own Cylinder is a
        // ConvexPolyhedron built by cannon's tested vertex generator, so a
        // near-zero top radius is both a truer cone and numerically stable.
        return [{ shape: new C.Cylinder(0.02, shape.radius, shape.halfHeight * 2, 18) }];
      case 'trimesh':
        return [{ shape: new C.Trimesh(shape.vertices, shape.indices) }];
      case 'compound': {
        const out: { shape: any; offset?: Vec3; rotation?: any }[] = [];
        for (const child of shape.children) {
          const kids = this.buildShapes(child.shape);
          for (const k of kids) {
            out.push({
              shape: k.shape,
              offset: child.offset,
              rotation: child.rotation ? new C.Quaternion(...quatOr(child.rotation)) : undefined,
            });
          }
        }
        return out;
      }
      default:
        return [{ shape: this.polyhedron(coneHullPoints(0.3, 0.3)) }];
    }
  }

  private polyhedron(points: number[]): any {
    const hull = hullFromPoints(points);
    if (!hull) {
      // Silent box fallback made a failed hull look like a legitimate shape;
      // every other degradation path in this file reports itself.
      this.notes.add('凸包构建失败→盒');
      return new this.C.Box(new this.C.Vec3(0.25, 0.25, 0.25));
    }
    const C = this.C;
    return new C.ConvexPolyhedron({
      vertices: hull.vertices.map((v) => new C.Vec3(v[0], v[1], v[2])),
      faces: hull.faces,
      normals: hull.normals.map((n) => new C.Vec3(n[0], n[1], n[2])),
    });
  }

  protected buildWorld(desc: WorldDesc): void {
    const C = this.C;
    this.world = new C.World({ gravity: new C.Vec3(...desc.gravity) });
    this.world.broadphase = new C.SAPBroadphase(this.world);
    (this.world.solver as any).iterations = 12;
    (this.world.solver as any).tolerance = 0.001;
    this.world.allowSleep = true;
    // Solver tuning (12 iterations vs the stock 10, stiffness 1e7, relaxation
    // 4) is a deliberate accuracy-for-speed trade documented here rather than
    // in `notes`: a note would degrade every cannon cell in the self-test
    // matrix even when nothing is unsupported.
    this.world.defaultContactMaterial.contactEquationStiffness = 1e7;
    this.world.defaultContactMaterial.contactEquationRelaxation = 4;

    this.bodies = [];
    this.byId.clear();
    this.materials.clear();
    this.contactPairs.clear();

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);
      const mat = this.material(b.friction ?? 0.5, b.restitution ?? 0.05);
      // Density * volume, like every other adapter. The old fixed 0.125 m^3
      // stand-in gave cannon a box/sphere mass ratio of 1.0 where the rest of
      // the field has 1.39, and flattened mass-ratio's 870,000:1 premise to
      // 1,125:1.
      const mass = b.type === 'dynamic'
        ? (b.mass ?? Math.max(0.05, (b.density ?? 1000) * shapeVolume(adapted.shape)))
        : 0;

      const body = new C.Body({
        mass,
        type: b.type === 'dynamic' ? C.Body.DYNAMIC : b.type === 'kinematic' ? C.Body.KINEMATIC : C.Body.STATIC,
        position: new C.Vec3(...b.position),
        quaternion: new C.Quaternion(...quatOr(b.rotation)),
        linearDamping: b.linearDamping ?? 0.01,
        angularDamping: b.angularDamping ?? 0.05,
        allowSleep: true,
        material: mat,
        isTrigger: b.sensor ?? false,
      });
      if (b.velocity) body.velocity.set(...b.velocity);
      if (b.angularVelocity) body.angularVelocity.set(...b.angularVelocity);

      for (const s of this.buildShapes(adapted.shape)) {
        if (s.offset || s.rotation) {
          body.addShape(s.shape, new C.Vec3(...(s.offset ?? [0, 0, 0])), s.rotation);
        } else {
          body.addShape(s.shape);
        }
      }
      this.world.addBody(body);
      this.bodies.push(body);
      this.byId.set(b.id, body);
    }

    // Pre-register every material pair that actually occurs in this scene.
    const keys = [...this.materials.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let k = i; k < keys.length; k++) {
        this.contact(this.materials.get(keys[i]), this.materials.get(keys[k]));
      }
    }

    // Trimesh fidelity: cannon-es registers only sphereTrimesh and
    // planeTrimesh collision; convex shapes fall straight through a terrain
    // with no other symptom, so say so instead of letting the cell look valid.
    if (
      desc.bodies.some((b) => b.shape.kind === 'trimesh')
      && desc.bodies.some((b) => b.type === 'dynamic' && b.shape.kind !== 'sphere')
    ) {
      this.notes.add('cannon-es：三角网只与球/平面碰撞，盒/圆柱等凸体会穿模');
    }

    for (const j of desc.joints) {
      const A = this.byId.get(j.bodyA);
      const B = this.byId.get(j.bodyB);
      if (!A || !B) { this.markSkippedJoint(); continue; }
      try {
        const pa = new C.Vec3(...j.anchorA);
        const pb = new C.Vec3(...j.anchorB);
        let con: any;
        switch (j.kind) {
          case 'fixed':
            // LockConstraint ignores pivotA/pivotB entirely - it always pins
            // the midpoint of the two body centres. Say so rather than letting
            // hanging-tower look like a faithful fixed joint.
            this.notes.add('cannon-es：固定关节锚点被近似为两体中点');
            con = new C.LockConstraint(A, B, { maxForce: 1e7 });
            break;
          case 'revolute': {
            const ax = new C.Vec3(...(j.axis ?? [0, 1, 0]));
            con = new C.HingeConstraint(A, B, { pivotA: pa, pivotB: pb, axisA: ax, axisB: ax, maxForce: 1e7 });
            if (j.limits) this.notes.add('cannon-es：铰链不支持角度限位，限位被忽略');
            break;
          }
          case 'spherical': con = new C.PointToPointConstraint(A, pa, B, pb, 1e7); break;
          case 'distance': case 'spring':
            con = new C.DistanceConstraint(A, B, j.restLength ?? pa.distanceTo(pb), 1e7);
            break;
          default:
            this.markSkippedJoint();
            continue;
        }
        this.world.addConstraint(con);
        if (j.motor && con.enableMotor) {
          try { con.enableMotor(); con.setMotorSpeed(j.motor.targetVelocity); con.setMotorMaxForce(j.motor.maxForce); } catch { /* hinge only */ }
        }
      } catch {
        this.markSkippedJoint();
      }
    }
  }

  protected stepWorld(dt: number): void {
    // Single explicit step: BSHSQ owns the accumulator, not the engine.
    this.world.step(dt);
  }

  protected syncStates(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const s = this.states[i];
      if (!s) continue;
      s.position[0] = b.position.x; s.position[1] = b.position.y; s.position[2] = b.position.z;
      s.rotation[0] = b.quaternion.x; s.rotation[1] = b.quaternion.y;
      s.rotation[2] = b.quaternion.z; s.rotation[3] = b.quaternion.w;
      s.linearVelocity![0] = b.velocity.x; s.linearVelocity![1] = b.velocity.y; s.linearVelocity![2] = b.velocity.z;
      s.angularVelocity![0] = b.angularVelocity.x; s.angularVelocity![1] = b.angularVelocity.y; s.angularVelocity![2] = b.angularVelocity.z;
      s.sleeping = b.sleepState === 2;
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const b = this.bodies[index];
    if (!b) return;
    b.applyImpulse(new this.C.Vec3(...impulse));
  }

  stats(): EngineStats {
    // No real per-engine memory figure is available: the JS heap is
    // page-wide and reporting it next to a wasm heap would be misleading.
    const out: EngineStats = {
      bodyCount: this.bodies.length,
      notes: {
        memoryBytes: '纯 JS 引擎，没有独立堆可测；页面 JS 堆包含 UI 与全部渲染器，不能当作它的内存',
      },
    };
    // Contact count is the single best predictor of solver cost, so report it
    // whenever the engine actually exposes it. Probed defensively: an API that
    // does not exist must yield "no data", never a fabricated 0.
    const contacts = (this.world as unknown as { contacts?: unknown[] } | null)?.contacts;
    if (Array.isArray(contacts)) out.contactCount = contacts.length;
    return out;
  }

  protected disposeWorld(): void {
    if (this.world) {
      for (const b of this.bodies) this.world.removeBody(b);
      this.world = null;
    }
    this.bodies = [];
    this.byId.clear();
  }
}

export function create(): PhysicsEngineBase {
  return new CannonEngine();
}
