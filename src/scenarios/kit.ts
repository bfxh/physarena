import type {
  BodyDesc, BodyType, FluidSpec, JointDesc, ShapeDesc, Vec3, Quat, WorldDesc,
} from '../core/types';
import { IDENTITY_QUAT } from '../core/types';

/** Deterministic RNG so every engine in a comparison run sees the same scene. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rough bounding radius of a shape, in metres.
 *
 * Only for camera framing, so an over-estimate is fine and exact bounds are
 * not worth the complexity.
 */
function shapeReach(shape: ShapeDesc): number {
  switch (shape.kind) {
    case 'box':
      return Math.hypot(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]);
    case 'sphere':
      return shape.radius;
    case 'capsule':
    case 'cylinder':
    case 'cone':
      return Math.hypot(shape.radius, shape.halfHeight);
    case 'convex':
    case 'trimesh': {
      const v = shape.kind === 'convex' ? shape.points : shape.vertices;
      let m = 0;
      for (let i = 0; i < v.length; i++) {
        const a = Math.abs(v[i]);
        if (a > m) m = a;
      }
      return m;
    }
    case 'compound': {
      let m = 0;
      for (const c of shape.children) {
        const r = Math.hypot(c.offset[0], c.offset[1], c.offset[2]) + shapeReach(c.shape);
        if (r > m) m = r;
      }
      return m;
    }
  }
}

export class SceneBuilder {
  readonly bodies: BodyDesc[] = [];
  readonly joints: JointDesc[] = [];
  extent = 20;
  /** Full width of the visual ground plane, used for camera framing. */
  groundSize = 0;
  /**
   * Reach of the non-static bodies, in metres, measured as the half-extent of
   * their bounding box around the CONTENT CENTRE (not around the world origin,
   * and including the vertical span - a 54 m tower and a 54 m-wide pile need
   * the same framing).
   */
  contentRadius = 0;
  /** Centre of the dynamic content, used as the camera target. */
  contentCenter: Vec3 = [0, 0, 0];
  gravity: Vec3 = [0, -9.81, 0];
  private n = 0;
  private cMin: Vec3 = [Infinity, Infinity, Infinity];
  private cMax: Vec3 = [-Infinity, -Infinity, -Infinity];

  private nextId(prefix: string): string {
    return `${prefix}#${this.n++}`;
  }

  /** Rough "how much work is this scene" number, used by the load slider. */
  get dynamicCount(): number {
    return this.bodies.filter((b) => b.type === 'dynamic').length;
  }

  private make(
    shape: ShapeDesc,
    type: BodyType,
    position: Vec3,
    opts: Partial<BodyDesc> = {},
    prefix = shape.kind,
  ): BodyDesc {
    const b: BodyDesc = {
      id: opts.id ?? this.nextId(prefix),
      shape,
      type,
      position,
      rotation: opts.rotation ?? IDENTITY_QUAT,
      density: opts.density ?? 1000,
      friction: opts.friction ?? 0.5,
      restitution: opts.restitution ?? 0.05,
      linearDamping: opts.linearDamping ?? 0,
      angularDamping: opts.angularDamping ?? 0.05,
      ccd: opts.ccd ?? false,
      sensor: opts.sensor ?? false,
      tag: opts.tag,
      velocity: opts.velocity,
      angularVelocity: opts.angularVelocity,
      mass: opts.mass,
      // Easy to forget, and silent when forgotten: drop this and the particles
      // become ordinary rigid bodies - the fluid solver is never built, the
      // surface extraction has nothing to extract, and the scene sits perfectly
      // still while looking like "the fluid feature was never implemented".
      // A whitelist constructor means every new BodyDesc field has to be added
      // in exactly one place, and this is it.
      fluid: opts.fluid,
    };
    this.bodies.push(b);
    this.trackContent(b);
    return b;
  }

