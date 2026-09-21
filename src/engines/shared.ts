import type { BodyDesc, ShapeDesc, ShapeKind, Vec3, Quat } from '../core/types';

/**
 * Every engine supports a different subset of primitives. Instead of silently
 * turning a cone into a box (which would make benchmark numbers meaningless),
 * each fallback is explicit, geometrically faithful, and recorded so the UI can
 * tell the user what actually got simulated.
 */

/** Ring of points on the Y-aligned cone surface, apex included. */
export function coneHullPoints(radius: number, halfHeight: number, segments = 16): number[] {
  const pts: number[] = [0, halfHeight, 0];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, -halfHeight, Math.sin(a) * radius);
  }
  return pts;
}

/** Capsule (Y axis) sampled as two hemispheres joined by the barrel. */
export function capsuleHullPoints(radius: number, halfHeight: number, segments = 12, rings = 3): number[] {
  const pts: number[] = [];
  for (let r = 0; r <= rings; r++) {
    // top hemisphere
    const phi = (r / rings) * (Math.PI / 2);
    const y = halfHeight + Math.cos(phi) * radius;
    const rr = Math.sin(phi) * radius;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
  }
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);
    const y = -halfHeight - Math.cos(phi) * radius;
    const rr = Math.sin(phi) * radius;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
  }
  return pts;
}

/** Y-aligned cylinder as two rings plus caps. */
export function cylinderHullPoints(radius: number, halfHeight: number, segments = 16): number[] {
  const pts: number[] = [];
  for (const y of [halfHeight, -halfHeight]) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
    }
  }
  return pts;
}

/** Quaternion-rotate a vector (v' = v + 2 q_vec x (q_vec x v + w v)). */
function rotateByQuat(v: Vec3, q: Quat): Vec3 {
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

export function shapeAabb(shape: ShapeDesc): { min: Vec3; max: Vec3 } {
  switch (shape.kind) {
    case 'box': {
      const h = shape.halfExtents;
      return { min: [-h[0], -h[1], -h[2]], max: [h[0], h[1], h[2]] };
    }
    case 'sphere': {
      const r = shape.radius;
      return { min: [-r, -r, -r], max: [r, r, r] };
    }
    case 'capsule': {
      const r = shape.radius, h = shape.halfHeight + shape.radius;
      return { min: [-r, -h, -r], max: [r, h, r] };
    }
    case 'cylinder': case 'cone': {
      const r = shape.radius, h = shape.halfHeight;
      return { min: [-r, -h, -r], max: [r, h, r] };
    }
    case 'convex': {
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 2 < shape.points.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = shape.points[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      return { min, max };
    }
    case 'trimesh': {
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 2 < shape.vertices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = shape.vertices[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      return { min, max };
    }
    case 'compound': {
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const c of shape.children) {
        const bb = shapeAabb(c.shape);
        // A rotated child contributes its rotated AABB; ignoring the rotation
        // under-sized the compound AABB (and therefore mass/box fallbacks).
        const corners: Vec3[] = [
          [bb.min[0], bb.min[1], bb.min[2]], [bb.max[0], bb.min[1], bb.min[2]],
          [bb.min[0], bb.max[1], bb.min[2]], [bb.max[0], bb.max[1], bb.min[2]],
          [bb.min[0], bb.min[1], bb.max[2]], [bb.max[0], bb.min[1], bb.max[2]],
          [bb.min[0], bb.max[1], bb.max[2]], [bb.max[0], bb.max[1], bb.max[2]],
        ];
        const q = c.rotation ?? [0, 0, 0, 1];
        for (const corner of corners) {
          const p = rotateByQuat(corner, q);
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k] + c.offset[k]);
            max[k] = Math.max(max[k], p[k] + c.offset[k]);
          }
        }
      }
      return { min, max };
    }
  }
}

