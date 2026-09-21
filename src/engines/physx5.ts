import type { BodyDesc, EngineMeta, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, massOf, quatOr, shapeAabb } from './shared';

export const meta: EngineMeta = {
  id: 'physx5',
  name: 'NVIDIA PhysX 5',
  language: 'C++',
  backend: 'WASM',
  license: 'BSD-3-Clause',
  homepage: 'https://github.com/NVIDIA-Omniverse/PhysX',
  accent: '#76b900',
  blurb: 'NVIDIA 的工业级 SDK，直接跑 CUDA 那一套的 CPU 分支。代码量最大、参数量最多，也最难调。',
  solver: 'TGS/PGS + GPU 兼容架构 + 刻度化接触求解',
  status: 'stable',
  capabilities: {
    // No cylinder: this WebIDL build has no PxCylinderGeometry (verified at
    // runtime), so a cylinder must degrade through adaptShape (cylinder ->
    // convex -> AABB box) with an explicit note, not land in the size-blind
    // 0.3 m box fallback of geometries(). Same for cone/convex/compound.
    shapes: ['box', 'sphere', 'capsule', 'trimesh'],
    joints: ['fixed', 'revolute', 'prismatic', 'spherical', 'distance'],
    // PhysX has CCD, but through physx-js-webidl 5.6 it does not stop a
    // 240 m/s projectile (4 m per 1/60 s step): measured with the scene flag,
    // the body flag, a 4 MB scratch block and ccdMaxPasses=4 all enabled, the
    // box still ended at the unobstructed position (x = 466 m), while a slow
    // control (15 m/s) stops at the wall - so collision works, the CCD pass
    // does not. Same policy as Jolt's joints: do not advertise what the
    // integration cannot deliver (the flags are still set - see buildWorld).
    ccd: false,
    sensors: true,
    memoryReport: true,
  },
};

class PhysX5Engine extends PhysicsEngineBase {
  readonly meta = meta;
  private P: any;
  private T: any;
  private foundation: any;
  private physics: any;
  private tolerances: any;
  private scene: any;
  private actors: any[] = [];
  private byId = new Map<string, any>();
  private material: any;
  /**
   * Per-build PhysX objects that outlive their user (geometry, cooked trimesh,
   * cooking params, scene material). removeActor does NOT release an actor, and
   * a released scene does not free these, so leaving them untracked grew the
   * wasm heap monotonically as scenarios were switched.
   */
  private geoms: any[] = [];
  private cooked: any[] = [];
  private materials: any[] = [];
  /** Scratch block for the CCD pass (0 = none allocated for this world). */
  private scratchPtr = 0;
  private scratchSize = 0;
  /**
   * PxRigidBodyExt is a WebIDL class: its members live on the prototype and
   * the class itself cannot be constructed with `new`, so the canonical
   * receiver is Object.create(prototype).
   */
  private get rbe(): any {
    if (!this._rbe) this._rbe = Object.create(this.P.PxRigidBodyExt.prototype);
    return this._rbe;
  }

  private _rbe: any = null;
  /** PxFilterData(1, ~0, 0, 0) - see the note in `filterData`. */
  private filterData: any = null;

  async init(): Promise<void> {
    const mod: any = await import('physx-js-webidl');
    const PhysXInit = mod.default ?? mod;
    // The published build is browser-only; the wasm is served from /vendor so
    // the URL is identical in dev and in the production bundle.
    this.P = await PhysXInit({ locateFile: () => '/vendor/physx/physx-js-webidl.wasm' });
    // This WebIDL build flattens PxTopLevelFunctions' statics onto the
    // module object itself; the namespaced layout only exists in some
    // builds, so both are supported.
    const tlf = this.P.PxTopLevelFunctions;
    this.T = tlf && typeof tlf.CreateFoundation === 'function' ? tlf : this.P;
    this.foundation = this.T.CreateFoundation(
      this.T.PHYSICS_VERSION,
      new this.P.PxDefaultAllocator(),
      new this.P.PxDefaultErrorCallback(),
    );
    this.tolerances = new this.P.PxTolerancesScale();
    this.physics = this.T.CreatePhysics(this.T.PHYSICS_VERSION, this.foundation, this.tolerances);
  }

