import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export interface ImportedModel {
  name: string;
  /** Convex hull point cloud in the body's local frame, already normalised. */
  points: number[];
  /** Longest axis of the normalised model, used for camera framing. */
  extent: number;
  /** Hull vertices kept, shown in the UI so the cost is visible. */
  vertexCount: number;
  sourceTriangles: number;
}

/** Normalises any model so its longest axis is `target` metres. */
function normalise(points: THREE.Vector3[], target = 2): { pts: THREE.Vector3[]; extent: number } {
  const box = new THREE.Box3().setFromPoints(points);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const s = target / longest;
  const centred = points.map((p) => p.clone().sub(centre).multiplyScalar(s));
  return { pts: centred, extent: target };
}

function collectPoints(root: THREE.Object3D): { points: THREE.Vector3[]; triangles: number } {
  const points: THREE.Vector3[] = [];
  let triangles = 0;
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom?.attributes?.position) return;
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const index = geom.index;
    const v = new THREE.Vector3();
    // Convex hulls only need the surface, and a stride keeps huge meshes cheap.
    const stride = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      // NaN/Inf vertices (crafted or corrupt files) would otherwise reach the
      // adapters and blow up engine.build() with an unhelpful error.
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
      points.push(v.clone());
    }
    triangles += index ? index.count / 3 : pos.count / 3;
  });
  return { points, triangles };
}

/**
 * Reads a GLTF/GLB/OBJ file and bakes it into a convex hull collider.
 *
 * Physics engines cannot use a render mesh directly, so the shape is reduced to
 * a hull - which is exactly what every engine in this lab consumes fastest.
 */
export async function loadModelFile(file: File): Promise<ImportedModel> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  let root: THREE.Object3D;

  if (ext === 'glb' || ext === 'gltf') {
    const buf = await file.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buf, '');
    root = gltf.scene;
  } else if (ext === 'obj') {
    const text = await file.text();
    root = new OBJLoader().parse(text);
  } else {
    throw new Error(`不支持的格式 .${ext}，请使用 .glb / .gltf / .obj`);
  }

  const { points, triangles } = collectPoints(root);
  if (points.length < 4) throw new Error('模型里没有可用的三角面数据');

  const { pts } = normalise(points);
  let hullVerts: THREE.Vector3[];
  try {
    const hull = new ConvexHull().setFromPoints(pts);
    hullVerts = hull.vertices.map((v) => v.point);
  } catch {
    hullVerts = pts;
  }

  // Engines degrade sharply past a few hundred hull vertices; cap it. Hulls are
  // angular, so the cap keeps the 6 axis extremes plus every stride-th vertex
  // instead of a bare index stride, which could drop the extremal points.
  const MAX = 256;
  let kept = hullVerts;
  if (hullVerts.length > MAX) {
    const extremes: THREE.Vector3[] = [];
    for (const axis of ['x', 'y', 'z'] as const) {
      let lo = hullVerts[0], hi = hullVerts[0];
      for (const v of hullVerts) {
        if (v[axis] < lo[axis]) lo = v;
        if (v[axis] > hi[axis]) hi = v;
      }
      extremes.push(lo, hi);
    }
    const chosen = new Set<THREE.Vector3>(extremes);
    const stride = Math.ceil(hullVerts.length / (MAX - extremes.length));
    for (let i = 0; i < hullVerts.length && chosen.size < MAX; i += stride) {
      chosen.add(hullVerts[i]);
    }
    kept = [...chosen];
  }

  const flat: number[] = [];
  for (const v of kept) flat.push(v.x, v.y, v.z);

  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    points: flat,
    extent: 2,
    vertexCount: kept.length,
    sourceTriangles: Math.round(triangles),
  };
}
