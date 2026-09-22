import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { cachedGeometryData, instanceColors, signature, type GeometryData } from '../geometry';
import { slotGrid } from '../layout';
import {
  OrbitCamera, axisLines, edgeIndices, floorLines, glContextAttributes, linkProgram, renderable, r2, r3,
  writeInstanceMatrix,
} from '../glCommon';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'wireframe',
  name: '线框（WebGL2）',
  language: 'GLSL',
  backend: 'WebGL2',
  license: 'MIT',
  homepage: 'https://registry.khronos.org/webgl/',
  accent: '#5ec07f',
  blurb:
    '同一批三角形，只提交去重后的边。顶点吞吐量翻三倍、像素填充量降到几乎为零——和实体后端对照，就能看出一个场景到底卡在顶点还是卡在填充。',
  features: { instancing: true, lighting: false, antialias: true, scissorPanes: true, depthBuffer: true },
  status: 'stable',
  costKb: 0,
};

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=2) in vec4 aInst0;
layout(location=3) in vec4 aInst1;
layout(location=4) in vec4 aInst2;
layout(location=5) in vec4 aInst3;
layout(location=6) in vec3 aInstColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  mat4 m = mat4(aInst0, aInst1, aInst2, aInst3);
  vColor = aInstColor;
  gl_Position = uViewProj * m * vec4(aPosition, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  // Lifted a little: raw instance colour on a 1px line reads as too dark.
  fragColor = vec4(mix(vColor, vec3(1.0), 0.18), 1.0);
}`;

interface WireBucket {
  key: string;
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  edgeCount: number;
  indexType: number;
  count: number;
  indices: number[];
  matrices: Float32Array;
}

export class WireframeLayer implements IRenderLayer {
  private gl: WebGL2RenderingContext;
  private buckets: WireBucket[] = [];
  private disposed = false;

  constructor(readonly id: string, gl: WebGL2RenderingContext) {
    this.gl = gl;
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
      // Deduplicated edges: a sphere's triangles share most of their edges, so
      // submitting every triangle's three edges would roughly double the work.
      const edges = edgeIndices(data.indices);
      const buffers: WebGLBuffer[] = [];

      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);

      const posBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      buffers.push(posBuf);

      const matBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, matBuf);
      gl.bufferData(gl.ARRAY_BUFFER, n * 64, gl.DYNAMIC_DRAW);
      for (let k = 0; k < 4; k++) {
        gl.enableVertexAttribArray(2 + k);
        gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, 64, k * 16);
        gl.vertexAttribDivisor(2 + k, 1);
      }
      buffers.push(matBuf);

      const colBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceColors(bodies, bucket.indices), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(6);
      gl.vertexAttribPointer(6, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(6, 1);
      buffers.push(colBuf);

      const idxBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      const wide = data.positions.length / 3 > 65535;
      const indexType = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wide ? edges : new Uint16Array(edges), gl.STATIC_DRAW);
      buffers.push(idxBuf);

      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      this.buckets.push({
        key,
        vao,
        buffers,
        edgeCount: edges.length,
        indexType,
        count: n,
        indices: bucket.indices,
        matrices: new Float32Array(n * 16),
      });
    }
  }

  sync(states: BodyState[]) {
    for (const b of this.buckets) {
      const m = b.matrices;
      for (let k = 0; k < b.count; k++) {
        const o = k * 16;
        const s = states[b.indices[k]];
        if (!renderable(s)) {
          m.fill(0, o, o + 16);
          continue;
        }
        writeInstanceMatrix(m, o, s!);
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffers[1]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m);
    }
  }

  get drawables(): WireBucket[] {
    return this.buckets;
  }

  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }

  /** Line segments submitted, i.e. what this backend actually asks the GPU for. */
  get segmentCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.edgeCount / 2 * b.count;
    return Math.round(n);
  }

  get bufferBytes(): number {
    let bytes = 0;
    for (const b of this.buckets) {
      bytes += b.edgeCount * 4 + b.count * 64 + b.count * 12;
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
        geometry: 'gl.LINES',
        params: { signature: b.key, edges: b.edgeCount / 2 },
        samples,
      });
    }
    return meshes;
  }

  clear() {
    if (this.disposed) return;
    const gl = this.gl;
    for (const b of this.buckets) {
      gl.deleteVertexArray(b.vao);
      for (const buf of b.buffers) gl.deleteBuffer(buf);
    }
    this.buckets = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }
}

export class WireframeRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private gl!: WebGL2RenderingContext;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private program!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private lineProgram!: WebGLProgram;
  private lineUniforms: Record<string, WebGLUniformLocation | null> = {};
  private floorVao!: WebGLVertexArrayObject;
  private floorCount = 0;
  private axisVao!: WebGLVertexArrayObject;
  private axisCount = 0;
  private props: WebGLBuffer[] = [];
  private layers = new Map<string, WireframeLayer>();
  readonly camera = new OrbitCamera();
  private disposed = false;
  private lastDrawCalls = 0;
  private lastSegments = 0;
  private lastInstances = 0;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.canvasHost = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    const gl = canvas.getContext('webgl2', glContextAttributes());
    if (!gl) throw new Error('线框后端需要 WebGL2。');
    this.gl = gl;
    this.canvasEl = canvas;
    host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.program = linkProgram(gl, VS, FS);
    this.uniforms.uViewProj = gl.getUniformLocation(this.program, 'uViewProj');
    this.lineProgram = linkProgram(gl, VS, FS);
    this.lineUniforms.uViewProj = gl.getUniformLocation(this.lineProgram, 'uViewProj');

    // The floor and axes share the instanced program, so attribute slots 2..5
    // must read as an identity matrix for them. Attribute *constant* values are
    // global GL state rather than VAO state, so setting them once is enough and
    // the body VAOs - which enable the real instanced arrays - simply override
    // them. Without this the props would be multiplied by a zero matrix and
    // collapse to the origin.
    gl.vertexAttrib4f(2, 1, 0, 0, 0);
    gl.vertexAttrib4f(3, 0, 1, 0, 0);
    gl.vertexAttrib4f(4, 0, 0, 1, 0);
    gl.vertexAttrib4f(5, 0, 0, 0, 1);

    const floor = floorLines(100);
    this.floorVao = this.makeProps(floor.verts);
    this.floorCount = floor.count;
    const axes = axisLines(3);
    this.axisVao = this.makeProps(axes.verts);
    this.axisCount = axes.count;

    this.camera.attach(canvas);
    this.resize();
  }

  /**
   * Props use the same attribute layout as the body meshes (position in slot 0),
   * but with a default instanced colour, so the same program draws them.
   */
  private makeProps(verts: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    // Per-vertex colour into the instanced colour slot, with a divisor of 0 so
    // it advances per vertex instead of per instance.
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(6, 0);
    this.props.push(buf);
    return vao;
  }

  get canvas(): HTMLCanvasElement { return this.canvasEl; }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new WireframeLayer(id, this.gl);
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

    let drawCalls = 0, segments = 0, instances = 0;
    for (const pane of panes) {
      const [x, y, pw, ph] = pane.rect;
      gl.viewport(x, y, pw, ph);
      if (panes.length > 1) gl.scissor(x, y, pw, ph);
      const vp = this.camera.viewProj(pw, ph);

      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(this.lineUniforms.uViewProj, false, vp);
      gl.depthMask(false);
      gl.bindVertexArray(this.floorVao);
      gl.drawArrays(gl.LINES, 0, this.floorCount);
      gl.bindVertexArray(this.axisVao);
      gl.drawArrays(gl.LINES, 0, this.axisCount);
      gl.depthMask(true);
      drawCalls += 2;

      if (pane.id) {
        const layer = this.layers.get(pane.id);
        if (layer) {
          gl.useProgram(this.program);
          gl.uniformMatrix4fv(this.uniforms.uViewProj, false, vp);
          for (const b of layer.drawables) {
            gl.bindVertexArray(b.vao);
            gl.drawElementsInstanced(gl.LINES, b.edgeCount, b.indexType, 0, b.count);
            drawCalls++;
            segments += (b.edgeCount / 2) * b.count;
            instances += b.count;
          }
        }
      }
      gl.bindVertexArray(null);
    }
    gl.disable(gl.SCISSOR_TEST);
    this.lastDrawCalls = drawCalls;
    this.lastSegments = segments;
    this.lastInstances = instances;
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    let bufferBytes = 0;
    let geometries = 0;
    for (const l of this.layers.values()) {
      bufferBytes += l.bufferBytes;
      geometries += l.drawables.length;
    }
    return {
      drawCalls: this.lastDrawCalls,
      // No triangles at all - the column must say so instead of showing 0,
      // which would read as "this backend drew nothing".
      triangles: 0,
      instances: this.lastInstances,
      geometries,
      textures: 0,
      programs: 2,
      bufferBytes,
      notes: {
        triangles: `线框后端不提交三角形，每帧提交约 ${Math.round(this.lastSegments).toLocaleString('zh-CN')} 条线段`,
        geometries: '按形状签名分桶；每桶一条去重后的边索引缓冲',
        drawCalls: '网格 + 坐标轴 + 每个形状桶一次 drawElementsInstanced',
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
    out.__backend = { kind: 'webgl2', renderer: meta.name, mode: 'wireframe' };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const b of this.props) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.floorVao);
    gl.deleteVertexArray(this.axisVao);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.lineProgram);
    this.canvasEl.remove();
  }
}

export function create(): IRenderEngine {
  return new WireframeRenderEngine();
}