  /**
   * HEAPF32 is not in this build's EXPORTED_RUNTIME_METHODS, so the float and
   * int views are derived from HEAPU8's buffer - and re-derived on every call,
   * because a wasm heap growth detaches the old view.
   */
  private floatHeap(): Float32Array {
    return new Float32Array((this.P.HEAPU8 as Uint8Array).buffer);
  }

  private intHeap(): Int32Array {
    return new Int32Array((this.P.HEAPU8 as Uint8Array).buffer);
  }

  /** Writes a flat float array into the wasm heap and returns its pointer. */
  private writeFloats(values: ArrayLike<number>): number {
    if (typeof this.P._malloc !== 'function') throw new Error('wasm _malloc 不可用');
    const ptr = this.P._malloc(values.length * 4);
    this.floatHeap().set(values as any, ptr >> 2);
    this.freeLater.push(ptr);
    return ptr;
  }

  private freeLater: number[] = [];

  private cookTrimesh(vertices: number[], indices: number[]): any {
    const vPtr = this.writeFloats(vertices);
    const triPtr = this.P._malloc(indices.length * 4);
    this.intHeap().set(indices as any, triPtr >> 2);
    this.freeLater.push(triPtr);

    const desc = new this.P.PxTriangleMeshDesc();
    desc.setToDefault();
    desc.points.count = Math.floor(vertices.length / 3);
    desc.points.stride = 12;
    desc.points.data = vPtr;
    desc.triangles.count = Math.floor(indices.length / 3);
    desc.triangles.stride = 12;
    desc.triangles.data = triPtr;
    const cook = new this.P.PxCookingParams(this.tolerances);
    const mesh = this.T.CreateTriangleMesh(cook, desc);
    if (!mesh) throw new Error('trimesh cook failed');
    this.cooked.push(cook, mesh);
    return new this.P.PxTriangleMeshGeometry(mesh);
  }

