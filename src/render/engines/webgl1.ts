import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { cachedGeometryData, instanceColors, signature, type GeometryData } from '../geometry';
import { slotGrid } from '../layout';
import {
  OrbitCamera, axisLines, floorLines, glContextAttributes, linkProgram, renderable, r2, r3,
} from '../glCommon';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'webgl1',
  name: '原生 WebGL1',
  language: 'GLSL',
  backend: 'WebGL1',
  license: 'MIT',
  homepage: 'https://www.khronos.org/webgl/',
  accent: '#c98a3c',
  blurb:
    '上一代 API：GLSL 100、没有 VAO、实例化要靠 ANGLE 扩展、矩阵从 app 里传进去。和同源的 WebGL2 后端跑同一套场景，就能看出「少了几样东西」到底贵多少。',
  features: { instancing: true, lighting: true, antialias: true, scissorPanes: true, depthBuffer: true },
  status: 'stable',
  costKb: 0,
};

/**
 * Availability probe for the renderer registry.
 *
 * This backend deliberately restricts itself to WebGL1 core plus exactly one
 * extension, so it is worth reporting which of those is missing before the
 * user clicks the card and gets a thrown error instead.
 */
export function availability(): string | undefined {
  if (typeof document === 'undefined') return '不在浏览器环境';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return '此浏览器不提供 WebGL1 上下文';
    if (!gl.getExtension('ANGLE_instanced_arrays')) {
      return '缺少 ANGLE_instanced_arrays 扩展：WebGL1 核心没有实例化能力';
    }
    if (!gl.getExtension('OES_element_index_uint')) {
      return undefined; // Degrades to 16-bit indices rather than failing.
    }
    return undefined;
  } catch (e) {
    return 'WebGL1 能力探测失败：' + (e instanceof Error ? e.message : String(e));
  }
}

// GLSL 100: attribute/varying and gl_FragColor, no layout qualifiers.
const VS = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec4 aInst0;
attribute vec4 aInst1;
attribute vec4 aInst2;
attribute vec4 aInst3;
attribute vec3 aInstColor;
uniform mat4 uViewProj;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  mat4 m = mat4(aInst0, aInst1, aInst2, aInst3);
  vec4 world = m * vec4(aPosition, 1.0);
  vNormal = mat3(m) * aNormal;
  vColor = aInstColor;
  gl_Position = uViewProj * world;
}`;

const FS = `
precision highp float;
varying vec3 vNormal;
varying vec3 vColor;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uLightDir1;
uniform vec3 uLightCol1;
uniform vec3 uLightDir2;
uniform vec3 uLightCol2;
void main() {
  vec3 n = normalize(vNormal);
  vec3 ambient = mix(uGround, uSky, n.y * 0.5 + 0.5) * 1.05;
  vec3 c = vColor * ambient;
  c += vColor * uLightCol1 * max(dot(n, uLightDir1), 0.0);
  c += vColor * uLightCol2 * max(dot(n, uLightDir2), 0.0);
  gl_FragColor = vec4(c, 1.0);
}`;

const LINE_VS = `
attribute vec3 aPosition;
attribute vec3 aColor;
uniform mat4 uViewProj;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const LINE_FS = `
precision highp float;
varying vec3 vColor;
uniform float uAlpha;
void main() { gl_FragColor = vec4(vColor, uAlpha); }`;

/**
 * One engine's state, drawn without vertex array objects.
 *
 * WebGL1 has no VAO in core, so every draw re-specifies its attribute pointers.
 * That is the whole point of this backend: the extra `vertexAttribPointer`
 * traffic per shape per frame is the cost WebGL2's VAO removed, and it is
 * measurable here against the identical WebGL2 scene.
 */
export class WebGL1Layer implements IRenderLayer {
  private gl: WebGLRenderingContext;
  private inst: ANGLE_instanced_arrays;
  private buckets: Gl1Bucket[] = [];
  private locCache = new Map<WebGLProgram, { pos: number; nrm: number; inst: number; col: number }>();
  private disposed = false;

