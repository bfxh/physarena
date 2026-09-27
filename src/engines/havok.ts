import type { EngineMeta, EngineStats, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, quatOr } from './shared';

export const meta: EngineMeta = {
  id: 'havok',
  name: 'Havok',
  language: 'C++',
  backend: 'WASM',
  license: 'MIT (WASM 版本)',
  homepage: 'https://github.com/BabylonJS/Havok',
  accent: '#8a4bff',
  blurb: 'AAA 游戏里跑了几十年的商业引擎，微软 2023 年放出免费 WASM 版。API 是扁平的 C 风格 HP_* 函数。', // naming:allow（AAA 游戏 = 行业术语，非占位）
  solver: 'Havok 专有约束求解器（多线程 + 大规模岛式）',
  status: 'stable',
  capabilities: {
    shapes: ['box', 'sphere', 'capsule', 'cylinder', 'convex', 'trimesh'],
    joints: ['fixed', 'revolute', 'prismatic', 'spherical', 'distance'],
    ccd: false,
    sensors: false,
    memoryReport: true,
  },
};

class HavokEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private hk: any;
  private world: any = null;
  private bodyIds: any[] = [];
  private shapes: any[] = [];
  private shapeCache = new Map<string, any>();
  private byId = new Map<string, any>();
  private allocations: number[] = [];
  private constraints: any[] = [];

  async init(): Promise<void> {
    const mod: any = await import('@babylonjs/havok');
    const HavokPhysics = mod.default ?? mod;
    this.hk = await HavokPhysics({
      locateFile: () => `${import.meta.env.BASE_URL}vendor/havok/HavokPhysics.wasm`,
    });
  }

  // ---- motion types -------------------------------------------------------
  // The embind enum classes exist on the module, but their members are opaque
  // objects, so the raw ABI values are used as a fallback and kept in one place.
  private get MT() {
    const m = this.hk?.MotionType;
    return {
      STATIC: m?.STATIC ?? 1,
      KINEMATIC: m?.KINEMATIC ?? 2,
      DYNAMIC: m?.DYNAMIC ?? 4,
    };
  }

  private get AXIS() {
    const a = this.hk?.ConstraintAxis;
    return {
      LIN_X: a?.LINEAR_X ?? 0, LIN_Y: a?.LINEAR_Y ?? 1, LIN_Z: a?.LINEAR_Z ?? 2,
      ANG_X: a?.ANGULAR_X ?? 3, ANG_Y: a?.ANGULAR_Y ?? 4, ANG_Z: a?.ANGULAR_Z ?? 5,
      DIST: a?.LINEAR_DISTANCE ?? 6,
    };
  }

  private get MODE() {
    const m = this.hk?.ConstraintAxisLimitMode;
    return { FREE: m?.FREE ?? 0, LIMITED: m?.LIMITED ?? 1, LOCKED: m?.LOCKED ?? 2 };
  }

  private shapeKey(shape: ShapeDesc, density: number): string {
    // The map key is only ever compared for equality, so the full serialized
    // shape is used directly. The previous 7-character-stride hash could make
    // two different hulls collide, and the second body would silently get the
    // first body's collider.
    return `${JSON.stringify(shape)}:${density}`;
  }

  private mallocF32(values: ArrayLike<number>): number {
    const ptr = this.hk._malloc(values.length * 4);
    this.hk.HEAPF32.set(values as any, ptr >> 2);
    this.allocations.push(ptr);
    return ptr;
  }

  private buildShape(shape: ShapeDesc, density: number): any {
    const hk = this.hk;
    const key = this.shapeKey(shape, density);
    const hit = this.shapeCache.get(key);
    if (hit) return hit;

    let id: any;
    switch (shape.kind) {
      case 'box':
        id = hk.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [
          shape.halfExtents[0] * 2, shape.halfExtents[1] * 2, shape.halfExtents[2] * 2,
        ])[1];
        break;
      case 'sphere':
        id = hk.HP_Shape_CreateSphere([0, 0, 0], shape.radius)[1];
        break;
      case 'capsule':
        id = hk.HP_Shape_CreateCapsule(
          [0, -shape.halfHeight, 0], [0, shape.halfHeight, 0], shape.radius,
        )[1];
        break;
      case 'cylinder':
        id = hk.HP_Shape_CreateCylinder(
          [0, -shape.halfHeight, 0], [0, shape.halfHeight, 0], shape.radius,
        )[1];
        break;
      case 'convex': {
        const n = Math.floor(shape.points.length / 3);
        const ptr = this.mallocF32(shape.points);
        id = hk.HP_Shape_CreateConvexHull(ptr, n)[1];
        break;
      }
      case 'trimesh': {
        const nVerts = Math.floor(shape.vertices.length / 3);
        const vPtr = this.mallocF32(shape.vertices);
        const tPtr = hk._malloc(shape.indices.length * 4);
        this.allocations.push(tPtr);
        const u32 = hk.HEAPU32 ?? hk.HEAP32;
        u32.set(shape.indices as any, tPtr >> 2);
        id = hk.HP_Shape_CreateMesh(vPtr, nVerts, tPtr, Math.floor(shape.indices.length / 3))[1];
        break;
      }
      default:
        id = hk.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [0.5, 0.5, 0.5])[1];
        break;
    }
    if (!id) throw new Error('havok shape creation failed');
    try { hk.HP_Shape_SetDensity(id, density); } catch { /* default density stays */ }
    this.shapes.push(id);
    this.shapeCache.set(key, id);
    return id;
  }

  protected buildWorld(desc: WorldDesc): void {
    const hk = this.hk;
    this.world = hk.HP_World_Create()[1];
    hk.HP_World_SetGravity(this.world, [...desc.gravity]);

    this.bodyIds = [];
    this.byId.clear();
    this.shapeCache.clear();
    this.shapes = [];
    this.allocations = [];

    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);

      let shape: any;
      try {
        shape = this.buildShape(adapted.shape, b.density ?? 1000);
      } catch {
        shape = this.buildShape({ kind: 'box', halfExtents: [0.3, 0.3, 0.3] }, b.density ?? 1000);
        this.notes.add('形状创建失败→盒');
      }

      const [, body] = hk.HP_Body_Create();
      hk.HP_Body_SetShape(body, shape);
      hk.HP_Body_SetMotionType(
        body,
        b.type === 'dynamic' ? this.MT.DYNAMIC : b.type === 'kinematic' ? this.MT.KINEMATIC : this.MT.STATIC,
      );
      if (b.type !== 'static') {
        // The IR's explicit `mass` wins over the density-derived one; the
        // inertia in Havok's mass-properties array is stored "for mass of 1"
        // and is scaled by the mass element at solve time.
        const mp = hk.HP_Shape_BuildMassProperties(shape)[1];
        if (b.mass != null) mp[1] = b.mass;
        hk.HP_Body_SetMassProperties(body, mp);
      }
      if (b.ccd && b.type === 'dynamic') {
        this.notes.add('Havok：不支持 CCD，高速弹丸按离散碰撞运行');
      }
      if (b.sensor) {
        this.notes.add('Havok：不支持传感器，触发体按实心刚体运行');
      }
      const q = quatOr(b.rotation);
      hk.HP_Body_SetQTransform(body, [[...b.position], [q[0], q[1], q[2], q[3]]]);
      if (b.linearDamping) hk.HP_Body_SetLinearDamping(body, b.linearDamping);
      if (b.angularDamping) hk.HP_Body_SetAngularDamping(body, b.angularDamping);
      if (b.type !== 'static') {
        if (b.velocity) hk.HP_Body_SetLinearVelocity(body, [...b.velocity]);
        if (b.angularVelocity) hk.HP_Body_SetAngularVelocity(body, [...b.angularVelocity]);
      }
      hk.HP_World_AddBody(this.world, body, false);
      this.bodyIds.push(body);
      this.byId.set(b.id, body);
    }

    for (const j of desc.joints) {
      const A = this.byId.get(j.bodyA);
      const B = this.byId.get(j.bodyB);
      if (!A || !B) { this.markSkippedJoint(); continue; }
      try {
        this.createConstraint(j, A, B);
      } catch {
        this.markSkippedJoint();
      }
    }
  }

  /**
   * Havok has no revolute/spherical/fixed factories - every joint is a generic
   * constraint whose six axes are individually set free, limited or locked.
   */
  private createConstraint(j: any, A: any, B: any): void {
    const hk = this.hk;
    const ax = this.AXIS;
    const md = this.MODE;
    const axis = (j.axis ?? [0, 1, 0]) as Vec3;
    const normal: Vec3 = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];

    const [, c] = hk.HP_Constraint_Create();
    this.constraints.push(c);
    hk.HP_Constraint_SetParentBody(c, A);
    hk.HP_Constraint_SetChildBody(c, B);
    hk.HP_Constraint_SetAnchorInParent(c, [...j.anchorA], [1, 0, 0], [0, 1, 0]);
    hk.HP_Constraint_SetAnchorInChild(c, [...j.anchorB], [1, 0, 0], [0, 1, 0]);
    hk.HP_Constraint_SetCollisionsEnabled(c, 0);

    const lockAll = () => {
      for (const a of [ax.LIN_X, ax.LIN_Y, ax.LIN_Z, ax.ANG_X, ax.ANG_Y, ax.ANG_Z]) {
        hk.HP_Constraint_SetAxisMode(c, a, md.LOCKED);
      }
    };

    switch (j.kind) {
      case 'fixed':
        lockAll();
        break;
      case 'revolute':
        for (const a of [ax.LIN_X, ax.LIN_Y, ax.LIN_Z, ax.ANG_Y, ax.ANG_Z]) {
          hk.HP_Constraint_SetAxisMode(c, a, md.LOCKED);
        }
        if (j.limits) {
          hk.HP_Constraint_SetAxisMode(c, ax.ANG_X, md.LIMITED);
          hk.HP_Constraint_SetAxisMinLimit(c, ax.ANG_X, j.limits[0]);
          hk.HP_Constraint_SetAxisMaxLimit(c, ax.ANG_X, j.limits[1]);
        } else {
          hk.HP_Constraint_SetAxisMode(c, ax.ANG_X, md.FREE);
        }
        if (j.motor) {
          try {
            hk.HP_Constraint_SetAxisMotorType(c, ax.ANG_X, this.hk.ConstraintMotorType?.VELOCITY ?? 1);
            hk.HP_Constraint_SetAxisMotorVelocityTarget(c, ax.ANG_X, j.motor.targetVelocity);
            hk.HP_Constraint_SetAxisMotorMaxForce(c, ax.ANG_X, j.motor.maxForce);
          } catch { this.notes.add('Havok 电机未启用'); }
        }
        break;
      case 'prismatic':
        for (const a of [ax.LIN_Y, ax.LIN_Z, ax.ANG_X, ax.ANG_Y, ax.ANG_Z]) {
          hk.HP_Constraint_SetAxisMode(c, a, md.LOCKED);
        }
        hk.HP_Constraint_SetAxisMode(c, ax.LIN_X, j.limits ? md.LIMITED : md.FREE);
        if (j.limits) {
          hk.HP_Constraint_SetAxisMinLimit(c, ax.LIN_X, j.limits[0]);
          hk.HP_Constraint_SetAxisMaxLimit(c, ax.LIN_X, j.limits[1]);
        }
        break;
      case 'spherical':
        for (const a of [ax.LIN_X, ax.LIN_Y, ax.LIN_Z]) {
          hk.HP_Constraint_SetAxisMode(c, a, md.LOCKED);
        }
        break;
      case 'distance':
      case 'spring': {
        const rest = j.restLength ?? 1;
        for (const a of [ax.LIN_X, ax.LIN_Y, ax.LIN_Z, ax.ANG_X, ax.ANG_Y, ax.ANG_Z]) {
          hk.HP_Constraint_SetAxisMode(c, a, md.FREE);
        }
        hk.HP_Constraint_SetAxisMode(c, ax.DIST, md.LIMITED);
        hk.HP_Constraint_SetAxisMinLimit(c, ax.DIST, rest);
        hk.HP_Constraint_SetAxisMaxLimit(c, ax.DIST, rest);
        this.notes.add('Havok 距离约束用 LINEAR_DISTANCE 轴模拟（刚度/阻尼未建模）');
        break;
      }
      default:
        this.markSkippedJoint();
        return;
    }
    hk.HP_Constraint_SetEnabled(c, 1);
  }

  protected stepWorld(dt: number): void {
    this.hk.HP_World_Step(this.world, dt);
  }

  protected syncStates(): void {
    const hk = this.hk;
    const active = hk.ActivationState?.ACTIVE;
    for (let i = 0; i < this.bodyIds.length; i++) {
      const s = this.states[i];
      if (!s) continue;
      const [, qt] = hk.HP_Body_GetQTransform(this.bodyIds[i]);
      if (!qt) continue;
      const p = qt[0];
      const q = qt[1];
      s.position[0] = p[0]; s.position[1] = p[1]; s.position[2] = p[2];
      s.rotation[0] = q[0]; s.rotation[1] = q[1]; s.rotation[2] = q[2]; s.rotation[3] = q[3];
      const dyn = this.desc?.bodies[i]?.type === 'dynamic';
      if (dyn) {
        // Real velocities; fixed/kinematic bodies report `undefined` so they
        // cannot count as sleeping and skew the awake fraction.
        try {
          const lv = hk.HP_Body_GetLinearVelocity(this.bodyIds[i]);
          const av = hk.HP_Body_GetAngularVelocity(this.bodyIds[i]);
          if (lv?.[1]) s.linearVelocity = [lv[1][0], lv[1][1], lv[1][2]] as Vec3;
          if (av?.[1]) s.angularVelocity = [av[1][0], av[1][1], av[1][2]] as Vec3;
        } catch { /* leave the seeded zeros */ }
        if (active !== undefined) {
          try {
            const st = hk.HP_Body_GetActivationState(this.bodyIds[i])[1];
            s.sleeping = st !== active;
          } catch { /* ignore */ }
        }
      } else {
        s.sleeping = undefined;
      }
    }
  }

  applyImpulse(index: number, impulse: Vec3): void {
    const b = this.bodyIds[index];
    if (!b) return;
    try { this.hk.HP_Body_ApplyImpulse(b, [0, 0, 0], [...impulse]); } catch { /* ignore */ }
  }

  stats(): EngineStats {
    return {
      bodyCount: this.bodyIds.length,
      memoryBytes: this.hk?.HEAPU8?.byteLength,
      notes: {
        memoryBytes:
          'wasm 堆容量（HEAPU8.byteLength），不是使用量；该构建的堆尺寸固定，因此不随场景变化',
      },
    };
  }

  protected disposeWorld(): void {
    if (!this.hk) return;
    try {
      for (const ptr of this.allocations) {
        try { this.hk._free(ptr); } catch { /* ignore */ }
      }
      this.allocations = [];
      // Constraints must be released before the bodies they reference.
      for (const c of this.constraints) {
        try { this.hk.HP_Constraint_Release(c); } catch { /* ignore */ }
      }
      this.constraints = [];
      // Bodies are indexed by the world; remove them before releasing so the
      // release never acts on a body the world still references.
      for (const body of this.bodyIds) {
        try { this.hk.HP_World_RemoveBody?.(this.world, body); } catch { /* ignore */ }
        try { this.hk.HP_Body_Release(body); } catch { /* ignore */ }
      }
      // Shapes must outlive their bodies.
      for (const s of this.shapes) {
        try { this.hk.HP_Shape_Release(s); } catch { /* ignore */ }
      }
      if (this.world) {
        this.hk.HP_World_Release(this.world);
        this.world = null;
      }
    } catch { /* ignore */ }
    this.bodyIds = [];
    this.shapes = [];
    this.shapeCache.clear();
    this.byId.clear();
  }
}

export function create(): PhysicsEngineBase {
  return new HavokEngine();
}