  private geometries(shape: ShapeDesc): { geom: any; offset?: Vec3; rot?: any }[] {
    const P = this.P;
    switch (shape.kind) {
      case 'box':
        return [{ geom: new P.PxBoxGeometry(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]) }];
      case 'sphere':
        return [{ geom: new P.PxSphereGeometry(shape.radius) }];
      case 'capsule':
        return [{ geom: new P.PxCapsuleGeometry(shape.radius, shape.halfHeight) }];
      case 'trimesh':
        return [{ geom: this.cookTrimesh(shape.vertices, shape.indices) }];
      case 'compound': {
        const out: { geom: any; offset?: Vec3; rot?: any }[] = [];
        for (const c of shape.children) {
          for (const g of this.geometries(c.shape)) {
            out.push({ geom: g.geom, offset: [c.offset[0], c.offset[1], c.offset[2]], rot: quatOr(c.rotation) });
          }
        }
        return out;
      }
      default:
        return [{ geom: new P.PxBoxGeometry(0.25, 0.25, 0.25) }];
    }
  }

  protected buildWorld(desc: WorldDesc): void {
    const P = this.P;

    const sd = new P.PxSceneDesc(this.tolerances);
    sd.setToDefault(this.tolerances);
    sd.gravity = new P.PxVec3(desc.gravity[0], desc.gravity[1], desc.gravity[2]);
    sd.cpuDispatcher = this.T.DefaultCpuDispatcherCreate(0);
    sd.filterShader = this.T.DefaultFilterShader();
    // CCD must be enabled on the SCENE as well: a body-level eENABLE_CCD alone
    // did not stop the 240 m/s projectile (it tunneled to x = 466 m in the
    // CCD probe). Native PhysX pairs eENABLE_CCD with eENABLE_ACTIVE_ACTORS.
    if (desc.bodies.some((b) => b.ccd)) {
      try {
        sd.flags.raise(P.PxSceneFlagEnum.eENABLE_CCD);
        sd.flags.raise(P.PxSceneFlagEnum.eENABLE_ACTIVE_ACTORS);
        // More than one CCD pass so a fast body is still caught after the
        // first sweep changes its trajectory.
        sd.ccdMaxPasses = 4;
        // PhysX's CCD pass runs in the scratch buffer passed to simulate();
        // without one it is silently skipped (the body-level flag alone does
        // nothing, which is how the 240 m/s projectile reached x = 466 m).
        this.scratchSize = 4 * 1024 * 1024;
        this.scratchPtr = this.P._malloc(this.scratchSize);
        this.freeLater.push(this.scratchPtr);
      } catch (e) {
        this.notes.add(`PhysX CCD 初始化失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.scene = this.physics.createScene(sd);

    this.actors = [];
    this.byId.clear();
    this.freeLater = [];
    this.geoms = [];
    this.cooked = [];
    this.materials = [];
    // A per-scene material keeps friction/restitution in the ballpark of the
    // other engines; PhysX combines materials rather than per-body coefficients.
    this.material = this.physics.createMaterial(0.6, 0.6, 0.05);
    this.materials.push(this.material);
    // PxDefaultSimulationFilterShader suppresses every pair whose filter
    // groups do not match, and all-zero filter data never matches. Without
    // this line nothing collides and every body free-falls forever.
    if (!this.filterData) this.filterData = new P.PxFilterData(1, 0xffffffff, 0, 0);

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);

      // PxTransform has no single-PxVec3 overload. `new PxTransform(vec)`
      // silently resolves to the PxIDENTITYEnum overload and yields the
      // identity transform, which put every body at the origin.
      const pose = new P.PxTransform(
        new P.PxVec3(b.position[0], b.position[1], b.position[2]),
        new P.PxQuat(...quatOr(b.rotation)),
      );

      let actor: any;
      try {
        actor = b.type === 'static'
          ? this.physics.createRigidStatic(pose)
          : this.physics.createRigidDynamic(pose);
      } catch {
        // A failed dynamic must never masquerade as a static body: the cell
        // would report a plausible time and hash for a different scene.
        actor = this.physics.createRigidStatic(pose);
        this.notes.add('PhysX 动态刚体创建失败，已降级为静态（场景内容与其它引擎不同）');
      }

      let geoms: { geom: any; offset?: Vec3; rot?: any }[] = [];
      try {
        geoms = this.geometries(adapted.shape);
      } catch {
        // Size the fallback from the real shape, not a fixed 0.3 m cube.
        const bb = shapeAabb(adapted.shape);
        this.notes.add('网格形状烘焙失败→盒');
        geoms = [{
          geom: new P.PxBoxGeometry(
            Math.max(0.02, (bb.max[0] - bb.min[0]) / 2),
            Math.max(0.02, (bb.max[1] - bb.min[1]) / 2),
            Math.max(0.02, (bb.max[2] - bb.min[2]) / 2),
          ),
        }];
      }
      for (const g of geoms) this.geoms.push(g.geom);

      for (const g of geoms) {
        const shape = this.physics.createShape(g.geom, this.material, true);
        if (g.offset || g.rot) {
          shape.setLocalPose(new P.PxTransform(
            new P.PxVec3(g.offset?.[0] ?? 0, g.offset?.[1] ?? 0, g.offset?.[2] ?? 0),
            new P.PxQuat(...(g.rot ?? [0, 0, 0, 1])),
          ));
        }
        try { shape.setSimulationFilterData(this.filterData); } catch { /* binding differs */ }
        if (b.sensor) {
          try { shape.setFlag(P.PxShapeFlagEnum.eTRIGGER_SHAPE, true); } catch { /* older enum name */ }
        }
        actor.attachShape(shape);
      }

      if (b.type !== 'static') {
        if (b.type === 'dynamic') {
          try {
            if (b.mass != null) this.rbe.setMassAndUpdateInertia(actor, b.mass);
            else this.rbe.updateMassAndInertia(actor, b.density ?? 1000);
          } catch { /* mass stays default */ }
        }
        actor.setLinearDamping(b.linearDamping ?? 0);
        actor.setAngularDamping(b.angularDamping ?? 0.05);
        if (b.velocity) actor.setLinearVelocity(new P.PxVec3(...b.velocity), true);
        if (b.angularVelocity) actor.setAngularVelocity(new P.PxVec3(...b.angularVelocity), true);
        if (b.type === 'kinematic') {
          try { actor.setRigidBodyFlag(P.PxRigidBodyFlagEnum.eKINEMATIC, true); } catch { /* flag differs */ }
        }
        if (b.type === 'dynamic' && b.ccd) {
          try { actor.setRigidBodyFlag(P.PxRigidBodyFlagEnum.eENABLE_CCD, true); } catch { this.notes.add('PhysX CCD 标志设置失败'); }
        }
      }

      this.scene.addActor(actor);
      this.actors.push(actor);
      this.byId.set(b.id, actor);
    }

    // Joints need both actors to already be in the scene.
    for (const j of desc.joints) {
      const A = this.byId.get(j.bodyA);
      const B = this.byId.get(j.bodyB);
      if (!A || !B) { this.markSkippedJoint(); continue; }
      const idq = new P.PxQuat(0, 0, 0, 1);
      const lfA = new P.PxTransform(new P.PxVec3(...j.anchorA), idq);
      const lfB = new P.PxTransform(new P.PxVec3(...j.anchorB), idq);
      try {
        switch (j.kind) {
          case 'fixed': this.T.FixedJointCreate(this.physics, A, lfA, B, lfB); break;
          case 'revolute': {
            const joint = this.T.RevoluteJointCreate(this.physics, A, lfA, B, lfB);
            if (j.motor) {
              try {
                joint.setRevoluteJointFlag(P.PxRevoluteJointFlagEnum.eDRIVE_ENABLED, true);
                joint.setDriveVelocity(j.motor.targetVelocity, true);
                joint.setDriveForceLimit?.(j.motor.maxForce);
              } catch { this.notes.add('PhysX 电机未启用'); }
            }
            break;
          }
          case 'prismatic': {
            const joint = this.T.PrismaticJointCreate(this.physics, A, lfA, B, lfB);
            if (j.motor) {
              try {
                joint.setPrismaticJointFlag(P.PxPrismaticJointFlagEnum.eDRIVE_ENABLED, true);
                joint.setDriveVelocity(j.motor.targetVelocity, true);
                joint.setDriveForceLimit?.(j.motor.maxForce);
              } catch { /* ignore */ }
            }
            break;
          }
          case 'spherical': {
            const joint = this.T.SphericalJointCreate(this.physics, A, lfA, B, lfB);
            if (j.limits) {
              try {
                // A cone is symmetric; using limits[1] twice discarded the
                // lower bound. The tighter bound is applied and the mismatch
                // with the other engines is stated.
                const cone = Math.min(Math.abs(j.limits[0]), Math.abs(j.limits[1]));
                joint.setLimitCone(new P.PxJointLimitCone(cone, cone, 0.05));
                joint.setSphericalJointFlag(P.PxSphericalJointFlagEnum.eLIMIT_ENABLED, true);
                this.notes.add('PhysX 球关节应用锥形限位（锥角取上下限较小者；其余引擎未应用球关节限位）');
              } catch { /* ignore */ }
            }
            break;
          }
          case 'distance': case 'spring': {
            const joint = this.T.DistanceJointCreate(this.physics, A, lfA, B, lfB);
            const rest = j.restLength ?? 0.5;
            try {
              joint.setMinDistance(rest);
              joint.setMaxDistance(rest);
              joint.setStiffness(j.stiffness ?? 1);
              joint.setDamping(j.damping ?? 0.1);
            } catch { /* ignore */ }
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
    try {
      // The scratch block is what makes the CCD pass possible; the size must
      // accompany it (see PxScene.simulate in the binding).
      this.scene.simulate(dt, null, this.scratchPtr, this.scratchSize, true);
    } catch {
      this.scene.simulate(dt);
    }
    this.scene.fetchResults(true);
  }

  protected syncStates(): void {
    for (let i = 0; i < this.actors.length; i++) {
      const s = this.states[i];
      if (!s) continue;
      const actor = this.actors[i];
      if (!actor.getGlobalPose) {
        // static actors created via createRigidStatic still expose the pose
        continue;
      }
      const pose = actor.getGlobalPose();
      s.position[0] = pose.p.x; s.position[1] = pose.p.y; s.position[2] = pose.p.z;
      s.rotation[0] = pose.q.x; s.rotation[1] = pose.q.y;
      s.rotation[2] = pose.q.z; s.rotation[3] = pose.q.w;
      if (actor.getLinearVelocity) {
        const lv = actor.getLinearVelocity();
        s.linearVelocity![0] = lv.x; s.linearVelocity![1] = lv.y; s.linearVelocity![2] = lv.z;
      }
      if (actor.getAngularVelocity) {
        const av = actor.getAngularVelocity();
        s.angularVelocity![0] = av.x; s.angularVelocity![1] = av.y; s.angularVelocity![2] = av.z;
      }
      s.sleeping = typeof actor.isSleeping === 'function' ? actor.isSleeping() : false;
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const actor = this.actors[index];
    if (!actor?.addForce) return;
    try {
      this.rbe.addForceAtPos(
        actor,
        new this.P.PxVec3(...impulse),
        actor.getGlobalPose().p,
        this.P.PxForceModeEnum.eIMPULSE,
        true,
      );
    } catch { /* ignore */ }
  }

  stats() {
    return {
      bodyCount: this.actors.length,
      memoryBytes: (this.P as any)?.HEAPU8?.byteLength ?? undefined,
    };
  }

  /** This build exports _malloc but not _free; _webidl_free is the fallback. */
  private freePtr(ptr: number): void {
    try {
      const free = this.P._free ?? this.P._webidl_free;
      free?.(ptr);
    } catch { /* ignore */ }
  }

  /**
   * Drops the scene but keeps PxFoundation/PxPhysics alive, because a released
   * PxPhysics cannot create new scenes and re-instantiating the whole SDK on
   * every scenario change would pollute the benchmark.
   */
  protected disposeWorld(): void {
    if (!this.P) return;
    try {
      if (this.scene) {
        for (const a of this.actors) {
          try { this.scene.removeActor(a); } catch { /* ignore */ }
          // removeActor does not release; shapes attached with isExclusive are
          // freed with the actor.
          try { a.release?.(); } catch { /* ignore */ }
        }
      }
      // Geometries/material/cooked meshes are caller-owned and must be released
      // after the shapes that reference them are gone.
      const releaseAll = (list: any[]) => {
        for (const o of list) {
          try { o?.release?.(); } catch { /* ignore */ }
        }
      };
      releaseAll(this.geoms);
      releaseAll(this.cooked);
      releaseAll(this.materials);
      this.material = null;
      if (this.scene) {
        this.scene.release();
        this.scene = null;
      }
      for (const ptr of this.freeLater) {
        this.freePtr(ptr);
      }
    } catch { /* ignore */ }
    this.freeLater = [];
    this.actors = [];
    this.geoms = [];
    this.cooked = [];
    this.materials = [];
    this.scratchPtr = 0;
    this.scratchSize = 0;
    this.byId.clear();
  }
}

export function create(): PhysicsEngineBase {
  return new PhysX5Engine();
}