  constructor(readonly id: string, gl: WebGLRenderingContext, inst: ANGLE_instanced_arrays) {
    this.gl = gl;
    this.inst = inst;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();
    const gl = this.gl;
    const grouped = new Map<string, { data: GeometryData; indices: number[] }>();
    for (let i = 0; i < bodies.length; i++) {
      const key = signature(bodies[i].shape);
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = { data: cachedGeometryData(bodies[i].shape, key), indices: [] };
        grouped.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    for (const [key, bucket] of grouped) {
      const n = bucket.indices.length;
      const data = bucket.data;

      const posBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);

      const nrmBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.normals, gl.STATIC_DRAW);

      const matBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, matBuf);
      gl.bufferData(gl.ARRAY_BUFFER, n * 64, gl.DYNAMIC_DRAW);

      const colBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceColors(bodies, bucket.indices), gl.STATIC_DRAW);

      const idxBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      // WebGL1 needs the OES_element_index_uint extension for 32-bit indices;
      // without it, fall back to 16-bit, which is why large meshes are split.
      const needsWide = data.positions.length / 3 > 65535;
      const wide = needsWide && !!gl.getExtension('OES_element_index_uint');
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        wide ? data.indices : new Uint16Array(data.indices),
        gl.STATIC_DRAW,
      );

      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

      this.buckets.push({
        key,
        posBuf,
        nrmBuf,
        matBuf,
        colBuf,
        idxBuf,
        indexType: wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
        indexCount: data.indices.length,
        count: n,
        indices: bucket.indices,
        matrices: new Float32Array(n * 16),
      });
    }
  }

  sync(states: BodyState[]) {
    const gl = this.gl;
    for (const b of this.buckets) {
      const m = b.matrices;
      for (let k = 0; k < b.count; k++) {
        const o = k * 16;
        const s = states[b.indices[k]];
        if (!renderable(s)) {
          m.fill(0, o, o + 16);
          continue;
        }
        writeMatrix(m, o, s!);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, b.matBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Attribute locations, looked up once per program.
   *
   * `getAttribLocation` is a synchronous driver query and was previously called
   * four times per bucket per frame - pure overhead that has nothing to do with
   * the WebGL1-vs-WebGL2 comparison this backend exists to make.
   */
  private locs(program: WebGLProgram): { pos: number; nrm: number; inst: number; col: number } {
    let c = this.locCache.get(program);
    if (!c) {
      const gl = this.gl;
      c = {
        pos: gl.getAttribLocation(program, 'aPosition'),
        nrm: gl.getAttribLocation(program, 'aNormal'),
        inst: gl.getAttribLocation(program, 'aInst0'),
        col: gl.getAttribLocation(program, 'aInstColor'),
      };
      this.locCache.set(program, c);
    }
    return c;
  }

  /**
   * Binds every attribute by hand. In WebGL2 this whole block collapses into a
   * single `bindVertexArray` - that difference is what this backend measures.
   */
  draw(program: WebGLProgram) {
    const gl = this.gl;
    const inst = this.inst;
    const { pos: aPosition, nrm: aNormal, inst: aInst0, col: aInstColor } = this.locs(program);
    let calls = 0;
    let triangles = 0;
    let instances = 0;

    for (const b of this.buckets) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.posBuf);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, b.nrmBuf);
      gl.enableVertexAttribArray(aNormal);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, b.matBuf);
      for (let k = 0; k < 4; k++) {
        gl.enableVertexAttribArray(aInst0 + k);
        gl.vertexAttribPointer(aInst0 + k, 4, gl.FLOAT, false, 64, k * 16);
        inst.vertexAttribDivisorANGLE(aInst0 + k, 1);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, b.colBuf);
      gl.enableVertexAttribArray(aInstColor);
      gl.vertexAttribPointer(aInstColor, 3, gl.FLOAT, false, 0, 0);
      inst.vertexAttribDivisorANGLE(aInstColor, 1);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idxBuf);
      inst.drawElementsInstancedANGLE(gl.TRIANGLES, b.indexCount, b.indexType, 0, b.count);

      // Reset the divisors so the shared line program (which reads the same
      // slots as plain per-vertex attributes) does not read them per instance.
      for (let k = 0; k < 4; k++) inst.vertexAttribDivisorANGLE(aInst0 + k, 0);
      inst.vertexAttribDivisorANGLE(aInstColor, 0);

      calls++;
      triangles += (b.indexCount / 3) * b.count;
      instances += b.count;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    return { calls, triangles: Math.round(triangles), instances };
  }

  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }

  get bufferBytes(): number {
    let bytes = 0;
    for (const b of this.buckets) {
      bytes += b.indexCount * (b.indexType === this.gl.UNSIGNED_INT ? 4 : 2);
      bytes += b.count * 64 + b.count * 12;
    }
    return bytes;
  }

  probe(): unknown[] {
    const meshes: unknown[] = [];
    for (const b of this.buckets) {
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      let maxScale = 0, worst = -1;
      const samples: unknown[] = [];
      for (let i = 0; i < b.count; i++) {
        const o = i * 16;
        const m = b.matrices;
        const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
        const sc = Math.max(
          Math.hypot(m[o], m[o + 1], m[o + 2]),
          Math.hypot(m[o + 4], m[o + 5], m[o + 6]),
          Math.hypot(m[o + 8], m[o + 9], m[o + 10]),
        );
        if (sc > maxScale) { maxScale = sc; worst = i; }
        if (Number.isFinite(py)) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
        if (Number.isFinite(px)) { if (px < minX) minX = px; if (px > maxX) maxX = px; }
        if (i < 3) samples.push({ i, p: [r2(px), r2(py), r2(pz)], s: [r2(sc), r2(sc), r2(sc)] });
      }
      meshes.push({
        count: b.count,
        visible: true,
        maxScale: r3(maxScale),
        worstInstance: worst,
        x: minX === Infinity ? null : [r2(minX), r2(maxX)],
        y: minY === Infinity ? null : [r2(minY), r2(maxY)],
        geometry: 'WebGL1 buffer',
        params: { signature: b.key, indexCount: b.indexCount, hasVAO: false },
        samples,
      });
    }
    return meshes;
  }

  clear() {
    if (this.disposed) return;
    const gl = this.gl;
    for (const b of this.buckets) {
      gl.deleteBuffer(b.posBuf);
      gl.deleteBuffer(b.nrmBuf);
      gl.deleteBuffer(b.matBuf);
      gl.deleteBuffer(b.colBuf);
      gl.deleteBuffer(b.idxBuf);
    }
    this.buckets = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }
}