  raw(b: BodyDesc): BodyDesc {
    if (!b.id) b.id = this.nextId(b.shape.kind);
    this.bodies.push(b);
    this.trackContent(b);
    return b;
  }

  /** Keeps the content bounding box in step with the non-static bodies. */
  private trackContent(b: BodyDesc): void {
    if (b.type === 'static') return;
    const r = shapeReach(b.shape);
    for (let k = 0; k < 3; k++) {
      this.cMin[k] = Math.min(this.cMin[k], b.position[k] - r);
      this.cMax[k] = Math.max(this.cMax[k], b.position[k] + r);
    }
    const cx = (this.cMin[0] + this.cMax[0]) / 2;
    const cy = (this.cMin[1] + this.cMax[1]) / 2;
    const cz = (this.cMin[2] + this.cMax[2]) / 2;
    const hx = (this.cMax[0] - this.cMin[0]) / 2;
    const hy = (this.cMax[1] - this.cMin[1]) / 2;
    const hz = (this.cMax[2] - this.cMin[2]) / 2;
    // The vertical span counts at 0.7x: a tall thin column needs a pulled-back
    // camera, but not as far as a cube of the same height.
    this.contentRadius = Math.max(hx, hz, hy * 0.7, 1);
    this.contentCenter = [cx, cy, cz];
  }

  box(position: Vec3, halfExtents: Vec3, opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'box', halfExtents }, opts.type ?? 'dynamic', position, opts);
  }

  sphere(position: Vec3, radius: number, opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'sphere', radius }, opts.type ?? 'dynamic', position, opts);
  }

  capsule(position: Vec3, radius: number, halfHeight: number, opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'capsule', radius, halfHeight }, opts.type ?? 'dynamic', position, opts);
  }

  cylinder(position: Vec3, radius: number, halfHeight: number, opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'cylinder', radius, halfHeight }, opts.type ?? 'dynamic', position, opts);
  }

  cone(position: Vec3, radius: number, halfHeight: number, opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'cone', radius, halfHeight }, opts.type ?? 'dynamic', position, opts);
  }

  convex(position: Vec3, points: number[], opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'convex', points }, opts.type ?? 'dynamic', position, opts);
  }

  trimesh(position: Vec3, vertices: number[], indices: number[], opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make(
      { kind: 'trimesh', vertices, indices },
      opts.type ?? 'static',
      position,
      opts,
    );
  }

  compound(position: Vec3, children: { shape: ShapeDesc; offset: Vec3; rotation?: Quat }[], opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.make({ kind: 'compound', children }, opts.type ?? 'dynamic', position, opts);
  }

  ground(size = 200, thickness = 1, y = 0, opts: Partial<BodyDesc> = {}): BodyDesc {
    this.extent = Math.max(this.extent, size * 0.35);
    this.groundSize = Math.max(this.groundSize, size);
    return this.box([0, y - thickness, 0], [size / 2, thickness, size / 2], {
      friction: 0.7,
      ...opts,
      type: 'static',
      tag: 'ground',
    });
  }

  wall(x: number, z: number, width: number, height: number, opts: Partial<BodyDesc> = {}): BodyDesc {
    return this.box([x, height / 2, z], [width / 2, height / 2, 0.5], {
      friction: 0.6,
      ...opts,
      type: 'static',
      tag: 'wall',
    });
  }

  joint(j: JointDesc): JointDesc {
    this.joints.push(j);
    return j;
  }

  /** Set by fluidVolume(); carried into the world so the host can build a solver. */
  private fluidSpec?: FluidSpec;

  /**
   * Fills an axis-aligned box with fluid particles.
   *
   * The particles are emitted as ordinary sphere bodies with `fluid: true`, so
   * every renderer draws them through the code path it already has - no backend
   * needs to know fluids exist. The drawn radius is deliberately larger than
   * the solver spacing so neighbouring spheres overlap; that overlap is what
   * reads as a surface instead of as a bag of marbles.
   *
   * Note the deliberate asymmetry: `spacing` drives the solver (density,
   * neighbour counts), `spacing * 2.6` only drives how big the spheres look.
   */
  fluidVolume(
    min: Vec3,
    max: Vec3,
    opts: Partial<FluidSpec> & { renderScale?: number } = {},
  ): FluidSpec {
    const spacing = opts.spacing ?? 0.3;
    const renderScale = opts.renderScale ?? 2.6;
    const r = spacing * 0.5;
    for (let y = min[1] + r; y <= max[1] + 1e-6; y += spacing) {
      for (let x = min[0] + r; x <= max[0] + 1e-6; x += spacing) {
        for (let z = min[2] + r; z <= max[2] + 1e-6; z += spacing) {
          this.sphere([x, y, z], r * renderScale, {
            fluid: true,
            tag: "fluid",
            density: opts.restDensity ?? 1000,
            friction: 0.02,
            restitution: 0.0,
          });
        }
      }
    }
    this.fluidSpec = {
      restDensity: opts.restDensity,
      h: opts.h,
      spacing,
      iterations: opts.iterations,
      vorticity: opts.vorticity,
      viscosity: opts.viscosity,
      renderScale,
      halfX: Math.max(Math.abs(min[0]), Math.abs(max[0])) + 0.5,
      halfZ: Math.max(Math.abs(min[2]), Math.abs(max[2])) + 0.5,
      ceiling: max[1] + 6,
    };
    return this.fluidSpec;
  }

  finish(substeps?: number): WorldDesc {
    // Fluid particles are moved to the end of the body list. Renderers index
    // their state arrays by position, and the engine only ever sees the rigid
    // bodies - so putting the fluid last is what lets readStates() simply
    // append the solver output instead of interleaving it.
    const rigid = this.bodies.filter((x) => !x.fluid);
    const fluid = this.bodies.filter((x) => x.fluid);
    return {
      gravity: this.gravity,
      bodies: rigid.concat(fluid),
      joints: this.joints,
      substeps,
      fluid: this.fluidSpec,
    };
  }
}

