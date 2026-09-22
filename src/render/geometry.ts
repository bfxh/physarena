import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Quat, ShapeDesc } from '../core/types';

/**
 * Engine-agnostic triangle soup.
 *
 * Renderers differ in almost everything - pipeline state, batching strategy,
 * shader language - but not in the vertices they end up pushing. So the
 * geometry stage is shared: every backend draws the *same* triangles, and any
 * visual difference is then attributable to the backend rather than to the
 * mesh. That property is the whole point of being able to hot-swap renderers.
 *
 * three.js is used here as a geometry/maths library, not as a renderer: its
 * `ConvexHull` is already the hull source for the cannon-es adapter, so the
 * dependency exists regardless of which renderer is selected.
 */
export interface GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Stable cache key for a shape. Two shapes with the same key share a mesh. */
export function signature(s: ShapeDesc): string {
  switch (s.kind) {
    case 'box': return `box:${s.halfExtents.join(',')}`;
    case 'sphere': return `sph:${s.radius}`;
    case 'capsule': return `cap:${s.radius},${s.halfHeight}`;
    case 'cylinder': return `cyl:${s.radius},${s.halfHeight}`;
    case 'cone': return `cone:${s.radius},${s.halfHeight}`;
    case 'convex': return `cvx:${hashNumbers(s.points)}`;
    // The index buffer is part of the geometry: two meshes sharing a vertex
    // list but differing in topology used to collide in this cache and one of
    // them was rendered with the other's triangles.
    case 'trimesh': return `mesh:${s.vertices.length},${s.indices.length},${hashNumbers(s.vertices)},${hashNumbers(s.indices)}`;
    case 'compound':
      // Child rotation must be in the key: build() applies it, so two
      // compounds with equal children/offsets but different rotations must
      // not share one geometry.
      return `cmp:${s.children.map((c) => `${signature(c.shape)}@${c.offset.join(',')}@${(c.rotation ?? []).join(',')}`).join('|')}`;
  }
}

function hashNumbers(a: ArrayLike<number>): string {
  // Cheap FNV-ish digest; collisions only cost a slightly wrong mesh, and the
  // geometry itself is rebuilt from the real data anyway.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < a.length; i++) {
    h ^= (a[i] * 1000) | 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

/**
 * Colour policy: structural statics are neutral, "aggressor" bodies (the ones a
 * scenario flings at something) are hot, everything else gets a cool hue ramp so
 * individual bodies stay distinguishable when they pile up.
 *
 * Shared by every renderer so switching backends never changes the colours.
 */
export function colorFor(tag: string | undefined, index: number): number {
  switch (tag) {
    case 'ground': case 'ground-far': return 0x8d97a6;
    case 'wall': case 'corridor-wall': case 'thin-wall': return 0x7b8494;
    case 'terrain': return 0x6f8a6a;
    case 'platform': case 'rail': case 'roof': return 0x9aa4b2;
    case 'projectile': case 'shell': case 'pusher': return 0xe4573c;
    case 'anchor': case 'pivot': return 0xb9c0cc;
    case 'ball': case 'top': case 'wheel': return 0xf0a03a;
    case 'cloth': return 0x4fa3d1;
    case 'crank': case 'rod': case 'slider': return 0x5ec07f;
    case 'chassis': return 0x8e6ad4;
    // Water gets its own colour on purpose: a fluid built from a few hundred
    // spheres is only readable as water if every particle is the same blue.
    // Left to the palette ramp they come out in eight different hues and the
    // scene reads as "a pile of balls" - which is what it looked like before.
    case 'fluid': return 0x2f8fd8;
    case 'grain': return 0xc9a35c;
    default: break;
  }
  const palette = [0x4c7dff, 0x3fb6a8, 0x6c8ee6, 0x4fa3d1, 0x7fb069, 0xc98a3c, 0xa06ad4, 0x3f8fbf];
  return palette[index % palette.length];
}

/** Per-instance colours for one bucket, packed as RGB floats. */
export function instanceColors(
  bodies: { tag?: string }[],
  indices: readonly number[],
): Float32Array {
  const out = new Float32Array(indices.length * 3);
  const c = new THREE.Color();
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    c.setHex(colorFor(bodies[i]?.tag, i));
    out[k * 3] = c.r;
    out[k * 3 + 1] = c.g;
    out[k * 3 + 2] = c.b;
  }
  return out;
}

