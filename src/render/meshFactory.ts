import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ShapeDesc, Vec3, Quat } from '../core/types';

/**
 * Turns an engine-agnostic ShapeDesc into a THREE geometry.
 *
 * Callers are expected to deduplicate by `signature()` within one scene and
 * to dispose what they build: the layer owns the geometries of the scene it
 * is currently showing, so nothing accumulates across scene changes.
 */
export function buildGeometry(shape: ShapeDesc): THREE.BufferGeometry {
  return build(shape);
}

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

function build(s: ShapeDesc): THREE.BufferGeometry {
  switch (s.kind) {
    case 'box':
      return new THREE.BoxGeometry(s.halfExtents[0] * 2, s.halfExtents[1] * 2, s.halfExtents[2] * 2);
    case 'sphere':
      return new THREE.SphereGeometry(s.radius, 20, 14);
    case 'capsule': {
      const g = new THREE.CapsuleGeometry(s.radius, s.halfHeight * 2, 6, 16);
      return g;
    }
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
        const g = build(child.shape).clone();
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
 * Colour policy: structural statics are neutral, "aggressor" bodies (the ones a
 * scenario flings at something) are hot, everything else gets a cool hue ramp so
 * individual bodies stay distinguishable when they pile up.
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
    default: break;
  }
  const palette = [0x4c7dff, 0x3fb6a8, 0x6c8ee6, 0x4fa3d1, 0x7fb069, 0xc98a3c, 0xa06ad4, 0x3f8fbf];
  return palette[index % palette.length];
}

export function quatToThree(q: Quat): THREE.Quaternion {
  return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
}

export function vecToThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}
