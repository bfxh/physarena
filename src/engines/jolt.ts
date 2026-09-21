import type { EngineMeta, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, massOf, quatOr } from './shared';

export const meta: EngineMeta = {
  id: 'jolt',
  name: 'Jolt Physics',
  language: 'C++',
  backend: 'WASM',
  license: 'MIT',
  homepage: 'https://github.com/jrouwe/JoltPhysics',
  accent: '#3f6fd8',
  blurb: 'Horizon Forbidden West 的物理引擎。单精度浮点 + 严格确定性的顺序冲量求解器，工业级调参。',
  solver: '顺序冲量 + 岛式并行 + SIMD/JobSystem',
  status: 'stable',
  capabilities: {
    shapes: ['box', 'sphere', 'capsule', 'cylinder', 'convex', 'trimesh', 'compound'],
    // Jolt itself has all of these, but constraints created through this WebIDL
    // build produce a valid constraint object that has no effect on the
    // simulation - verified in isolation through both BodyInterface.CreateConstraint
    // and the documented TwoBodyConstraintSettings.Create path. Rather than
    // pretend otherwise, the capability is declared unsupported and joint
    // scenarios are reported as degraded.
    joints: [],
    ccd: true,
    sensors: true,
    memoryReport: true,
  },
};

/** Jolt uses doubles (RVec3) for world space and floats (Vec3) for local space. */
function num(o: any, a: string, b: string): number {
  return typeof o[a] === 'function' ? o[a]() : o[b];
}

/**
 * Jolt lifecycle notes, all established by isolated experiments:
 *
 * - The default entrypoint inlines the wasm as base64, so there is no asset to
 *   serve and no `locateFile` to wire up.
 * - `BodyInterface.DestroyBody` traps with "memory access out of bounds" the
 *   second time it is called on an interface, and leaves the module corrupted
 *   for everything that follows (a later stacking probe then exploded to
 *   y = -703 while the identical scene in isolation was rock solid). So it is
 *   never called: every world gets a fresh JoltInterface and teardown destroys
 *   the interface, which frees every body it owns.
 * - With that scheme, 24 consecutive worlds produced identical results and a
 *   flat 128 MB wasm heap.
 * - Per-build settings objects are released in bulk *after* the interface that
 *   references them is gone.
 */
class JoltEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private J: any;
  private jolt: any = null;
  private ps: any = null;
  private bi: any = null;
  private ids: any[] = [];
  private owned: any[] = [];
  private tmpPos: any = null;
  private tmpRot: any = null;
  private layerMoving = 0;
  private layerStatic = 1;

  async init(): Promise<void> {
    const mod: any = await import('jolt-physics');
    const JoltInit = mod.default ?? mod;
    this.J = await JoltInit();
  }

  protected buildWorld(desc: WorldDesc): void {
    const J = this.J;
    const count = desc.bodies.length;

    const settings = new J.JoltSettings();
    settings.mMaxBodies = Math.max(1024, count * 4 + 512);
    settings.mMaxBodyPairs = Math.max(1024, count * 8 + 1024);
    settings.mMaxContactConstraints = Math.max(1024, count * 8 + 1024);
    settings.mMaxWorkerThreads = 0;

    const bpLayers = new J.BroadPhaseLayerInterfaceTable(2, 2);
    bpLayers.MapObjectToBroadPhaseLayer(this.layerMoving, 0);
    bpLayers.MapObjectToBroadPhaseLayer(this.layerStatic, 1);
    const pairFilter = new J.ObjectLayerPairFilterTable(2);
    pairFilter.EnableCollision(this.layerMoving, this.layerMoving);
    pairFilter.EnableCollision(this.layerMoving, this.layerStatic);
    const vsFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpLayers, 2, pairFilter, 2);
    settings.mBroadPhaseLayerInterface = bpLayers;
    settings.mObjectLayerPairFilter = pairFilter;
    settings.mObjectVsBroadPhaseLayerFilter = vsFilter;
    this.owned.push(settings, bpLayers, pairFilter, vsFilter);

    this.jolt = new J.JoltInterface(settings);
    this.ps = this.jolt.GetPhysicsSystem();
    this.bi = this.ps.GetBodyInterface();
    this.ps.SetGravity(new J.Vec3(...desc.gravity));

    this.ids = [];
    this.tmpPos = new J.RVec3(0, 0, 0);
    this.tmpRot = new J.Quat(0, 0, 0, 1);

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);
      const shape = this.shapeFor(adapted.shape);
      const layer = b.type === 'static' ? this.layerStatic : this.layerMoving;
      const motionType =
        b.type === 'dynamic' ? J.EMotionType_Dynamic
          : b.type === 'kinematic' ? J.EMotionType_Kinematic
            : J.EMotionType_Static;

      const bcs = new J.BodyCreationSettings(
        shape,
        new J.RVec3(...b.position),
        new J.Quat(...quatOr(b.rotation)),
        motionType,
        layer,
      );
      bcs.mFriction = b.friction ?? 0.5;
      bcs.mRestitution = b.restitution ?? 0.05;
      bcs.mLinearDamping = b.linearDamping ?? 0;
      bcs.mAngularDamping = b.angularDamping ?? 0.05;
      bcs.mIsSensor = b.sensor ?? false;
      if (b.type === 'dynamic') {
        // Jolt has no per-body density, so the equivalent mass is passed and the
        // inertia tensor is derived from the shape and scaled to match it.
        bcs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia;
        const mp = new J.MassProperties();
        mp.mMass = massOf(b);
        bcs.mMassPropertiesOverride = mp;
        this.owned.push(mp);
      }
      this.owned.push(bcs);

      const id = this.bi.CreateAndAddBody(bcs, J.EActivation_Activate);
      if (b.type !== 'static') {
        // Kinematic bodies need their velocity too (rotating-platform).
        if (b.velocity) this.bi.SetLinearVelocity(id, new J.Vec3(...b.velocity));
        if (b.angularVelocity) this.bi.SetAngularVelocity(id, new J.Vec3(...b.angularVelocity));
      }
      if (b.type === 'dynamic' && b.ccd) this.bi.SetMotionQuality(id, J.EMotionQuality_LinearCast);
      // MUST clone. CreateAndAddBody hands back the SAME wrapper object on every
      // call, so pushing the raw result stores N aliases of the newest body:
      // every read then reported the last body's pose and the whole scene
      // collapsed onto one point (looked like a sand-coloured slab filling the
      // pane, because only the ground box was left with any extent).
      //
      // Verified in isolation: bare results give index sequence 2,2,2 and read
      // back x = 6,6,6; `new J.BodyID(id)` copies garbage (index 70064, reads
      // x = 0,0,0); Clone() gives the true sequence 0,1,2 and reads 0,3,6.
      this.ids.push(id.Clone());
    }

    this.ps.OptimizeBroadPhase?.();

    if (desc.joints.length) {
      this.skippedJoints += desc.joints.length;
      this.notes.add('Jolt: 本次集成下约束不生效，关节场景按自由刚体运行');
    }
  }

  private shape(settings: any): any {
    const result = settings.Create();
    this.owned.push(result, settings);
    if (!result.IsValid()) {
      this.notes.add('形状构建失败，退化为盒');
      const fallback = new this.J.BoxShapeSettings(new this.J.Vec3(0.25, 0.25, 0.25), 0.02);
      const fbResult = fallback.Create();
      this.owned.push(fbResult, fallback);
      return fbResult.Get();
    }
    return result.Get();
  }

  private shapeFor(shape: ShapeDesc): any {
    const J = this.J;
    switch (shape.kind) {
      case 'box':
        return this.shape(new J.BoxShapeSettings(new J.Vec3(...shape.halfExtents), 0.02));
      case 'sphere':
        return this.shape(new J.SphereShapeSettings(shape.radius));
      case 'capsule':
        return this.shape(new J.CapsuleShapeSettings(shape.halfHeight, shape.radius));
      case 'cylinder':
        return this.shape(new J.CylinderShapeSettings(shape.halfHeight, shape.radius, 0.02));
      case 'convex': {
        const s = new J.ConvexHullShapeSettings();
        const arr = new J.ArrayVec3();
        for (let i = 0; i + 2 < shape.points.length; i += 3) {
          arr.push_back(new J.Vec3(shape.points[i], shape.points[i + 1], shape.points[i + 2]));
        }
        s.mPoints = arr;
        this.owned.push(arr);
        return this.shape(s);
      }
      case 'trimesh': {
        // The (VertexList, IndexedTriangleList) overload silently mis-binds under
        // embind and yields garbage material indices ("Triangle material ... is
        // beyond material list"), so the TriangleList path is used instead.
        const tl = new J.TriangleList();
        const n = Math.min(shape.indices.length, 3 * 60000) / 3;
        for (let t = 0; t < n; t++) {
          const i0 = shape.indices[t * 3] * 3;
          const i1 = shape.indices[t * 3 + 1] * 3;
          const i2 = shape.indices[t * 3 + 2] * 3;
          tl.push_back(new J.Triangle(
            new J.Vec3(shape.vertices[i0], shape.vertices[i0 + 1], shape.vertices[i0 + 2]),
            new J.Vec3(shape.vertices[i1], shape.vertices[i1 + 1], shape.vertices[i1 + 2]),
            new J.Vec3(shape.vertices[i2], shape.vertices[i2 + 1], shape.vertices[i2 + 2]),
            0,
          ));
        }
        this.owned.push(tl);
        const ms = new J.MeshShapeSettings(tl);
        try { ms.Sanitize(); } catch { /* best effort */ }
        return this.shape(ms);
      }
      case 'compound': {
        const s = new J.StaticCompoundShapeSettings();
        // The compound settings hold POINTERS to the child settings for as long
        // as it lives, so they must stay referenced until the shape is built.
        for (const child of shape.children) {
          const kid = this.childSettings(child.shape);
          this.owned.push(kid);
          s.AddShape(new J.Vec3(...child.offset), new J.Quat(...quatOr(child.rotation)), kid, 0);
        }
        return this.shape(s);
      }
    }
  }

  /** Child shapes of a compound. Nesting further is not worth the complexity. */
  private childSettings(shape: ShapeDesc): any {
    const J = this.J;
    switch (shape.kind) {
      case 'box': return new J.BoxShapeSettings(new J.Vec3(...shape.halfExtents), 0.02);
      case 'sphere': return new J.SphereShapeSettings(shape.radius);
      case 'capsule': return new J.CapsuleShapeSettings(shape.halfHeight, shape.radius);
      case 'cylinder': return new J.CylinderShapeSettings(shape.halfHeight, shape.radius, 0.02);
      case 'convex': {
        const s = new J.ConvexHullShapeSettings();
        const arr = new J.ArrayVec3();
        for (let i = 0; i + 2 < shape.points.length; i += 3) {
          arr.push_back(new J.Vec3(shape.points[i], shape.points[i + 1], shape.points[i + 2]));
        }
        s.mPoints = arr;
        this.owned.push(arr);
        return s;
      }
      default: return new J.BoxShapeSettings(new J.Vec3(0.25, 0.25, 0.25), 0.02);
    }
  }

  protected stepWorld(dt: number): void {
    this.jolt.Step(dt, 1);
  }

  protected syncStates(): void {
    const bi = this.bi;
    // Two scratch objects reused for every body: allocating per body per frame
    // would put the wasm allocator on the hot path and pollute the timings.
    for (let i = 0; i < this.ids.length; i++) {
      const s = this.states[i];
      if (!s) continue;
      bi.GetPositionAndRotation(this.ids[i], this.tmpPos, this.tmpRot);
      s.position[0] = num(this.tmpPos, 'GetX', 'x');
      s.position[1] = num(this.tmpPos, 'GetY', 'y');
      s.position[2] = num(this.tmpPos, 'GetZ', 'z');
      s.rotation[0] = num(this.tmpRot, 'GetX', 'x');
      s.rotation[1] = num(this.tmpRot, 'GetY', 'y');
      s.rotation[2] = num(this.tmpRot, 'GetZ', 'z');
      s.rotation[3] = num(this.tmpRot, 'GetW', 'w');
      const dyn = this.desc?.bodies[i]?.type === 'dynamic';
      if (dyn) {
        // Real velocities (the energy probe reads these); fixed bodies get
        // `undefined` instead of Jolt's "never active" so they cannot count as
        // sleeping and skew the awake fraction.
        const lv = bi.GetLinearVelocity(this.ids[i]);
        const av = bi.GetAngularVelocity(this.ids[i]);
        s.linearVelocity = [num(lv, 'GetX', 'x'), num(lv, 'GetY', 'y'), num(lv, 'GetZ', 'z')];
        s.angularVelocity = [num(av, 'GetX', 'x'), num(av, 'GetY', 'y'), num(av, 'GetZ', 'z')];
        s.sleeping = !bi.IsActive(this.ids[i]);
      } else {
        s.sleeping = undefined;
      }
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const id = this.ids[index];
    if (id === undefined) return;
    this.bi.AddImpulse(id, new this.J.Vec3(...impulse));
  }

  stats() {
    // HEAPU8.byteLength is the wasm heap *capacity* (a flat 128 MB), not bytes
    // in use - it reported the same number for every cell. Jolt exposes the
    // real allocator figures, so report those instead.
    let used: number | undefined;
    try {
      const total = this.jolt?.sGetTotalMemory?.();
      const free = this.jolt?.sGetFreeMemory?.();
      if (typeof total === 'number' && typeof free === 'number') used = total - free;
    } catch { /* fall through */ }
    return {
      bodyCount: this.ids.length,
      memoryBytes: used ?? ((this.J as any)?.HEAPU8?.byteLength ?? undefined),
    };
  }

  /**
   * Destroying the interface frees every body it owns, which is why
   * BodyInterface.DestroyBody is never called - it traps on repeated use.
   */
  protected disposeWorld(): void {
    const J = this.J;
    const jolt = this.jolt;
    this.jolt = null;
    this.ps = null;
    this.bi = null;
    this.ids = [];
    this.tmpPos = null;
    this.tmpRot = null;
    try { if (jolt) J.destroy(jolt); } catch { /* already gone */ }
    // Only the interface is destroyed. Releasing the per-build settings and
    // shape results individually - even in bulk, after the interface is gone -
    // corrupted the embind class table on the very next world ("table index is
    // out of bounds"). Destroying the interface already frees every body,
    // which is where the bulk of the memory lives; the retained settings are
    // small and the reference array is cleared here so nothing keeps them alive.
    this.owned = [];
  }
}

export function create(): PhysicsEngineBase {
  return new JoltEngine();
}