export function shapeVolume(shape: ShapeDesc): number {
  switch (shape.kind) {
    case 'box':
      return 8 * shape.halfExtents[0] * shape.halfExtents[1] * shape.halfExtents[2];
    case 'sphere':
      return (4 / 3) * Math.PI * shape.radius ** 3;
    case 'capsule':
      return Math.PI * shape.radius ** 2 * (2 * shape.halfHeight) +
        (4 / 3) * Math.PI * shape.radius ** 3;
    case 'cylinder':
      return Math.PI * shape.radius ** 2 * (2 * shape.halfHeight);
    case 'cone':
      return (1 / 3) * Math.PI * shape.radius ** 2 * (2 * shape.halfHeight);
    case 'convex':
    case 'trimesh': {
      const bb = shapeAabb(shape);
      return Math.max(
        1e-6,
        (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]) * 0.55,
      );
    }
    case 'compound': {
      let v = 0;
      for (const c of shape.children) v += shapeVolume(c.shape);
      return Math.max(1e-6, v * 0.8);
    }
  }
}

export function massOf(body: BodyDesc): number {
  if (body.mass != null) return body.mass;
  return Math.max(0.01, (body.density ?? 1000) * shapeVolume(body.shape));
}

export interface Adaptation {
  shape: ShapeDesc;
  /** Human-readable note, e.g. "cone -> convex hull". Empty when native. */
  note: string;
}

/**
 * Returns a shape the target engine can actually build, plus a note describing
 * any loss of fidelity. Fallbacks chain (capsule -> hull -> box) so an engine
 * with only box/sphere still gets something of the right size.
 */
export function adaptShape(shape: ShapeDesc, supported: ShapeKind[]): Adaptation {
  if (supported.includes(shape.kind)) return { shape, note: '' };
  const notes: string[] = [];
  let current: ShapeDesc = shape;
  for (let depth = 0; depth < 4; depth++) {
    const next = firstFallback(current);
    notes.push(next.note);
    current = next.shape;
    if (supported.includes(current.kind)) break;
  }
  return { shape: current, note: collectNotes(notes).join(' ') };
}

function firstFallback(shape: ShapeDesc): Adaptation {
  switch (shape.kind) {
    case 'cone':
      return {
        shape: { kind: 'convex', points: coneHullPoints(shape.radius, shape.halfHeight) },
        note: 'cone→凸包',
      };
    case 'capsule':
      return {
        shape: { kind: 'convex', points: capsuleHullPoints(shape.radius, shape.halfHeight) },
        note: 'capsule→凸包',
      };
    case 'cylinder':
      return {
        shape: { kind: 'convex', points: cylinderHullPoints(shape.radius, shape.halfHeight) },
        note: 'cylinder→凸包',
      };
    case 'convex':
    case 'trimesh':
    case 'compound': {
      const bb = shapeAabb(shape);
      return {
        shape: {
          kind: 'box',
          halfExtents: [
            Math.max(0.02, (bb.max[0] - bb.min[0]) / 2),
            Math.max(0.02, (bb.max[1] - bb.min[1]) / 2),
            Math.max(0.02, (bb.max[2] - bb.min[2]) / 2),
          ],
        },
        note: `${shape.kind === 'convex' ? '凸包' : shape.kind === 'trimesh' ? '三角网' : '复合体'}→盒`,
      };
    }
    case 'box': case 'sphere':
      return { shape, note: '' };
  }
}

/** Euler XYZ in degrees - oimo.js only accepts Euler rotations, in degrees. */
export function quatToEulerDeg(q: Quat): Vec3 {
  const [x, y, z, w] = quatOr(q);
  // Derived directly rather than through THREE to keep the adapters dependency-light.
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);

  const d = 180 / Math.PI;
  return [roll * d, pitch * d, yaw * d];
}

export function quatOr(q: Quat | undefined): Quat {
  const v = q ?? [0, 0, 0, 1];
  const len = Math.hypot(v[0], v[1], v[2], v[3]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len, v[3] / len];
}

/** Turns an axis-angle-free axis vector into a 180° safe rotation axis. */
export function normalizeAxis(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len < 1e-6) return [0, 1, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** Small helper: deduplicate free-form adaptation notes. */
export function collectNotes(notes: string[]): string[] {
  return [...new Set(notes.filter(Boolean))];
}

/** Ray from the origin of projection, used by pick-to-impulse tooling. */
export interface RayHit {
  index: number;
  point: Vec3;
}
