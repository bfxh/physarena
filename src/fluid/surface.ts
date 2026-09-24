/**
 * Surface Nets: turns the fluid's particles into a continuous surface.
 *
 * Why this exists. Drawing the particles as overlapping spheres is a volumetric
 * *approximation* of the fluid - and it looks like one: a cluster of round
 * outlines, reading as foam or as ball bearings rather than as water. The shape
 * of a liquid is its surface, and a surface only exists once you decide where
 * "inside" ends. That is what an isosurface extraction does: sample a scalar
 * field (here, particle density), and mesh the level set.
 *
 * Surface Nets rather than Marching Cubes: MC needs two 256-entry tables and
 * produces slivers where the surface clips a cell corner. Surface Nets places
 * one vertex per cell (at the centroid of the edge crossings) and connects
 * neighbouring cells - about a fifth of the code, no lookup tables, and the
 * resulting mesh is smoother at the same resolution. To add detail you raise
 * the grid resolution, not the table size.
 *
 * Cost is managed rather than ignored:
 *   - the field is rebuilt each call (it is a splat, not a solve),
 *   - vertices and indices are written into preallocated buffers that only grow
 *     when the mesh actually gets bigger,
 *   - the caller decides how often to run it. The fluid mesh does not need to
 *     update at the same rate as the rigid bodies.
 */
import type { Vec3 } from '../core/types';
import type { GeometryData } from '../render/geometry';

/** Flat 3-index helper: cell (x,y,z) -> linear offset into the field. */
export class SurfaceExtractor {
  /** Number of grid *points* along each axis (cells + 1). */
  private dims: [number, number, number] = [0, 0, 0];
  private origin: Vec3 = [0, 0, 0];
  private cellSize = 1;
  private field = new Float32Array(0);
  /** Per-cell vertex index, or -1 when the cell does not straddle the surface. */
  private cellVertex = new Int32Array(0);
  private positions = new Float32Array(0);
  private normals = new Float32Array(0);
  private indices = new Uint32Array(0);
  private vertexCount = 0;
  private indexCount = 0;
  /** Set when the caller changed the bounds and the grid had to be rebuilt. */
  configured = false;

  /**
   * Prepares the grid for a bounding box.
   *
   * Called on scene change rather than per frame, so the allocation cost is
   * paid once. `cellSize` trades detail against cost cubically - halving it
   * multiplies both the field size and the splat count by eight.
   */
  configure(min: Vec3, max: Vec3, cellSize: number): void {
    this.origin = [min[0] - cellSize, min[1] - cellSize, min[2] - cellSize];
    this.cellSize = cellSize;
    const span: Vec3 = [
      max[0] + cellSize - this.origin[0],
      max[1] + cellSize - this.origin[1],
      max[2] + cellSize - this.origin[2],
    ];
    const dims: [number, number, number] = [
      Math.max(2, Math.ceil(span[0] / cellSize) + 1),
      Math.max(2, Math.ceil(span[1] / cellSize) + 1),
      Math.max(2, Math.ceil(span[2] / cellSize) + 1),
    ];
    // A hard ceiling on the grid, because a runaway bound would otherwise
    // allocate gigabytes and take the tab with it.
    const MAX = 160;
    for (let i = 0; i < 3; i++) dims[i] = Math.min(dims[i], MAX);
    this.dims = dims;
    const points = dims[0] * dims[1] * dims[2];
    this.field = new Float32Array(points);
    this.cellVertex = new Int32Array(Math.max(1, (dims[0] - 1) * (dims[1] - 1) * (dims[2] - 1)));
    this.configured = true;
  }

  /** Grid resolution actually in use, for the metrics panel. */
  get resolution(): [number, number, number] {
    return [this.dims[0], this.dims[1], this.dims[2]];
  }

  get cells(): number {
    return Math.max(0, (this.dims[0] - 1) * (this.dims[1] - 1) * (this.dims[2] - 1));
  }

  /**
   * Runs the whole pipeline and returns a mesh.
   *
   * `radius` is the particle influence radius; `iso` is the density a point
   * must exceed to count as inside. Their ratio sets how much the surface
   * bulges between particles - too high and the fluid looks like a bag of
   * marbles again, too low and it shrinks away from the particles.
   */
  extract(
    particles: Float32Array,
    count: number,
    radius: number,
    iso: number,
  ): GeometryData {
    this.splat(particles, count, radius);
    this.buildVertices(iso);
    this.buildIndices();
    this.computeNormals();
    return {
      positions: this.positions.subarray(0, this.vertexCount * 3),
      normals: this.normals.subarray(0, this.vertexCount * 3),
      indices: this.indices.subarray(0, this.indexCount),
    };
  }

