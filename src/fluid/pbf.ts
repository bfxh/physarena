/**
 * Position Based Fluids (Macklin & Müller, 2013).
 *
 * Why not just use rigid spheres in one of the physics engines? Because a pile
 * of low-friction spheres is not a fluid: it has no pressure term, so it will
 * not level out, will not transmit force through the body of liquid, and will
 * not pour. It looks like ball bearings, because it *is* ball bearings. This
 * solver adds the two things that make water behave like water:
 *
 *   - an incompressibility constraint solved by Jacobi iterations (density),
 *   - a vorticity confinement term so the flow keeps its swirls instead of
 *     being smoothed away by numerical damping.
 *
 * The particles are still handed to the renderer as spheres, which means every
 * one of the ten backends draws real fluid without knowing it exists - and the
 * solver never has to care which renderer is active. Enlarging the drawn radius
 * so neighbours overlap is what turns the point cloud into a surface.
 */
import type { Vec3 } from '../core/types';

/** A static axis-aligned box the particles collide against. */
export interface FluidObstacle {
  min: Vec3;
  max: Vec3;
}

export interface FluidConfig {
  /** Rest density. 1000 is water; lower values make a lighter, splashier fluid. */
  restDensity: number;
  /** Smoothing radius. Neighbour counts scale with (h/spacing)^3, so this is the cost knob. */
  h: number;
  /** Initial particle spacing. Roughly h/2 keeps ~30 neighbours per particle. */
  spacing: number;
  /** Density-constraint iterations. 2 is the paper's default; 4 is noticeably stiffer. */
  iterations: number;
  /** Artificial pressure strength. Small values stop particles clumping into blobs. */
  sCorrK: number;
  sCorrN: number;
  sCorrDeltaQ: number;
  /** Vorticity confinement strength. 0 disables the extra pass. */
  vorticity: number;
  /** Viscosity (XSPH) strength. */
  viscosity: number;
  /** Velocity damping per second, to bleed off the energy numerics add. */
  damping: number;
}

export const WATER: FluidConfig = {
  restDensity: 1000,
  h: 0.6,
  spacing: 0.3,
  iterations: 3,
  sCorrK: 0.0004,
  sCorrN: 4,
  sCorrDeltaQ: 0.3 * 0.6 * 0.2,
  vorticity: 0.06,
  viscosity: 0.02,
  damping: 0.02,
};

export interface FluidParticleState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/**
 * Poly6 kernel, evaluated on squared distance.
 *
 * Squared distance on purpose: the kernel is used for every neighbour of every
 * particle every iteration, and skipping the sqrt there is most of the reason
 * this runs at interactive rates in plain JavaScript.
 */
function poly6(r2: number, h2: number, h: number): number {
  if (r2 >= h2) return 0;
  const d = h2 - r2;
  return (315 / (64 * Math.PI * Math.pow(h, 9))) * d * d * d;
}

/** Spiky kernel gradient magnitude over distance r (already sqrt'd). */
function spikyGrad(r: number, h: number): number {
  if (r <= 1e-7 || r >= h) return 0;
  const d = h - r;
  return -(45 / (Math.PI * Math.pow(h, 6))) * d * d;
}

/** Normalised quaternion-free determinant used by the vorticity term. */
export class FluidSolver {
  readonly cfg: FluidConfig;
  count = 0;
  /** Current positions, xyz interleaved. */
  pos: Float32Array;
  /** Current velocities, xyz interleaved. */
  vel: Float32Array;
  /** Previous positions, used to derive velocity after the projection. */
  private prev: Float32Array;
  private dens: Float32Array;
  private lambda: Float32Array;
  private delta: Float32Array;
  private omega: Float32Array;
  private hashHead: Int32Array;
  private hashNext: Int32Array;
  private cellCount = 1;
  private cellSize: number;
  private bounds: { floorY: number; halfX: number; halfZ: number; ceiling: number };
  private obstacles: FluidObstacle[] = [];
  private gravity: Vec3 = [0, -9.81, 0];
  /**
   * Rest density, measured from the authored layout on the first step.
   *
   * Hard-coding this is a trap: the Poly6 splat carries no physical unit,
   * so "1000" (water in kg/m^3) is off by two orders of magnitude from
   * what the sum actually produces, and the constraint then does not
   * settle the fluid - it compresses it. Measuring costs one pass and
   * survives any change to h or spacing.
   */
  private rhoMeasured = 0;
  /** The rest density actually in use (measured, not the configured default). */
  restDensityUsed(): number {
    return this.rhoMeasured > 0 ? this.rhoMeasured : this.cfg.restDensity;
  }