/** Turns a ShapeDesc into engine-agnostic arrays every renderer can consume. */
export function buildGeometryData(shape: ShapeDesc): GeometryData {
  return toData(buildThree(shape));
}

function toData(g: THREE.BufferGeometry): GeometryData {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) {
    g.dispose();
    return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) };
  }
  const positions = new Float32Array(pos.array.length);
  positions.set(pos.array as unknown as ArrayLike<number>);

  const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const normals = new Float32Array(positions.length);
  if (nrm && nrm.array.length === normals.length) {
    normals.set(nrm.array as unknown as ArrayLike<number>);
  }

  const idx = g.getIndex();
  let indices: Uint32Array;
  if (idx) {
    indices = new Uint32Array(idx.array.length);
    indices.set(idx.array as unknown as ArrayLike<number>);
  } else {
    indices = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) indices[i] = i;
  }

  g.dispose();
  return { positions, normals, indices };
}

function buildThree(s: ShapeDesc): THREE.BufferGeometry {
  switch (s.kind) {
    case 'box':
      return new THREE.BoxGeometry(s.halfExtents[0] * 2, s.halfExtents[1] * 2, s.halfExtents[2] * 2);
    case 'sphere':
      return new THREE.SphereGeometry(s.radius, 20, 14);
    case 'capsule':
      return new THREE.CapsuleGeometry(s.radius, s.halfHeight * 2, 6, 16);
    case 'cylinder':
      return new THREE.CylinderGeometry(s.radius, s.radius, s.halfHeight * 2, 22, 1);
    case 'cone':
      return new THREE.ConeGeometry(s.radius, s.halfHeight * 2, 22, 1);
    case 'convex': {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i + 2 < s.points.length; i += 3) {
        pts.push(new THREE.Vector3(s.points[i], s.points[i + 1], s.points[i + 2]));
      }
      try {
        return new ConvexGeometry(pts);
      } catch {
        return new THREE.IcosahedronGeometry(0.3, 1);
      }
    }
    case 'trimesh': {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.vertices, 3));
      g.setIndex(s.indices);
      g.computeVertexNormals();
      return g;
    }
    case 'compound': {
      const kids: THREE.BufferGeometry[] = [];
      for (const child of s.children) {
        const g = buildThree(child.shape).clone();
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(...child.offset),
          new THREE.Quaternion(...(child.rotation ?? [0, 0, 0, 1] as Quat)),
          new THREE.Vector3(1, 1, 1),
        );
        g.applyMatrix4(m);
        kids.push(g);
      }
      const merged = mergeGeometries(kids, false);
      kids.forEach((k) => k.dispose());
      return merged ?? new THREE.BoxGeometry(0.5, 0.5, 0.5);
    }
  }
}

/**
 * GPU/pipeline-independent bounds, used for the software rasteriser's back-face
 * culling and for framing. Computed from the data so every backend agrees.
 */
export function boundsOf(data: GeometryData): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < data.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = data.positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  return { min, max };
}

/**
 * Geometry is built once per shape signature and shared by every renderer and
 * every layer. Hulling a rock point cloud is expensive enough that rebuilding
 * it once per pane would show up in the frame budget, and with several
 * renderers selectable the same data gets asked for repeatedly.
 *
 * The cache is capped rather than LRU: plain arrays are cheap, and a long
 * session must not be able to grow this without bound.
 */
const dataCache = new Map<string, GeometryData>();
const DATA_CACHE_MAX = 384;

export function cachedGeometryData(shape: ShapeDesc, key = signature(shape)): GeometryData {
  const hit = dataCache.get(key);
  if (hit) return hit;
  const data = buildGeometryData(shape);
  if (dataCache.size >= DATA_CACHE_MAX) dataCache.clear();
  dataCache.set(key, data);
  return data;
}

/** Live geometry-cache size, surfaced in the metrics panel. */
export function geometryCacheSize(): number {
  return dataCache.size;
}

/** Bytes held by the shared geometry cache (positions + normals + indices). */
export function geometryCacheBytes(): number {
  let bytes = 0;
  for (const d of dataCache.values()) {
    bytes += d.positions.byteLength + d.normals.byteLength + d.indices.byteLength;
  }
  return bytes;
}

export function clearGeometryCache(): void {
  dataCache.clear();
}