interface Gl1Bucket {
  key: string;
  posBuf: WebGLBuffer;
  nrmBuf: WebGLBuffer;
  matBuf: WebGLBuffer;
  colBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  indexType: number;
  indexCount: number;
  count: number;
  indices: number[];
  matrices: Float32Array;
}

function writeMatrix(out: Float32Array, o: number, s: BodyState) {
  const x = s.rotation[0], y = s.rotation[1], z = s.rotation[2], w = s.rotation[3];
  const l = Math.hypot(x, y, z, w) || 1;
  const qx = x / l, qy = y / l, qz = z / l, qw = w / l;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  out[o] = 1 - (yy + zz); out[o + 1] = xy + wz; out[o + 2] = xz - wy; out[o + 3] = 0;
  out[o + 4] = xy - wz; out[o + 5] = 1 - (xx + zz); out[o + 6] = yz + wx; out[o + 7] = 0;
  out[o + 8] = xz + wy; out[o + 9] = yz - wx; out[o + 10] = 1 - (xx + yy); out[o + 11] = 0;
  out[o + 12] = s.position[0]; out[o + 13] = s.position[1]; out[o + 14] = s.position[2];
  out[o + 15] = 1;
}

export class WebGL1RenderEngine implements IRenderEngine {
  readonly meta = meta;
  private gl!: WebGLRenderingContext;
  private inst!: ANGLE_instanced_arrays;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private program!: WebGLProgram;
  private lineProgram!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private lineUniforms: Record<string, WebGLUniformLocation | null> = {};
  private floorBufs: WebGLBuffer[] = [];
  private floorCount = 0;
  private axisBufs: WebGLBuffer[] = [];
  private axisCount = 0;
  private layers = new Map<string, WebGL1Layer>();
  readonly camera = new OrbitCamera();
  private disposed = false;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private lastInstances = 0;
  private lineLocPos: number | null = null;
  private lineLocCol: number | null = null;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.canvasHost = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    const gl = canvas.getContext('webgl', glContextAttributes()) as WebGLRenderingContext | null;
    if (!gl) throw new Error('无法创建 WebGL1 上下文。');
    const inst = gl.getExtension('ANGLE_instanced_arrays') as ANGLE_instanced_arrays | null;
    if (!inst) {
      throw new Error(
        '此浏览器不支持 ANGLE_instanced_arrays，无法做实例化渲染。' +
        '（这个后端刻意只用 WebGL1 核心 + 这一个扩展，否则它和 WebGL2 后端就没区别了。）',
      );
    }
    this.gl = gl;
    this.inst = inst;
    this.canvasEl = canvas;
    host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.program = linkProgram(gl, VS, FS);
    this.lineProgram = linkProgram(gl, LINE_VS, LINE_FS);
    for (const name of ['uViewProj', 'uSky', 'uGround', 'uLightDir1', 'uLightCol1', 'uLightDir2', 'uLightCol2']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    for (const name of ['uViewProj', 'uAlpha']) {
      this.lineUniforms[name] = gl.getUniformLocation(this.lineProgram, name);
    }

    const floor = floorLines(100);
    this.floorBufs = [this.makeProps(floor.verts)];
    this.floorCount = floor.count;
    const axes = axisLines(3);
    this.axisBufs = [this.makeProps(axes.verts)];
    this.axisCount = axes.count;

    this.camera.attach(canvas);
    this.resize();
  }