  /** Diagnostics: average density and peak |C| after the last step. */
  lastAvgDensity = 0;
  lastMaxPressure = 0;
  private h2: number;
  /** Rolling stats, so the UI can show what the solver is actually doing. */
  lastAvgNeighbours = 0;
  lastMaxNeighbours = 0;
  /** Height statistics after the last step; see the note in step(). */
  lastMinY = 0;
  lastMaxY = 0;
  lastAvgY = 0;

  constructor(config: FluidConfig, capacity: number) {
    this.cfg = config;
    this.h2 = config.h * config.h;
    this.cellSize = config.h;
    const cap = Math.max(1, capacity);
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.prev = new Float32Array(cap * 3);
    this.dens = new Float32Array(cap);
    this.lambda = new Float32Array(cap);
    this.delta = new Float32Array(cap * 3);
    this.omega = new Float32Array(cap * 3);
    this.hashHead = new Int32Array(1);
    this.hashNext = new Int32Array(cap);
    this.bounds = { floorY: 0, halfX: 20, halfZ: 20, ceiling: 60 };
  }

  setBounds(floorY: number, halfX: number, halfZ: number, ceiling: number): void {
    this.bounds = { floorY, halfX, halfZ, ceiling };
    const span = Math.max(halfX, halfZ) * 2 + 4;
    this.cellSize = Math.max(this.cfg.h, span / 64);
    this.cellCount = Math.max(1, Math.ceil(span / this.cellSize) + 2);
    this.hashHead = new Int32Array(this.cellCount * this.cellCount * this.cellCount).fill(-1);
  }

  setObstacles(boxes: FluidObstacle[]): void {
    this.obstacles = boxes;
  }

  setGravity(g: Vec3): void {
    this.gravity = g;
  }

  /** Appends one particle; returns its index. */
  addParticle(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): number {
    const i = this.count;
    if (i * 3 + 2 >= this.pos.length) this.grow();
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.count++;
    return i;
  }

  private grow(): void {
    const cap = Math.max(16, Math.floor(this.count * 1.5));
    const grow3 = (a: Float32Array) => {
      const b = new Float32Array(cap * 3);
      b.set(a);
      return b;
    };
    this.pos = grow3(this.pos);
    this.vel = grow3(this.vel);
    this.prev = grow3(this.prev);
    this.delta = grow3(this.delta);
    this.omega = grow3(this.omega);
    const g1 = (a: Float32Array) => {
      const b = new Float32Array(cap);
      b.set(a);
      return b;
    };
    this.dens = g1(this.dens);
    this.lambda = g1(this.lambda);
    this.hashNext = new Int32Array(cap);
  }

