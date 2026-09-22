/**
 * Shared infrastructure for the hand-written GL backends.
 *
 * Four of the renderers in this lab talk to WebGL directly (the full pipeline,
 * a point cloud, a wireframe pass and the WebGL1 variant). They differ only in
 * *what* they submit; the camera, the matrices and the shader plumbing are all
 * identical. Keeping one copy here means a fix to the framing formula or the
 * near-plane logic lands in all of them at once.
 *
 * This file deliberately does not touch the existing three.js / Babylon /
 * Canvas2D backends - those are framework-driven and share nothing with a
 * hand-rolled pipeline.
 */
import type { BodyState, Vec3 } from '../core/types';

export type Mat4 = Float32Array;

// ------------------------------------------------------------------ maths

/** Column-major perspective projection, matching WebGL's convention. */
export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const out = new Float32Array(16);
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Direction to a unit vector, for light uniforms. */
export function normalizeDir(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- shaders

export function compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader 失败');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败：' + log);
  }
  return sh;
}

export function linkProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram 失败');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('着色器链接失败：' + log);
  }
  return prog;
}

/**
 * GLSL prefix.
 *
 * WebGL1 needs `#version 100`-style source with no `in`/`out`/`layout`, and
 * instancing arrives through ANGLE_instanced_arrays rather than the core API.
 * Rather than maintain two copies of every shader, the backends write GLSL 300
 * and this prefix rewrites it down for the WebGL1 variant.
 */
export function glslFor(gl: WebGLRenderingContext | WebGL2RenderingContext, src: string): string {
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (isWebGL2) return src;
  return src
    .replace('#version 300 es', '')
    .replace(/\bin /g, 'varying ')
    .replace(/\bout vec4 fragColor;/g, '')
    .replace(/\bout /g, 'varying ')
    .replace(/\btexture\(/g, 'texture2D(');
}

// ----------------------------------------------------------- orbit camera

/**
 * The lab's orbit camera.
 *
 * Written once and shared, because all four hand-written backends must frame a
 * scene identically - any divergence here would show up as "the renderers draw
 * different things", which is exactly the confusion this lab exists to remove.
 */
export class OrbitCamera {
  target: Vec3 = [0, 3, 0];
  radius = 30;
  /** Azimuth, measured from +Z like three.js. */
  theta = 0.678;
  /** Polar angle from +Y. */
  phi = 0.836;

  private dragging = false;
  private last: [number, number] = [0, 0];

  /**
   * Frames content of `contentRadius` around `target`.
   *
   * Same formula as the framework backends: the ground only caps the distance,
   * it never drives it, because a 200 m floor would otherwise push the camera
   * ~100 m out and leave a 7 m pyramid a few pixels tall.
   */
  frame(contentRadius: number, groundSize = 0, target?: Vec3, radiusScale = 2.6): void {
    const wanted = Math.max(9, contentRadius * radiusScale);
    const r = groundSize > 0 ? Math.min(wanted, Math.max(11, groundSize * 0.6)) : wanted;
    const t: Vec3 = target ?? [0, Math.max(1.4, contentRadius * 0.4), 0];
    this.target = [t[0], t[1], t[2]];
    this.radius = r * Math.hypot(0.5, 0.72, 0.62);
    this.phi = Math.acos(0.72 / Math.hypot(0.5, 0.72, 0.62));
    this.theta = Math.atan2(0.5, 0.62);
  }

  eye(): Vec3 {
    const sp = Math.sin(this.phi);
    return [
      this.target[0] + this.radius * sp * Math.sin(this.theta),
      this.target[1] + this.radius * Math.cos(this.phi),
      this.target[2] + this.radius * sp * Math.cos(this.theta),
    ];
  }

  viewProj(w: number, h: number): Mat4 {
    return multiply(
      perspective((50 * Math.PI) / 180, w / Math.max(1, h), 0.1, 40000),
      lookAt(this.eye(), this.target, [0, 1, 0]),
    );
  }

  /** Forward unit vector, used for near-plane clipping. */
  forward(): Vec3 {
    const eye = this.eye();
    return normalizeDir([
      this.target[0] - eye[0],
      this.target[1] - eye[1],
      this.target[2] - eye[2],
    ]);
  }

  attach(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.last = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last[0];
      const dy = e.clientY - this.last[1];
      this.last = [e.clientX, e.clientY];
      this.theta -= dx * 0.006;
      this.phi = clamp(this.phi - dy * 0.006, 0.08, Math.PI * 0.495);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = clamp(this.radius * (1 + Math.sign(e.deltaY) * 0.12), 1.5, 4000);
    }, { passive: false });
  }

  probe(): Record<string, unknown> {
    const eye = this.eye();
    return {
      pos: [r2(eye[0]), r2(eye[1]), r2(eye[2])],
      target: [r2(this.target[0]), r2(this.target[1]), r2(this.target[2])],
      fov: 50,
      near: 0.1,
      far: 40000,
      radius: r2(this.radius),
      theta: r3(this.theta),
      phi: r3(this.phi),
    };
  }
}

