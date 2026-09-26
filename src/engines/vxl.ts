import type { BodyDesc, EngineMeta, ShapeDesc, Vec3, WorldDesc } from '../core/types';
import { PhysicsEngineBase } from './base';
import { adaptShape, massOf, quatOr, shapeAabb } from './shared';

/** 四元数旋转（局部点 → 父体局部；复合体并集凸包用）。 */
function rotateByQuat(v: Vec3, q: [number, number, number, number]): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** IR joint kind -> bridge code (see `vxl_joint_add` in wasm-bridge/src/lib.rs). */
const JOINT_CODES: Record<string, number> = {
  spherical: 0,
  revolute: 1,
  fixed: 2,
  prismatic: 3,
  distance: 4,
  // No soft-constraint solver on the engine side yet: a spring becomes a rigid
  // distance joint and says so, rather than silently behaving like one.
  spring: 4,
};

/**
 * The 9th contender: **vxl-phys**, the engine this lab was built alongside
 * (Rust, zero external dependencies, `#![forbid(unsafe_code)]`, bitwise
 * reproducible for a fixed input).
 *
 * It runs from a purpose-built wasm bridge (`wasm-bridge/`, built by
 * `npm run build:vxl`) whose ABI is batch-oriented: one call per body at build
 * time, and a single bulk read of all poses/velocities per frame.
 */

export const meta: EngineMeta = {
  id: 'vxl-phys',
  name: 'vxl-phys (RUST WL)',
  language: 'Rust',
  backend: 'WASM',
  license: 'Apache-2.0',
  homepage: 'https://github.com/bfxh/RUST-WL',
  accent: '#e0533d',
  blurb: '配套自研引擎：全 f32、零外部依赖、逐位可复现的确定性顺序冲量求解器（增量 BVH + GJK/EPA）。',
  solver: '顺序冲量（软接触 + 摩擦锥）+ 分相管线（2 子步 × 3 迭代 × 内层 1 = 6 扫掠/帧）+ 岛级休眠 + 关节族（球/转动/固定/棱柱/距离，8 迭代）',
  status: 'experimental',
  capabilities: {
    // The bridge exposes box / sphere / capsule / cylinder / cone / convex hull
    // / compound (dynamic). Trimesh degrades to an AABB box with a note.
    shapes: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convex', 'trimesh', 'compound'],
    // Joints are wired through the bridge (spherical/revolute/fixed/prismatic/
    // distance). Limits and motors are NOT implemented engine-side, so the
    // kinds are claimed without their extra parameters - the adapter notes
    // every ignored limits/motor/spring-softness rather than hiding them.
    joints: ['fixed', 'revolute', 'prismatic', 'spherical', 'distance'],
    ccd: true,
    sensors: false,
    memoryReport: false,
  },
};

interface BridgeExports {
  memory: WebAssembly.Memory;
  vxl_abi(): number;
  vxl_world_create(gx: number, gy: number, gz: number, ccd: number, reserve: number): number;
  vxl_world_drop(): number;
  vxl_add_box(hx: number, hy: number, hz: number, px: number, py: number, pz: number, density: number, isStatic: number): number;
  vxl_add_sphere(r: number, px: number, py: number, pz: number, density: number, isStatic: number): number;
  vxl_add_capsule(halfHeight: number, radius: number, px: number, py: number, pz: number, density: number, isStatic: number): number;
  vxl_add_cylinder(halfHeight: number, radius: number, px: number, py: number, pz: number, density: number, isStatic: number): number;
  vxl_add_cone(halfHeight: number, radius: number, px: number, py: number, pz: number, density: number, isStatic: number): number;
  vxl_compound_begin(): number;
  vxl_compound_push_sphere(radius: number, ox: number, oy: number, oz: number): number;
  vxl_compound_push_box(hx: number, hy: number, hz: number, ox: number, oy: number, oz: number): number;
  vxl_compound_commit(px: number, py: number, pz: number, density: number, isStatic: number): number;
  vxl_hull_begin(): number;
  vxl_hull_push(x: number, y: number, z: number): number;
  vxl_hull_commit(px: number, py: number, pz: number, density: number): number;
  vxl_mesh_begin(): number;
  vxl_mesh_push_vertex(x: number, y: number, z: number): number;
  vxl_mesh_push_tri(a: number, b: number, c: number): number;
  vxl_mesh_commit(): number;
  vxl_joint_add(kind: number, a: number, b: number, ahx: number, ahy: number, ahz: number, bhx: number, bhy: number, bhz: number, ax: number, ay: number, az: number, rest: number): number;
  vxl_joint_motor(joint: number, target: number, maxForce: number): number;
  vxl_joint_limit(joint: number, lower: number, upper: number): number;
  vxl_set_rotation(i: number, x: number, y: number, z: number, w: number): number;
  vxl_set_linvel(i: number, x: number, y: number, z: number): number;
  vxl_set_angvel(i: number, x: number, y: number, z: number): number;
  vxl_body_material(i: number, friction: number, restitution: number): number;
  vxl_step(dt: number): number;
  vxl_body_count(): number;
  vxl_read_poses(): number;
  vxl_read_velocities(): number;
  vxl_is_dynamic(i: number): number;
  vxl_sleeping(i: number): number;
}