  /** Deposits a smooth kernel around every particle into the grid. */
  private splat(particles: Float32Array, count: number, radius: number): void {
    const f = this.field;
    f.fill(0);
    const [nx, ny, nz] = this.dims;
    const cs = this.cellSize;
    const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2];
    const r2 = radius * radius;
    const inv = 1 / (radius * radius * radius);
    // Only touch the cells the particle can reach; the neighbourhood is small
    // by construction, which is why this stays linear in particle count.
    const reach = Math.ceil(radius / cs);
    for (let p = 0; p < count; p++) {
      const px = particles[p * 3], py = particles[p * 3 + 1], pz = particles[p * 3 + 2];
      const gx = Math.floor((px - ox) / cs);
      const gy = Math.floor((py - oy) / cs);
      const gz = Math.floor((pz - oz) / cs);
      for (let dz = -reach; dz <= reach; dz++) {
        const iz = gz + dz;
        if (iz < 0 || iz >= nz) continue;
        const wz = oz + iz * cs - pz;
        for (let dy = -reach; dy <= reach; dy++) {
          const iy = gy + dy;
          if (iy < 0 || iy >= ny) continue;
          const wy = oy + iy * cs - py;
          const dzy2 = wz * wz + wy * wy;
          if (dzy2 >= r2) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const ix = gx + dx;
            if (ix < 0 || ix >= nx) continue;
            const wx = ox + ix * cs - px;
            const d2 = dzy2 + wx * wx;
            if (d2 >= r2) continue;
            // (1 - r²/R²)³ - a compact polynomial kernel: smooth, cheap, zero
            // beyond R so the splat stays local.
            const t = 1 - d2 / r2;
            f[(iz * ny + iy) * nx + ix] += t * t * t * inv;
          }
        }
      }
    }
  }

  /**
   * One vertex per cell that straddles the isosurface.
   *
   * The position is the average of the crossings along the cell's 12 edges,
   * which is the Surface Nets rule: no tables, and no surface tearing at cell
   * boundaries because neighbouring cells agree on shared edge crossings.
   */
  private buildVertices(iso: number): void {
    this.vertexCount = 0;
    const [nx, ny, nz] = this.dims;
    const f = this.field;
    const cs = this.cellSize;
    const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2];
    const cv = this.cellVertex;
    let need = this.positions.length / 3;
    if (need < cv.length) {
      this.positions = new Float32Array(cv.length * 3);
      this.normals = new Float32Array(cv.length * 3);
      need = cv.length;
    }
    const pos = this.positions;
    // 12 edges of a cube, as (corner, corner) pairs in a 2x2x2 corner index.
    const EDGES: [number, number][] = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const corner = (b: number): [number, number, number] =>
      [b & 1, (b >> 1) & 1, (b >> 2) & 1];

    let v = 0;
    for (let z = 0; z < nz - 1; z++) {
      for (let y = 0; y < ny - 1; y++) {
        for (let x = 0; x < nx - 1; x++) {
          const base = (z * ny + y) * nx + x;
          const c000 = f[base];
          const c100 = f[base + 1];
          const c010 = f[base + nx];
          const c110 = f[base + nx + 1];
          const c001 = f[base + nx * ny];
          const c101 = f[base + nx * ny + 1];
          const c011 = f[base + nx * ny + nx];
          const c111 = f[base + nx * ny + nx + 1];
          const corners = [c000, c100, c010, c110, c001, c101, c011, c111];
          let below = 0;
          let above = 0;
          for (let i = 0; i < 8; i++) {
            if (corners[i] < iso) below++;
            else above++;
          }
          const cellIndex = (z * (ny - 1) + y) * (nx - 1) + x;
          if (below === 0 || above === 0) {
            cv[cellIndex] = -1;
            continue;
          }
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (const [a, b] of EDGES) {
            const va = corners[a];
            const vb = corners[b];
            if ((va < iso) === (vb < iso)) continue;
            const t = (iso - va) / (vb - va || 1e-9);
            const [ax, ay, az] = corner(a);
            const [bx, by, bz] = corner(b);
            sx += (ax + (bx - ax) * t) * cs + ox;
            sy += (ay + (by - ay) * t) * cs + oy;
            sz += (az + (bz - az) * t) * cs + oz;
            n++;
          }
          if (n === 0) {
            cv[cellIndex] = -1;
            continue;
          }
          const o3 = v * 3;
          if (o3 + 2 >= pos.length) break;
          pos[o3] = sx / n;
          pos[o3 + 1] = sy / n;
          pos[o3 + 2] = sz / n;
          cv[cellIndex] = v;
          v++;
        }
      }
    }
    this.vertexCount = v;
  }

  /**
   * Connects neighbouring cells into quads.
   *
   * A quad exists wherever two cells on the same axis both carry a vertex -
   * that is the whole connectivity rule, and it is why this needs no case
   * tables. Winding is fixed afterwards by the normals, so getting it wrong
   * here cannot produce inside-out lighting.
   */
  private buildIndices(): void {
    this.indexCount = 0;
    const [nx, ny, nz] = this.dims;
    const cv = this.cellVertex;
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const maxTris = Math.max(1, this.cellVertex.length * 6);
    if (this.indices.length < maxTris) this.indices = new Uint32Array(maxTris);
    const idx = this.indices;
    let k = 0;

    const cellAt = (x: number, y: number, z: number) =>
      (z * cy + y) * cx + x;

    const quad = (a: number, b: number, c: number, d: number) => {
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = a; idx[k++] = c; idx[k++] = d;
    };

    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          const i = cellAt(x, y, z);
          const v0 = cv[i];
          if (v0 < 0) continue;
          // +X face
          if (x + 1 < cx) {
            const v1 = cv[cellAt(x + 1, y, z)];
            if (v1 >= 0) {
              const v2 = y + 1 < cy ? cv[cellAt(x + 1, y + 1, z)] : -1;
              const v3 = y + 1 < cy ? cv[cellAt(x, y + 1, z)] : -1;
              if (v2 >= 0 && v3 >= 0) quad(v0, v1, v2, v3);
            }
          }
          // +Y face
          if (y + 1 < cy) {
            const v1 = cv[cellAt(x, y + 1, z)];
            if (v1 >= 0) {
              const v2 = z + 1 < cz ? cv[cellAt(x, y + 1, z + 1)] : -1;
              const v3 = z + 1 < cz ? cv[cellAt(x, y, z + 1)] : -1;
              if (v2 >= 0 && v3 >= 0) quad(v0, v1, v2, v3);
            }
          }
          // +Z face
          if (z + 1 < cz) {
            const v1 = cv[cellAt(x, y, z + 1)];
            if (v1 >= 0) {
              const v2 = x + 1 < cx ? cv[cellAt(x + 1, y, z + 1)] : -1;
              const v3 = x + 1 < cx ? cv[cellAt(x + 1, y, z)] : -1;
              if (v2 >= 0 && v3 >= 0) quad(v0, v1, v2, v3);
            }
          }
        }
      }
    }
    this.indexCount = k;
  }

  /**
   * Normals from the field gradient (central differences).
   *
   * Cheaper and smoother than averaging face normals: the gradient is defined
   * everywhere, including at vertices where the quad connectivity is uneven.
   */
  private computeNormals(): void {
    const [nx, ny, nz] = this.dims;
    const f = this.field;
    const pos = this.positions;
    const nor = this.normals;
    const cs = this.cellSize;
    const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2];
    for (let v = 0; v < this.vertexCount; v++) {
      const o3 = v * 3;
      const gx = Math.round((pos[o3] - ox) / cs);
      const gy = Math.round((pos[o3 + 1] - oy) / cs);
      const gz = Math.round((pos[o3 + 2] - oz) / cs);
      const cx = Math.min(nx - 1, Math.max(1, gx));
      const cyy = Math.min(ny - 1, Math.max(1, gy));
      const czz = Math.min(nz - 1, Math.max(1, gz));
      const at = (x: number, y: number, z: number) => f[(z * ny + y) * nx + x];
      const dx = at(cx + 1, cyy, czz) - at(cx - 1, cyy, czz);
      const dy = at(cx, cyy + 1, czz) - at(cx, cyy - 1, czz);
      const dz = at(cx, cyy, czz + 1) - at(cx, cyy, czz - 1);
      // The gradient points *into* the fluid (density increases inward), so the
      // outward normal is its negation.
      const len = Math.hypot(dx, dy, dz) || 1;
      nor[o3] = -dx / len;
      nor[o3 + 1] = -dy / len;
      nor[o3 + 2] = -dz / len;
    }
  }
}
