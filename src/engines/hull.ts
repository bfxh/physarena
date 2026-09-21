import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { Vec3 } from '../core/types';

export interface HullMesh {
  vertices: Vec3[];
  /** Indices into `vertices`, counter-clockwise when viewed from outside. */
  faces: number[][];
  /** Outward unit normals, parallel to `faces`. */
  normals: Vec3[];
}

/**
 * Converts a flat point cloud into an explicit hull with face indices.
 *
 * cannon-es is the only engine here that wants `{vertices, faces}` rather than
 * a raw point cloud, and getting the winding wrong makes bodies behave as if
 * their normals point inward, so the faces are taken from three's ConvexHull
 * rather than re-derived.
 */
export function hullFromPoints(flat: ArrayLike<number>): HullMesh | null {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    pts.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
  }
  if (pts.length < 4) return null;

  let hull: ConvexHull;
  try {
    hull = new ConvexHull().setFromPoints(pts);
  } catch {
    return null;
  }
  if (!hull.faces.length) return null;

  const index = new Map<THREE.Vector3, number>();
  const vertices: Vec3[] = [];
  for (const v of hull.vertices) {
    index.set(v.point, vertices.length);
    vertices.push([v.point.x, v.point.y, v.point.z]);
  }

  const faces: number[][] = [];
  const normals: Vec3[] = [];
  for (const face of hull.faces) {
    const ring: number[] = [];
    let edge = face.edge;
    let guard = 0;
    do {
      const idx = index.get(edge.head().point);
      if (idx === undefined) { ring.length = 0; break; }
      ring.push(idx);
      edge = edge.next;
    } while (edge !== face.edge && ++guard < 256);
    if (ring.length >= 3) {
      faces.push(ring);
      normals.push([face.normal.x, face.normal.y, face.normal.z]);
    }
  }
  if (faces.length < 4) return null;
  return { vertices, faces, normals };
}