  private makeProps(verts: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return buf;
  }

  get canvas(): HTMLCanvasElement { return this.canvasEl; }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new WebGL1Layer(id, this.gl, this.inst);
      this.layers.set(id, l);
    }
    void accent;
    return l;
  }

  removeLayer(id: string) {
    this.layers.get(id)?.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined { return this.layers.get(id); }

  setVisibleLayer(_id: string | null): void { /* the pane picks its layer */ }

  resize() {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvasEl.width = Math.max(1, Math.round(w * dpr));
    this.canvasEl.height = Math.max(1, Math.round(h * dpr));
    this.canvasEl.style.width = w + 'px';
    this.canvasEl.style.height = h + 'px';
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3, radiusScale = 2.6) {
    this.camera.frame(contentRadius, groundSize, target, radiusScale);
    void extent;
  }

  updateCamera(): void { /* nothing damped */ }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const gl = this.gl;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.933, 0.945, 0.965, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const n = Math.max(1, slots.length);
    const panes: { id: string | null; rect: [number, number, number, number] }[] = [];
    if (n === 1) {
      panes.push({ id: slots[0]?.id ?? null, rect: [0, 0, w, h] });
    } else {
      const { cols, rows } = slotGrid(n);
      const cw = Math.floor(w / cols);
      const ch = Math.floor(h / rows);
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        panes.push({ id: slots[i].id, rect: [col * cw, h - (row + 1) * ch, cw, ch] });
      }
    }
    if (panes.length > 1) gl.enable(gl.SCISSOR_TEST);

    let drawCalls = 0, triangles = 0, instances = 0;
    for (const pane of panes) {
      const [x, y, pw, ph] = pane.rect;
      gl.viewport(x, y, pw, ph);
      if (panes.length > 1) gl.scissor(x, y, pw, ph);
      const vp = this.camera.viewProj(pw, ph);

      this.drawProps(vp, pw, ph);
      drawCalls += 2;

      if (pane.id) {
        const layer = this.layers.get(pane.id);
        if (layer) {
          gl.useProgram(this.program);
          gl.uniformMatrix4fv(this.uniforms.uViewProj, false, vp);
          gl.uniform3f(this.uniforms.uSky, 1, 1, 1);
          gl.uniform3f(this.uniforms.uGround, 0.7216, 0.7529, 0.8);
          gl.uniform3f(this.uniforms.uLightDir1, ...normalize([18, 30, 14]));
          gl.uniform3f(this.uniforms.uLightCol1, 1.5, 1.5, 1.5);
          gl.uniform3f(this.uniforms.uLightDir2, ...normalize([-16, 12, -20]));
          gl.uniform3f(this.uniforms.uLightCol2, 0.55 * 0.8745, 0.55 * 0.9098, 0.55);
          const r = layer.draw(this.program);
          drawCalls += r.calls;
          triangles += r.triangles;
          instances += r.instances;
        }
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    this.lastDrawCalls = drawCalls;
    this.lastTriangles = triangles;
    this.lastInstances = instances;
  }

  private drawProps(vp: Float32Array, pw: number, ph: number): void {
    const gl = this.gl;
    void pw; void ph;
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(this.lineUniforms.uViewProj, false, vp);
    const aPosition = this.lineLocPos ?? (this.lineLocPos = gl.getAttribLocation(this.lineProgram, 'aPosition'));
    const aColor = this.lineLocCol ?? (this.lineLocCol = gl.getAttribLocation(this.lineProgram, 'aColor'));
    gl.depthMask(false);
    for (const [buf, count, alpha] of [
      [this.floorBufs[0], this.floorCount, 0.55],
      [this.axisBufs[0], this.axisCount, 1],
    ] as [WebGLBuffer, number, number][]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 24, 12);
      gl.uniform1f(this.lineUniforms.uAlpha, alpha);
      gl.drawArrays(gl.LINES, 0, count);
    }
    gl.depthMask(true);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    let bufferBytes = 0;
    let instances = 0;
    for (const l of this.layers.values()) {
      bufferBytes += l.bufferBytes;
      instances += l.instanceCount;
    }
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      instances: this.lastInstances,
      geometries: this.layers.size,
      textures: 0,
      programs: 2,
      bufferBytes,
      notes: {
        programs: '固定两个程序（网格 / 线条），不随场景增长',
        bufferBytes: '顶点 + 索引 + 实例矩阵 + 实例颜色；WebGL1 没有 VAO，缓冲全部手工绑定',
        geometries: '按形状签名分桶；每桶每帧重新绑定一次全部属性指针',
      },
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: true, meshes: layer.probe() };
    }
    out.__camera = {
      ...this.camera.probe(),
      aspect: r3(this.canvasEl.width / Math.max(1, this.canvasEl.height)),
      rendererSize: [this.canvasEl.width, this.canvasEl.height],
      cssSize: [this.canvasEl.clientWidth, this.canvasEl.clientHeight],
    };
    out.__backend = {
      kind: 'webgl1',
      renderer: meta.name,
      hasVAO: false,
      instancing: 'ANGLE_instanced_arrays',
    };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const b of [...this.floorBufs, ...this.axisBufs]) gl.deleteBuffer(b);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.lineProgram);
    this.canvasEl.remove();
  }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function create(): IRenderEngine {
  return new WebGL1RenderEngine();
}