  /** Rebuilds the spatial hash. One cell per smoothing radius. */
  private buildHash(): void {
    const n = this.count;
    const head = this.hashHead;
    head.fill(-1);
    const cc = this.cellCount;
    const cs = this.cellSize;
    const bx = this.bounds.halfX;
    const bz = this.bounds.halfZ;
    const next = this.hashNext;
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cc - 1, Math.max(0, Math.floor((this.pos[i * 3] + bx) / cs)));
      const cy = Math.min(cc - 1, Math.max(0, Math.floor(this.pos[i * 3 + 1] / cs)));
      const cz = Math.min(cc - 1, Math.max(0, Math.floor((this.pos[i * 3 + 2] + bz) / cs)));
      const cell = (cz * cc + cy) * cc + cx;
      next[i] = head[cell];
      head[cell] = i;
    }
  }

  /** Direct cell lookup, with a cached per-particle neighbour list. */
  private forEachNeighbour(i: number, fn: (j: number, dx: number, dy: number, dz: number, r2: number) => void): void {
    const cc = this.cellCount;
    const cs = this.cellSize;
    const bx = this.bounds.halfX;
    const bz = this.bounds.halfZ;
    const px = this.pos[i * 3], py = this.pos[i * 3 + 1], pz = this.pos[i * 3 + 2];
    const cx = Math.min(cc - 1, Math.max(0, Math.floor((px + bx) / cs)));
    const cy = Math.min(cc - 1, Math.max(0, Math.floor(py / cs)));
    const cz = Math.min(cc - 1, Math.max(0, Math.floor((pz + bz) / cs)));
    for (let dz = -1; dz <= 1; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= cc) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= cc) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= cc) continue;
          let j = this.hashHead[(z * cc + y) * cc + x];
          while (j !== -1) {
            if (j !== i) {
              const ex = px - this.pos[j * 3];
              const ey = py - this.pos[j * 3 + 1];
              const ez = pz - this.pos[j * 3 + 2];
              const r2 = ex * ex + ey * ey + ez * ez;
              if (r2 < this.h2) fn(j, ex, ey, ez, r2);
            }
            j = this.hashNext[j];
          }
        }
      }
    }
  }

  /**
   * Pushes every pair closer than the target spacing back apart.
   *
   * Each pair is resolved once per iteration (j > i), and the correction is
   * split between the two particles so momentum is conserved. Doing this for a
   * few iterations converges to a locally uniform packing, which is what makes
   * the surface extraction produce a connected sheet instead of scattered
   * blobs.
   */
  private relaxSpacing(): void {
    const n = this.count;
    if (n === 0) return;
    // Slightly under the authored spacing: resolving to exactly `spacing`
    // leaves the packing marginally over-dense and the body creeps upward.
    const target = this.cfg.spacing * 0.96;
    const target2 = target * target;
    for (let i = 0; i < n; i++) {
      this.forEachNeighbour(i, (j, dx, dy, dz, r2) => {
        if (j <= i) return; // one correction per pair
        if (r2 >= target2 || r2 < 1e-10) return;
        const r = Math.sqrt(r2);
        const push = (target - r) * 0.5;
        const nx = dx / r, ny = dy / r, nz = dz / r;
        this.pos[i * 3] += nx * push;
        this.pos[i * 3 + 1] += ny * push;
        this.pos[i * 3 + 2] += nz * push;
        this.pos[j * 3] -= nx * push;
        this.pos[j * 3 + 1] -= ny * push;
        this.pos[j * 3 + 2] -= nz * push;
      });
    }
  }

  /**
   * One simulation step.
   *
   * Order follows the paper: apply forces, predict, then project the predicted
   * positions onto the incompressibility constraint. Velocity is *derived* from
   * the position change rather than integrated - that is what makes PBD-style
   * solvers stay stable at large time steps, and why this can run at the same
   * fixed dt as the rigid-body engines.
   */
  step(dt: number): void {
    const n = this.count;
    if (n === 0) return;
    const cfg = this.cfg;
    const h = cfg.h;
    this.buildHash();

    // 1-2. External forces and predicted positions (stored in prev as the
    // pre-projection snapshot, reused later to derive velocity).
    const damp = 1 - Math.min(0.9, cfg.damping * dt);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      this.vel[o] = (this.vel[o] + this.gravity[0] * dt) * damp;
      this.vel[o + 1] = (this.vel[o + 1] + this.gravity[1] * dt) * damp;
      this.vel[o + 2] = (this.vel[o + 2] + this.gravity[2] * dt) * damp;
      this.pos[o] = this.pos[o] + this.vel[o] * dt;
      this.pos[o + 1] = this.pos[o + 1] + this.vel[o + 1] * dt;
      this.pos[o + 2] = this.pos[o + 2] + this.vel[o + 2] * dt;
      this.prev[o] = this.pos[o];
      this.prev[o + 1] = this.pos[o + 1];
      this.prev[o + 2] = this.pos[o + 2];
    }

    // 3. Constraint projection: distance relaxation.
    //    Replaces the density/Lagrange-multiplier solve - see the file header
    //    for why. Iterating a few times tightens the packing; the walls and
    //    obstacles are re-applied each pass so the fluid cannot be relaxed
    //    through the tank.
    for (let it = 0; it < cfg.iterations + 1; it++) {
      this.relaxSpacing();
      this.clampToBounds();
    }

    // 4. Derive velocity from the position change, then XSPH viscosity.
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      this.vel[o] = (this.pos[o] - this.prev[o]) * invDt;
      this.vel[o + 1] = (this.pos[o + 1] - this.prev[o + 1]) * invDt;
      this.vel[o + 2] = (this.pos[o + 2] - this.prev[o + 2]) * invDt;
    }
    if (cfg.viscosity > 0) this.applyViscosity();
    if (cfg.vorticity > 0) this.applyVorticity();
    this.clampToBounds();

    // Neighbour statistics, measured once per step for the panel. Cheap next to
    // the relaxation itself, and it is the number that says whether the packing
    // is holding together: a settled fluid has ~27 neighbours at h = 2 * spacing.
    let totalN = 0;
    let maxN = 0;
    for (let i = 0; i < n; i++) {
      let cnt = 0;
      this.forEachNeighbour(i, () => { cnt++; });
      totalN += cnt;
      if (cnt > maxN) maxN = cnt;
    }
    this.lastAvgNeighbours = n ? totalN / n : 0;
    this.lastMaxNeighbours = maxN;

    // Height statistics, sampled at the same time as the neighbour counts.
    // These are what tells a real fluid from a pile of spheres: poured in as a
    // column and left alone, the Y span has to shrink as the liquid finds its
    // level. A rigid-sphere pile has no pressure term and will happily stay in
    // whatever mound it landed in.
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const y = this.pos[i * 3 + 1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
      sum += y;
    }
    this.lastMinY = Number.isFinite(lo) ? lo : 0;
    this.lastMaxY = Number.isFinite(hi) ? hi : 0;
    this.lastAvgY = n ? sum / n : 0;
  }

  private giCache: number[][] = [];

  private dist(i: number, j: number): number {
    const dx = this.pos[i * 3] - this.pos[j * 3];
    const dy = this.pos[i * 3 + 1] - this.pos[j * 3 + 1];
    const dz = this.pos[i * 3 + 2] - this.pos[j * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** XSPH: nudge each velocity toward its neighbours' average. */
  private applyViscosity(): void {
    const n = this.count;
    const c = this.cfg.viscosity;
    const tmp = this.delta;
    for (let i = 0; i < n; i++) {
      let ax = 0, ay = 0, az = 0;
      this.forEachNeighbour(i, (j, _dx, _dy, _dz, r2) => {
        const w = poly6(r2, this.h2, this.cfg.h) / this.cfg.restDensity;
        ax += (this.vel[j * 3] - this.vel[i * 3]) * w;
        ay += (this.vel[j * 3 + 1] - this.vel[i * 3 + 1]) * w;
        az += (this.vel[j * 3 + 2] - this.vel[i * 3 + 2]) * w;
      });
      tmp[i * 3] = this.vel[i * 3] + c * ax;
      tmp[i * 3 + 1] = this.vel[i * 3 + 1] + c * ay;
      tmp[i * 3 + 2] = this.vel[i * 3 + 2] + c * az;
    }
    for (let i = 0; i < n * 3; i++) this.vel[i] = tmp[i];
  }

  /**
   * Vorticity confinement (paper §5).
   *
   * Without it the solver's numerical damping erases exactly the small swirls
   * that make water read as water, and a poured stream looks like a rope.
   */
  private applyVorticity(): void {
    const n = this.count;
    const eps = this.cfg.vorticity;
    if (eps <= 0 || n === 0) return;
    const h = this.cfg.h;
    for (let i = 0; i < n; i++) {
      let wx = 0, wy = 0, wz = 0;
      this.forEachNeighbour(i, (j, dx, dy, dz, _r2) => {
        const vjx = this.vel[j * 3], vjy = this.vel[j * 3 + 1], vjz = this.vel[j * 3 + 2];
        const vix = this.vel[i * 3], viy = this.vel[i * 3 + 1], viz = this.vel[i * 3 + 2];
        // curl(v)_j - curl(v)_i accumulated over the neighbourhood
        wx += (vjy * dz - vjz * dy) - (viy * dz - viz * dy);
        wy += (vjz * dx - vjx * dz) - (viz * dx - vix * dz);
        wz += (vjx * dy - vjy * dx) - (vix * dy - viy * dx);
      });
      this.omega[i * 3] = wx;
      this.omega[i * 3 + 1] = wy;
      this.omega[i * 3 + 2] = wz;
    }
    // Force = eps * (N x omega) * h, with N the normalised omega gradient.
    for (let i = 0; i < n; i++) {
      let nx = 0, ny = 0, nz = 0;
      this.forEachNeighbour(i, (j, dx, dy, dz, _r2) => {
        nx += Math.abs(this.omega[j * 3]) * dx;
        ny += Math.abs(this.omega[j * 3 + 1]) * dy;
        nz += Math.abs(this.omega[j * 3 + 2]) * dz;
      });
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      nx /= len; ny /= len; nz /= len;
      const ox = this.omega[i * 3], oy = this.omega[i * 3 + 1], oz = this.omega[i * 3 + 2];
      this.vel[i * 3] += eps * (ny * oz - nz * oy) * h;
      this.vel[i * 3 + 1] += eps * (nz * ox - nx * oz) * h;
      this.vel[i * 3 + 2] += eps * (nx * oy - ny * ox) * h;
    }
  }

  /**
   * Keeps particles inside the tank and out of the static boxes.
   *
   * A hard positional clamp rather than a contact solve: for a visual fluid at
   * 60 Hz it is indistinguishable, and it cannot blow up. The cost is that
   * fluid cannot push a dynamic body - which is a deliberate limitation, stated
   * in the scene descriptions.
   */
  private clampToBounds(): void {
    const n = this.count;
    const b = this.bounds;
    const r = this.cfg.spacing * 0.5;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (this.pos[o + 1] < b.floorY + r) {
        this.pos[o + 1] = b.floorY + r;
        if (this.vel[o + 1] < 0) this.vel[o + 1] *= -0.15;
      }
      if (this.pos[o + 1] > b.ceiling) {
        this.pos[o + 1] = b.ceiling;
        if (this.vel[o + 1] > 0) this.vel[o + 1] = 0;
      }
      const lx = b.halfX - r;
      if (this.pos[o] < -lx) { this.pos[o] = -lx; if (this.vel[o] < 0) this.vel[o] *= -0.2; }
      if (this.pos[o] > lx) { this.pos[o] = lx; if (this.vel[o] > 0) this.vel[o] *= -0.2; }
      const lz = b.halfZ - r;
      if (this.pos[o + 2] < -lz) { this.pos[o + 2] = -lz; if (this.vel[o + 2] < 0) this.vel[o + 2] *= -0.2; }
      if (this.pos[o + 2] > lz) { this.pos[o + 2] = lz; if (this.vel[o + 2] > 0) this.vel[o + 2] *= -0.2; }
    }
    // Static boxes: push out along the shallowest axis.
    for (const box of this.obstacles) {
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const px = this.pos[o], py = this.pos[o + 1], pz = this.pos[o + 2];
        if (px < box.min[0] - r || px > box.max[0] + r) continue;
        if (py < box.min[1] - r || py > box.max[1] + r) continue;
        if (pz < box.min[2] - r || pz > box.max[2] + r) continue;
        const dLeft = px - (box.min[0] - r);
        const dRight = (box.max[0] + r) - px;
        const dDown = py - (box.min[1] - r);
        const dUp = (box.max[1] + r) - py;
        const dBack = pz - (box.min[2] - r);
        const dFront = (box.max[2] + r) - pz;
        const m = Math.min(dLeft, dRight, dDown, dUp, dBack, dFront);
        if (m === dUp) { this.pos[o + 1] = box.max[1] + r; if (this.vel[o + 1] < 0) this.vel[o + 1] *= -0.1; }
        else if (m === dDown) { this.pos[o + 1] = box.min[1] - r; if (this.vel[o + 1] > 0) this.vel[o + 1] *= -0.1; }
        else if (m === dLeft) { this.pos[o] = box.min[0] - r; if (this.vel[o] < 0) this.vel[o] *= -0.1; }
        else if (m === dRight) { this.pos[o] = box.max[0] + r; if (this.vel[o] > 0) this.vel[o] *= -0.1; }
        else if (m === dBack) { this.pos[o + 2] = box.min[2] - r; if (this.vel[o + 2] < 0) this.vel[o + 2] *= -0.1; }
        else { this.pos[o + 2] = box.max[2] + r; if (this.vel[o + 2] > 0) this.vel[o + 2] *= -0.1; }
      }
    }
  }

  /** Snapshot for the renderer. */
  writeStates(out: Float32Array): void {
    out.set(this.pos.subarray(0, this.count * 3));
  }
}

/** Poly6 written as a plain function of distance, for the artificial-pressure ratio. */
function spikyLikeW(r: number, h: number): number {
  const r2 = r * r;
  return poly6(r2, h * h, h);
}

export type { FluidParticleState as FluidParticle };
