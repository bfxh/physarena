import type { EngineMeta, EngineStats, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, massOf, quatOr, shapeAabb } from './shared';

export const meta: EngineMeta = {
  id: 'bullet',
  name: 'Bullet (ammo.js)',
  language: 'C++',
  backend: 'asm.js',
  license: 'Zlib',
  homepage: 'https://github.com/kripken/ammo.js',
  accent: '#b5651d',
  blurb: '老牌 Bullet 2.8x 的 Emscripten 移植。这里发布的是 asm.js 构建——没有 wasm，代价直接体现在跑分上。',
  solver: 'Sequential Impulse + btDbvtBroadphase',
  status: 'stable',
  capabilities: {
    shapes: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convex', 'trimesh'],
    joints: ['fixed', 'revolute', 'prismatic', 'spherical'],
    ccd: true,
    sensors: true,
    memoryReport: false,
  },
};

let ammoFactory: any = null;
let ammoModule: any = null;

/**
 * ammo.js is a classic-script UMD bundle whose factory assigns to `this`, so it
 * cannot be imported through the bundler. It is served from /vendor and booted
 * with an explicit receiver.
 */
function loadAmmoScript(): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = window as any;
    if (w.Ammo) return resolve(w.Ammo);
    const el = document.createElement('script');
    el.src = `${import.meta.env.BASE_URL}vendor/ammo/ammo.js`;
    el.async = true;
    el.onload = () => (w.Ammo ? resolve(w.Ammo) : reject(new Error('ammo.js 未导出 Ammo')));
    el.onerror = () => reject(new Error('无法加载 /vendor/ammo/ammo.js'));
    document.head.appendChild(el);
  });
}

class BulletEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private A: any;
  private world: any;
  private bodies: any[] = [];
  private byId = new Map<string, any>();
  private shapes: any[] = [];
  private gc: any[] = [];
  private scratch: any = null;

  async init(): Promise<void> {
    if (!ammoFactory) ammoFactory = await loadAmmoScript();
    // The factory must run at most once per page: a second invocation recompiles
    // the whole 1.8 MB asm.js payload and freezes the main thread. Explicit
    // receiver because the emscripten factory writes `this.Ammo = ...`.
    if (!ammoModule) ammoModule = await ammoFactory.call(window, {});
    this.A = ammoModule;
  }

  private v3(x: number, y: number, z: number): any {
    const v = new this.A.btVector3(x, y, z);
    this.gc.push(v);
    return v;
  }

  private buildShape(shape: ShapeDesc): any {
    const A = this.A;
    let s: any;
    switch (shape.kind) {
      case 'box': s = new A.btBoxShape(this.v3(...shape.halfExtents)); break;
      case 'sphere': s = new A.btSphereShape(shape.radius); break;
      case 'capsule': s = new A.btCapsuleShape(shape.radius, shape.halfHeight * 2); break;
      case 'cylinder':
        s = new A.btCylinderShape(this.v3(shape.radius, shape.halfHeight, shape.radius));
        break;
      case 'cone':
        s = new A.btConeShape(shape.radius, shape.halfHeight * 2);
        break;
      case 'convex': {
        const hull = new A.btConvexHullShape();
        for (let i = 0; i + 2 < shape.points.length; i += 3) {
          hull.addPoint(this.v3(shape.points[i], shape.points[i + 1], shape.points[i + 2]), true);
        }
        s = hull;
        break;
      }
      case 'trimesh': {
        const mesh = new A.btTriangleMesh(true, false);
        for (let i = 0; i + 2 < shape.indices.length; i += 3) {
          const a = shape.indices[i] * 3;
          const b = shape.indices[i + 1] * 3;
          const c = shape.indices[i + 2] * 3;
          mesh.addTriangle(
            this.v3(shape.vertices[a], shape.vertices[a + 1], shape.vertices[a + 2]),
            this.v3(shape.vertices[b], shape.vertices[b + 1], shape.vertices[b + 2]),
            this.v3(shape.vertices[c], shape.vertices[c + 1], shape.vertices[c + 2]),
            true,
          );
        }
        this.gc.push(mesh);
        s = new A.btBvhTriangleMeshShape(mesh, true, true);
        break;
      }
      default:
        s = new A.btBoxShape(this.v3(0.3, 0.3, 0.3));
        break;
    }
    this.gc.push(s);
    this.shapes.push(s);
    return s;
  }

  protected buildWorld(desc: WorldDesc): void {
    const A = this.A;
    const cfg = new A.btDefaultCollisionConfiguration();
    const dispatcher = new A.btCollisionDispatcher(cfg);
    const broadphase = new A.btDbvtBroadphase();
    const solver = new A.btSequentialImpulseConstraintSolver();
    this.world = new A.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cfg);
    this.world.setGravity(this.v3(...desc.gravity));
    // The world and its four helpers are per-build allocations too. Leaving
    // them out of the cleanup list exhausted the asm.js heap after ~18 runs.
    // The world itself must be in here as well - leaving *it* out leaked one
    // world per build (30+ per benchmark run) until the heap died.
    this.gc.push(cfg, dispatcher, broadphase, solver, this.world);
    this.scratch = new A.btTransform();
    this.scratch.setIdentity();
    this.gc.push(this.scratch);

    this.bodies = [];
    this.byId.clear();

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);
      const shape = this.buildShape(adapted.shape);

      const q = quatOr(b.rotation);
      const origin = this.v3(...b.position);
      const transform = new A.btTransform();
      transform.setIdentity();
      transform.setOrigin(origin);
      transform.setRotation(new A.btQuaternion(q[0], q[1], q[2], q[3]));
      const motionState = new A.btDefaultMotionState(transform);
      this.gc.push(transform, motionState);

      const mass = b.type === 'dynamic' ? massOf(b) : 0;
      const inertia = this.v3(0, 0, 0);
      if (mass > 0) shape.calculateLocalInertia(mass, inertia);
      const info = new A.btRigidBodyConstructionInfo(mass, motionState, shape, inertia);
      this.gc.push(info);
      const body = new A.btRigidBody(info);
      this.gc.push(body);

      if (b.type !== 'static') {
        // Kinematic bodies are driven by their velocity, so the IR's initial
        // velocity applies to them too (rotating-platform depends on it).
        if (b.velocity) body.setLinearVelocity(this.v3(...b.velocity));
        if (b.angularVelocity) body.setAngularVelocity(this.v3(...b.angularVelocity));
        if (b.linearDamping) body.setDamping(b.linearDamping, b.angularDamping ?? 0.05);
        else body.setDamping(0, b.angularDamping ?? 0.05);
      }
      if (b.type === 'kinematic') {
        try {
          body.setCollisionFlags(body.getCollisionFlags() | 2);
        } catch { /* ignore */ }
      }
      if (b.type === 'dynamic' && b.ccd) {
        // Thresholds derive from the shape so a 3 cm fragment and a 3 m
        // projectile both get a swept sphere that matches their size.
        const bb = shapeAabb(adapted.shape);
        const minHalf = Math.min(
          bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2],
        ) / 2;
        const r = Math.max(minHalf, 0.005);
        try {
          body.setCcdMotionThreshold(r * 0.5);
          body.setCcdSweptSphereRadius(r * 0.7);
        } catch { /* ignore */ }
      }

      if (b.sensor) {
        // CF_NO_CONTACT_RESPONSE = 4: the body reports overlaps but generates
        // no contact impulses - Bullet's trigger-volume flag.
        try {
          body.setCollisionFlags(body.getCollisionFlags() | 4);
        } catch { this.notes.add('Bullet 传感器标志设置失败'); }
      }

      this.world.addRigidBody(body);
      this.bodies.push(body);
      this.byId.set(b.id, body);
    }

    for (const j of desc.joints) {
      const A0 = this.byId.get(j.bodyA);
      const B0 = this.byId.get(j.bodyB);
      if (!A0 || !B0) { this.markSkippedJoint(); continue; }
      const pa = this.v3(...j.anchorA);
      const pb = this.v3(...j.anchorB);
      const axis = this.v3(...((j.axis ?? [0, 1, 0]) as Vec3));
      try {
        let con: any;
        switch (j.kind) {
          case 'fixed': {
            const fa = new A.btTransform();
            const fb = new A.btTransform();
            fa.setIdentity(); fb.setIdentity();
            fa.setOrigin(pa); fb.setOrigin(pb);
            this.gc.push(fa, fb);
            const dof = new A.btGeneric6DofConstraint(A0, B0, fa, fb, true);
            dof.setLinearLowerLimit(this.v3(0, 0, 0));
            dof.setLinearUpperLimit(this.v3(0, 0, 0));
            dof.setAngularLowerLimit(this.v3(0, 0, 0));
            dof.setAngularUpperLimit(this.v3(0, 0, 0));
            con = dof;
            break;
          }
          case 'revolute': {
            con = new A.btHingeConstraint(A0, B0, pa, pb, axis, axis, true);
            if (j.limits) {
              // setLimit REQUIRES all five arguments in this build. The 2- and
              // 3-argument forms are accepted silently, leave softness / bias /
              // relaxation undefined, and make the solver diverge - a 21-doll
              // ragdoll ended up with 231 NaN bodies. Values are Bullet's own
              // defaults.
              con.setLimit(j.limits[0], j.limits[1], 0.9, 0.3, 1.0);
            }
            if (j.motor) {
              try {
                // Bullet's third argument is an impulse cap, the IR's is a
                // force/torque cap. PhysArena runs a fixed 1/60 step, so the
                // conversion is force * dt; the note makes it inspectable.
                const DT = 1 / 60;
                con.enableAngularMotor(true, j.motor.targetVelocity, j.motor.maxForce * DT);
                this.notes.add('Bullet 电机上限按 力×dt 换算为冲量上限（固定 1/60 步）');
              } catch { this.notes.add('Bullet 电机未启用'); }
            }
            break;
          }
          case 'spherical': {
            try {
              con = new A.btPoint2PointConstraint(A0, B0, pa, pb);
            } catch {
              con = new A.btPoint2PointConstraint(A0, pa, B0, pb);
            }
            break;
          }
          case 'prismatic': {
            const fa = new A.btTransform();
            const fb = new A.btTransform();
            fa.setIdentity(); fb.setIdentity();
            fa.setOrigin(pa); fb.setOrigin(pb);
            this.gc.push(fa, fb);
            const slider = new A.btSliderConstraint(A0, B0, fa, fb, true);
            if (j.limits) {
              slider.setLowerLinLimit(j.limits[0]);
              slider.setUpperLinLimit(j.limits[1]);
            }
            con = slider;
            break;
          }
          default:
            this.markSkippedJoint();
            continue;
        }
        this.gc.push(con);
        this.world.addConstraint(con, true);
      } catch {
        this.markSkippedJoint();
      }
    }
  }

  protected stepWorld(dt: number): void {
    // (dt, maxSubSteps, fixedTimeStep) with maxSubSteps = 1 keeps PhysArena in
    // charge of the accumulator, so every engine gets exactly one step here.
    this.world.stepSimulation(dt, 1, dt);
  }

  protected syncStates(): void {
    const scratch = this.scratch;
    for (let i = 0; i < this.bodies.length; i++) {
      const s = this.states[i];
      if (!s) continue;
      const body = this.bodies[i];
      const ms = body.getMotionState();
      if (!ms) continue;
      ms.getWorldTransform(scratch);
      const o = scratch.getOrigin();
      const r = scratch.getRotation();
      s.position[0] = o.x(); s.position[1] = o.y(); s.position[2] = o.z();
      s.rotation[0] = r.x(); s.rotation[1] = r.y(); s.rotation[2] = r.z(); s.rotation[3] = r.w();
      try {
        // Real velocities, not the zeros seeded at build(): the energy probe
        // and the HUD depend on these.
        const lv = body.getLinearVelocity();
        const av = body.getAngularVelocity();
        s.linearVelocity = [lv.x(), lv.y(), lv.z()];
        s.angularVelocity = [av.x(), av.y(), av.z()];
      } catch { /* leave the seeded zeros */ }
      try {
        // Bullet activation state 2 is ISLAND_SLEEPING. When the binding does
        // not expose it, report `unknown` rather than a false 'still awake'.
        const st = body.getActivationState?.();
        s.sleeping = typeof st === 'number' ? st === 2 : undefined;
      } catch { s.sleeping = undefined; }
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const b = this.bodies[index];
    if (!b) return;
    try { b.applyCentralImpulse(this.v3(...impulse)); } catch { /* ignore */ }
  }

  stats(): EngineStats {
    const out: EngineStats = {
      bodyCount: this.bodies.length,
      notes: {
        memoryBytes: 'asm.js 构建，堆由宿主 JS 引擎管理，拿不到可与 wasm 引擎对比的独立数字',
      },
    };
    // getNumManifolds() is the ammo spelling of "how many contact manifolds is
    // the solver chewing on this step" - the fairest workload cross-check
    // against the other engines' body counts.
    try {
      const n = (this.world as unknown as { getNumManifolds?: () => number } | null)?.getNumManifolds?.();
      if (typeof n === 'number' && Number.isFinite(n)) out.contactCount = n;
    } catch {
      // Binding without that method: report nothing rather than zero.
    }
    return out;
  }

  protected disposeWorld(): void {
    const A = this.A;
    if (!A) return;
    try {
      for (const body of this.bodies) {
        try { this.world?.removeRigidBody(body); } catch { /* ignore */ }
      }
      this.world = null;
      for (const o of this.gc) {
        try { A.destroy(o); } catch { /* already destroyed */ }
      }
    } catch { /* ignore */ }
    this.gc = [];
    this.shapes = [];
    this.bodies = [];
    this.byId.clear();
    this.scratch = null;
  }
}

export function create(): PhysicsEngineBase {
  return new BulletEngine();
}