class VxlEngine extends PhysicsEngineBase {
  readonly meta = meta;
  private ex: BridgeExports | null = null;
  private bodyCount = 0;
  /** True for bodies the engine treats as dynamic (index-aligned with states). */
  private dynamic: boolean[] = [];

  async init(): Promise<void> {
    const url = `${import.meta.env.BASE_URL}vendor/vxl/vxl_phys_wasm.wasm`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `无法加载 ${url}（${res.status}）。先运行 npm run build:vxl 生成桥接 wasm。`,
      );
    }
    const bytes = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as unknown as BridgeExports;
    if (typeof ex.vxl_abi !== 'function') {
      throw new Error('vxl-phys wasm 桥的 ABI 不匹配（缺少 vxl_abi 导出）');
    }
    const abi = ex.vxl_abi();
    if (abi !== 1) throw new Error(`vxl-phys wasm 桥 ABI 版本 ${abi}，本适配器需要 1`);
    this.ex = ex;
  }

  private addShape(shape: ShapeDesc, b: BodyDesc): number {
    const ex = this.ex!;
    const isStatic = b.type === 'static' ? 1 : 0;
    const density = b.type === 'dynamic' ? massOf(b) / Math.max(1e-6, this.volume(shape)) : 0;
    const [px, py, pz] = b.position;
    switch (shape.kind) {
      case 'sphere':
        return ex.vxl_add_sphere(shape.radius, px, py, pz, density, isStatic);
      case 'capsule':
        return ex.vxl_add_capsule(shape.halfHeight, shape.radius, px, py, pz, density, isStatic);
      case 'cylinder':
        return ex.vxl_add_cylinder(shape.halfHeight, shape.radius, px, py, pz, density, isStatic);
      case 'cone':
        return ex.vxl_add_cone(shape.halfHeight, shape.radius, px, py, pz, density, isStatic);
      case 'convex': {
        ex.vxl_hull_begin();
        for (let i = 0; i + 2 < shape.points.length; i += 3) {
          ex.vxl_hull_push(shape.points[i], shape.points[i + 1], shape.points[i + 2]);
        }
        // The hull path through the bridge is dynamic-only; a static hull is
        // degraded to its AABB box (noted below) rather than silently static-failing.
        if (isStatic) {
          const bb = shapeAabb(shape);
          return ex.vxl_add_box(
            Math.max(0.02, (bb.max[0] - bb.min[0]) / 2),
            Math.max(0.02, (bb.max[1] - bb.min[1]) / 2),
            Math.max(0.02, (bb.max[2] - bb.min[2]) / 2),
            px, py, pz, density, isStatic,
          );
        }
        return ex.vxl_hull_commit(px, py, pz, density);
      }
      case 'trimesh': {
        // Static height-field-style terrain → the engine's TriMesh provider
        // (thin-shell semantics + uniform-grid acceleration).
        ex.vxl_mesh_begin();
        for (let i = 0; i + 2 < shape.vertices.length; i += 3) {
          ex.vxl_mesh_push_vertex(shape.vertices[i], shape.vertices[i + 1], shape.vertices[i + 2]);
        }
        for (let i = 0; i + 2 < shape.indices.length; i += 3) {
          ex.vxl_mesh_push_tri(shape.indices[i], shape.indices[i + 1], shape.indices[i + 2]);
        }
        if (ex.vxl_mesh_commit() === 0) return -1; // 提供者体：已在引擎内注册
        this.notes.add('vxl-phys: 三角网提交失败→盒');
        return ex.vxl_add_box(1.0, 0.1, 1.0, px, py, pz, density, isStatic);
      }
      case 'compound': {
        // 引擎侧真复合体（子形状 = 球/盒 + 局部偏移，窄相逐个展开为子对）——不再降级为并集凸包。
        ex.vxl_compound_begin();
        for (const child of shape.children) {
          const [ox, oy, oz] = child.offset ?? [0, 0, 0];
          if (child.rotation) {
            this.notes.add('vxl-phys: 复合体子形状旋转暂不支持→忽略');
          }
          const cs = child.shape;
          if (cs.kind === 'sphere') {
            ex.vxl_compound_push_sphere(cs.radius, ox, oy, oz);
          } else if (cs.kind === 'box') {
            ex.vxl_compound_push_box(
              cs.halfExtents[0], cs.halfExtents[1], cs.halfExtents[2], ox, oy, oz,
            );
          } else {
            this.notes.add(`vxl-phys: 复合体子形状 ${cs.kind} 暂不支持→跳过`);
          }
        }
        return ex.vxl_compound_commit(px, py, pz, density, isStatic);
      }
      case 'box':
      default:
        return ex.vxl_add_box(
          shape.kind === 'box' ? shape.halfExtents[0] : 0.25,
          shape.kind === 'box' ? shape.halfExtents[1] : 0.25,
          shape.kind === 'box' ? shape.halfExtents[2] : 0.25,
          px, py, pz, density, isStatic,
        );
    }
  }

  private volume(shape: ShapeDesc): number {
    switch (shape.kind) {
      case 'box': return 8 * shape.halfExtents[0] * shape.halfExtents[1] * shape.halfExtents[2];
      case 'sphere': return (4 / 3) * Math.PI * shape.radius ** 3;
      // 圆柱段 πr²·2h + 两端半球 (4/3)πr³（密度反推质量用，跨引擎须可比）。
      case 'capsule':
        return Math.PI * shape.radius ** 2 * 2 * shape.halfHeight + (4 / 3) * Math.PI * shape.radius ** 3;
      case 'cylinder':
        return Math.PI * shape.radius ** 2 * 2 * shape.halfHeight;
      // 实心锥：πr²·H/3（H = 2·halfHeight）——密度反推质量用。
      case 'cone':
        return (Math.PI * shape.radius ** 2 * 2 * shape.halfHeight) / 3;
      // 复合体：并集 AABB 盒（与引擎侧 `spawn_compound_body` 的惯量/质量口径一致 ⇒
      // 两侧「密度 ↔ 质量」才可比；精确的按子形状求和待接）。
      case 'compound': {
        const bb = shapeAabb(shape);
        return (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]);
      }
      default: {
        const bb = shapeAabb(shape);
        return Math.max(
          1e-6,
          (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]) * 0.55,
        );
      }
    }
  }

  protected buildWorld(desc: WorldDesc): void {
    const ex = this.ex!;
    // CCD threshold: engage the engine's swept path below 10 m/s only when the
    // scene asks for CCD at all (its own examples use the same style).
    const wantsCcd = desc.bodies.some((b) => b.ccd);
    ex.vxl_world_create(desc.gravity[0], desc.gravity[1], desc.gravity[2], wantsCcd ? 10 : 0, desc.bodies.length);

    this.dynamic = [];
    for (const b of desc.bodies) {
      const adapted = adaptShape(b.shape, meta.capabilities.shapes);
      if (adapted.note) this.notes.add(adapted.note);
      if (adapted.shape.kind === 'convex' && b.type === 'static') {
        this.notes.add('vxl-phys: 静态凸包→盒（桥的壳路径为动态体）');
      }
      const idx = this.addShape(adapted.shape, b);
      if (idx === -1) {
        // 提供者体（三角网）：引擎内部已注册为静态 marker 体；索引对齐由
        // 「一端一桥体」保证（marker 按加入序占位），故照常推入 alignment 表。
        this.dynamic.push(false);
        continue;
      }
      if (idx === 0xffffffff) {
        this.notes.add('vxl-phys: 体创建失败（凸包点不足）');
        continue;
      }
      const q = quatOr(b.rotation);
      if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0 || q[3] !== 1) {
        ex.vxl_set_rotation(idx, q[0], q[1], q[2], q[3]);
      }
      if (b.type !== 'static') {
        if (b.velocity) ex.vxl_set_linvel(idx, b.velocity[0], b.velocity[1], b.velocity[2]);
        if (b.angularVelocity) ex.vxl_set_angvel(idx, b.angularVelocity[0], b.angularVelocity[1], b.angularVelocity[2]);
      }
      ex.vxl_body_material(idx, b.friction ?? 0.5, b.restitution ?? 0.05);
      this.dynamic.push(b.type === 'dynamic');
    }
    this.bodyCount = ex.vxl_body_count();
    if (this.bodyCount !== desc.bodies.length) {
      this.notes.add(`vxl-phys: 桥内体数 ${this.bodyCount} ≠ 场景体数 ${desc.bodies.length}`);
    }
    // Joints go through `vxl_joint_add` (kind codes 0..4). Anchors and axes are
    // body-local on both sides of the boundary, so nothing needs converting.
    const indexOf = new Map<string, number>();
    desc.bodies.forEach((b, i) => indexOf.set(b.id, i));
    // 关节索引 = 添加序号（桥侧按 `vxl_joint_add` 调用顺序建表；马达按此索引装配）。
    let jointIndex = 0;
    for (const j of desc.joints) {
      const ia = indexOf.get(j.bodyA);
      const ib = indexOf.get(j.bodyB);
      if (ia == null || ib == null) { this.markSkippedJoint(); continue; }
      // 'spring' has no engine-side soft constraint yet; the closest honest
      // mapping is a rigid distance joint, flagged rather than silently soft.
      const kindCode = JOINT_CODES[j.kind];
      if (kindCode == null) { this.markSkippedJoint(); continue; }
      const axis = j.axis ?? [0, 0, 1];
      const rc = ex.vxl_joint_add(
        kindCode, ia, ib,
        j.anchorA[0], j.anchorA[1], j.anchorA[2],
        j.anchorB[0], j.anchorB[1], j.anchorB[2],
        axis[0], axis[1], axis[2],
        j.restLength ?? 0,
      );
      if (rc !== 0) { this.markSkippedJoint(); continue; }
      if (j.motor && (j.kind === 'revolute' || j.kind === 'prismatic')) {
        // 速度马达（目标角速度/线速度 + 力钳）；引擎侧已按 max_force·dt 上钳。
        const mrc = ex.vxl_joint_motor(jointIndex, j.motor.targetVelocity, j.motor.maxForce);
        if (mrc !== 0) this.notes.add('vxl-phys: 马达装配失败（索引越界？）');
      }
      if (j.limits && (j.kind === 'revolute' || j.kind === 'prismatic')) {
        // 转动限位（rad，绕自由轴）/ 棱柱行程限位（m，沿轴）：引擎侧都用**当前
        // 相对姿态/锚点几何**直接算，无跨帧累计状态 ⇒ 无漂移。
        const lrc = ex.vxl_joint_limit(jointIndex, j.limits[0], j.limits[1]);
        if (lrc !== 0) this.notes.add('vxl-phys: 限位装配失败（索引越界？）');
      }
      if (j.kind === 'spring') {
        this.notes.add('vxl-phys: spring→刚性距离（stiffness/damping 未实现）');
      }
      jointIndex++;
    }
  }

  protected stepWorld(dt: number): void {
    const rc = this.ex!.vxl_step(dt);
    if (rc !== 0) {
      // The engine runs a fixed 1/60 step; a different dt must fail loudly
      // rather than silently change the benchmark's dt contract.
      throw new Error(`vxl-phys: 固定步不匹配（收到 dt=${dt}，引擎步长 ${1 / 60}）`);
    }
  }

  protected syncStates(): void {
    const ex = this.ex!;
    const n = this.bodyCount;
    const buf = ex.memory.buffer;
    const poses = new Float32Array(buf, ex.vxl_read_poses(), n * 7);
    const vels = new Float32Array(buf, ex.vxl_read_velocities(), n * 6);
    for (let i = 0; i < n; i++) {
      const s = this.states[i];
      if (!s) continue;
      const o = i * 7;
      s.position[0] = poses[o];
      s.position[1] = poses[o + 1];
      s.position[2] = poses[o + 2];
      s.rotation[0] = poses[o + 3];
      s.rotation[1] = poses[o + 4];
      s.rotation[2] = poses[o + 5];
      s.rotation[3] = poses[o + 6];
      const vo = i * 6;
      s.linearVelocity = [vels[vo], vels[vo + 1], vels[vo + 2]];
      s.angularVelocity = [vels[vo + 3], vels[vo + 4], vels[vo + 5]];
      s.sleeping = this.dynamic[i] ? ex.vxl_sleeping(i) === 1 : undefined;
    }
  }

  stats() {
    return { bodyCount: this.bodyCount };
  }

  protected disposeWorld(): void {
    this.ex?.vxl_world_drop();
    this.bodyCount = 0;
    this.dynamic = [];
  }
}

export function create(): PhysicsEngineBase {
  return new VxlEngine();
}