// ------------------------------------------------------------ scene props

/** The 2 m floor grid and axis lines, in the colour the other backends use. */
export function floorLines(half: number, y = 0.02, step = 2): { verts: Float32Array; count: number } {
  const data: number[] = [];
  const major: [number, number, number] = [0.765, 0.796, 0.847];
  const minor: [number, number, number] = [0.867, 0.890, 0.925];
  for (let i = -half; i <= half; i += step) {
    const c = i % 10 === 0 ? major : minor;
    data.push(-half, y, i, ...c, half, y, i, ...c);
    data.push(i, y, -half, ...c, i, y, half, ...c);
  }
  return { verts: new Float32Array(data), count: data.length / 6 };
}

export function axisLines(len = 3): { verts: Float32Array; count: number } {
  const data = new Float32Array([
    0, 0, 0, 1, 0.24, 0.24,
    len, 0, 0, 1, 0.24, 0.24,
    0, 0, 0, 0.24, 0.8, 0.24,
    0, len, 0, 0.24, 0.8, 0.24,
    0, 0, 0, 0.24, 0.4, 1,
    0, 0, len, 0.24, 0.4, 1,
  ]);
  return { verts: data, count: 6 };
}

// --------------------------------------------------------------- helpers

/** Composes a TRS matrix into `out` at `o` (column-major). */
export function writeInstanceMatrix(out: Float32Array, o: number, s: BodyState): void {
  const x = s.rotation[0], y = s.rotation[1], z = s.rotation[2], w = s.rotation[3];
  const len = Math.hypot(x, y, z, w) || 1;
  const qx = x / len, qy = y / len, qz = z / len, qw = w / len;

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  out[o + 0] = 1 - (yy + zz);
  out[o + 1] = xy + wz;
  out[o + 2] = xz - wy;
  out[o + 3] = 0;
  out[o + 4] = xy - wz;
  out[o + 5] = 1 - (xx + zz);
  out[o + 6] = yz + wx;
  out[o + 7] = 0;
  out[o + 8] = xz + wy;
  out[o + 9] = yz - wx;
  out[o + 10] = 1 - (xx + yy);
  out[o + 11] = 0;
  out[o + 12] = s.position[0];
  out[o + 13] = s.position[1];
  out[o + 14] = s.position[2];
  out[o + 15] = 1;
}

const HUGE = 1e5;

/** False for NaN / absurd poses; those instances are collapsed instead of drawn. */
export function renderable(s: BodyState | undefined): boolean {
  if (!s) return false;
  const p = s.position;
  const r = s.rotation;
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) &&
    Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]) && Number.isFinite(r[3]) &&
    Math.abs(p[0]) < HUGE && Math.abs(p[1]) < HUGE && Math.abs(p[2]) < HUGE;
}

export function r2(v: number): number { return Number(v.toFixed(2)); }
export function r3(v: number): number { return Number(v.toFixed(3)); }

/** Vertex arrays for the full-resolution primitive shapes, de-indexed or not. */
export interface FlatGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Unique edges of an indexed triangle mesh, for the wireframe backend.
 *
 * Deduplicated, because drawing every triangle's three edges would submit each
 * shared edge twice - and on a sphere that is most of them.
 */
export function edgeIndices(indices: Uint32Array, maxEdges = 200000): Uint32Array {
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (a: number, b: number) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    // 20 bits per vertex is enough for any geometry here.
    const key = lo * 1048576 + hi;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a, b);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    if (out.length >= maxEdges * 2) break;
    add(indices[t], indices[t + 1]);
    add(indices[t + 1], indices[t + 2]);
    add(indices[t + 2], indices[t]);
  }
  return new Uint32Array(out);
}

/**
 * GL context attributes shared by every hand-written backend.
 *
 * `preserveDrawingBuffer` is deliberately off by default: it costs performance
 * and this is a benchmark lab. But a canvas created without it cannot be read
 * back from inside the page once the frame has been composited - `drawImage`
 * returns fully transparent pixels - which makes in-page pixel verification
 * impossible. `?preserveBuffer=1` turns it on for the acceptance script, so
 * the measurement path stays clean while the checking path stays honest.
 */
export function glContextAttributes(extra: WebGLContextAttributes = {}): WebGLContextAttributes {
  const preserve = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('preserveBuffer') === '1';
  return {
    antialias: true,
    alpha: false,
    depth: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: preserve,
    ...extra,
  };
}