/** Regular tetrahedron-ish irregular hull, handy for "no easy primitive" tests. */
export function rockPoints(radius: number, r: () => number, vertices = 12): number[] {
  const pts: number[] = [];
  const d = Math.max(1, vertices - 1);
  for (let i = 0; i < vertices; i++) {
    // Fibonacci sphere, then jittered so the hull is genuinely irregular.
    const y = 1 - (i / d) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    const jitter = 0.72 + r() * 0.42;
    pts.push(
      Math.cos(theta) * rad * radius * jitter,
      y * radius * jitter,
      Math.sin(theta) * rad * radius * jitter,
    );
  }
  return pts;
}

/** Unit-ish icosahedron hull, the classic "cheap convex" stand-in. */
export function icosaPoints(radius: number): number[] {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const norm = Math.sqrt(1 + t * t);
  const out: number[] = [];
  for (const p of raw) {
    out.push((p[0] / norm) * radius, (p[1] / norm) * radius, (p[2] / norm) * radius);
  }
  return out;
}

/** Axis-aligned box as a raw point cloud, for engines with no primitive path. */
export function boxPoints(half: Vec3): number[] {
  const out: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(sx * half[0], sy * half[1], sz * half[2]);
  }
  return out;
}

/** Grid terrain as a triangle mesh, shifted by a smooth height field. */
export function heightfieldMesh(
  size: number,
  segments: number,
  heightAt: (x: number, z: number) => number,
): { vertices: number[]; indices: number[] } {
  const vertices: number[] = [];
  const indices: number[] = [];
  const step = size / segments;
  for (let iz = 0; iz <= segments; iz++) {
    for (let ix = 0; ix <= segments; ix++) {
      const x = -size / 2 + ix * step;
      const z = -size / 2 + iz * step;
      vertices.push(x, heightAt(x, z), z);
    }
  }
  const row = segments + 1;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * row + ix;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { vertices, indices };
}
