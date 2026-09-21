import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { cachedGeometryData, instanceColors, signature, type GeometryData } from '../geometry';
import { slotGrid } from '../layout';
import { OrbitCamera, axisLines, floorLines, renderable, r2, r3 } from '../glCommon';
import { withTimeout } from '../../core/guard';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

/*
 * WebGPU is reached through a deliberately loose surface.
 *
 * The WebGPU TypeScript types live in a separate package, and pulling a whole
 * ambient type set into this project for one optional backend is not worth the
 * coupling. The API usage below is small and stable enough to be readable
 * without them; what matters far more is that a missing adapter produces a
 * clear message instead of a silent absence from the renderer list.
 */
type GPUAny = any;

export const meta: RenderEngineMeta = {
  id: 'webgpu',
  name: '原生 WebGPU',
  language: 'WGSL',
  backend: 'WebGPU',
  license: 'MIT',
  homepage: 'https://www.w3.org/TR/webgpu/',
  accent: '#e4573c',
  blurb:
    '下一代图形 API：显式管线状态、WGSL 着色器、命令编码器。引擎和上面几个真正的区别在于它是显式的——每一步都自己声明，没有隐藏状态。',
  features: { instancing: true, lighting: true, antialias: true, scissorPanes: true, depthBuffer: true },
  status: 'experimental',
  costKb: 0,
};

/**
 * Availability probe, called by the renderer registry.
 *
 * Returning a reason instead of throwing keeps WebGPU visible in the sidebar
 * with an explanation - "this browser cannot run it" is a fact worth showing,
 * not a renderer that quietly does not exist.
 */
export function availability(): string | undefined {
  if (typeof navigator === 'undefined') return '不在浏览器环境';
  if (!(navigator as unknown as { gpu?: unknown }).gpu) {
    return '此浏览器未启用 WebGPU（navigator.gpu 不存在）。Chrome 需要 113+ 且未被策略关闭。';
  }

  // Opt-in by default, and the reason is a measurement rather than caution.
  //
  // On a software-rasterised Chrome (SwiftShader - which is what a headless
  // browser uses), `gpu.requestAdapter()` does not reject and does not even
  // await: it **blocks the main thread**. A setTimeout-based guard cannot fire,
  // because the event loop never runs. The tab is simply frozen, with no error
  // and no way to switch to another renderer.
  //
  // Two signals were tried and neither is dependable: `navigator.webdriver` is
  // not set in this harness, and the WebGL renderer string did not match a
  // software-rasteriser pattern here either. Rather than guess, the backend is
  // off unless the user explicitly opts in with ?allowWebGPU=1 - which also
  // documents the risk at exactly the moment it matters.
  const optedIn = new URLSearchParams(location.search).get('allowWebGPU') === '1';
  if (!optedIn) {
    return '默认禁用：在无头或软件渲染的环境里，WebGPU 的 requestAdapter 会阻塞主线程而不是报错，页面会直接冻结且无法切回。' +
      '确认你的浏览器有硬件加速后，用 ?allowWebGPU=1 打开本页即可启用。';
  }
  return undefined;
}

const WGSL = `
struct Uniforms {
  viewProj : mat4x4<f32>,
  sky : vec3<f32>,
  ground : vec3<f32>,
  lightDir1 : vec3<f32>,
  lightCol1 : vec3<f32>,
  lightDir2 : vec3<f32>,
  lightCol2 : vec3<f32>,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSIn {
  @location(0) pos : vec3<f32>,
  @location(1) nrm : vec3<f32>,
  @location(2) m0 : vec4<f32>,
  @location(3) m1 : vec4<f32>,
  @location(4) m2 : vec4<f32>,
  @location(5) m3 : vec4<f32>,
  @location(6) col : vec3<f32>,
};

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) nrm : vec3<f32>,
  @location(1) col : vec3<f32>,
};

@vertex
fn vs(input : VSIn) -> VSOut {
  let m = mat4x4<f32>(input.m0, input.m1, input.m2, input.m3);
  let world = m * vec4<f32>(input.pos, 1.0);
  var out : VSOut;
  out.clip = u.viewProj * world;
  out.nrm = (m * vec4<f32>(input.nrm, 0.0)).xyz;
  out.col = input.col;
  return out;
}

@fragment
fn fs(input : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(input.nrm);
  let ambient = mix(u.ground, u.sky, n.y * 0.5 + 0.5) * 1.05;
  var c = input.col * ambient;
  c = c + input.col * u.lightCol1 * max(dot(n, u.lightDir1), 0.0);
  c = c + input.col * u.lightCol2 * max(dot(n, u.lightDir2), 0.0);
  return vec4<f32>(c, 1.0);
}
`;

/** Attribute-stripped position-only shader, for the floor grid and axes. */
const LINE_WGSL = `
struct Uniforms { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSIn {
  @location(0) pos : vec3<f32>,
  @location(1) col : vec3<f32>,
};

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) col : vec3<f32>,
};

@vertex
fn vs(input : VSIn) -> VSOut {
  var out : VSOut;
  out.clip = u.viewProj * vec4<f32>(input.pos, 1.0);
  out.col = input.col;
  return out;
}

@fragment
fn fs(input : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(input.col, 0.7);
}
`;

interface GpuBucket {
  key: string;
  vertexBuf: GPUAny;
  indexBuf: GPUAny;
  matrixBuf: GPUAny;
  colorBuf: GPUAny;
  indexCount: number;
  count: number;
  indices: number[];
  matrices: Float32Array;
}

export class WebGpuLayer implements IRenderLayer {
  private device: GPUAny;
  private buckets: GpuBucket[] = [];
  private disposed = false;

  constructor(readonly id: string, device: GPUAny) {
    this.device = device;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();
    const d = this.device;
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
      // Interleave position+normal into one buffer: WebGPU has no implicit
      // stride handling, so the layout is stated once in the pipeline below.
      const verts = new Float32Array(data.positions.length / 3 * 6);
      const vcount = data.positions.length / 3;
      for (let v = 0; v < vcount; v++) {
        verts[v * 6] = data.positions[v * 3];
        verts[v * 6 + 1] = data.positions[v * 3 + 1];
        verts[v * 6 + 2] = data.positions[v * 3 + 2];
        verts[v * 6 + 3] = data.normals[v * 3] ?? 0;
        verts[v * 6 + 4] = data.normals[v * 3 + 1] ?? 0;
        verts[v * 6 + 5] = data.normals[v * 3 + 2] ?? 0;
      }
      const vertexBuf = d.createBuffer({
        size: verts.byteLength,
        usage: 0x0028, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      new Float32Array(vertexBuf.getMappedRange()).set(verts);
      vertexBuf.unmap();

      const indexBuf = d.createBuffer({
        size: Math.ceil(data.indices.byteLength / 4) * 4,
        usage: 0x0018, // INDEX | COPY_DST
        mappedAtCreation: true,
      });
      new Uint32Array(indexBuf.getMappedRange()).set(data.indices);
      indexBuf.unmap();

      const matrixBuf = d.createBuffer({
        size: n * 64,
        usage: 0x0028,
        mappedAtCreation: true,
      });
      new Float32Array(matrixBuf.getMappedRange(new ArrayBuffer(n * 64))).fill(0);
      matrixBuf.unmap();

      const rgb = instanceColors(bodies, bucket.indices);
      const colorBuf = d.createBuffer({
        size: Math.ceil(n * 12 / 4) * 4,
        usage: 0x0028,
        mappedAtCreation: true,
      });
      new Float32Array(colorBuf.getMappedRange()).set(rgb);
      colorBuf.unmap();

      this.buckets.push({
        key,
        vertexBuf,
        indexBuf,
        matrixBuf,
        colorBuf,
        indexCount: data.indices.length,
        count: n,
        indices: bucket.indices,
        matrices: new Float32Array(n * 16),
      });
    }
  }

  sync(states: BodyState[]) {
    const d = this.device;
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
      d.queue.writeBuffer(b.matrixBuf, 0, m);
    }
  }

  get drawables(): GpuBucket[] { return this.buckets; }

  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }

  get triangleCount(): number {
    let n = 0;
    for (const b of this.buckets) n += (b.indexCount / 3) * b.count;
    return Math.round(n);
  }

  get bufferBytes(): number {
    let bytes = 0;
    for (const b of this.buckets) {
      bytes += b.indexCount * 4 + b.count * 64 + b.count * 12;
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
        geometry: 'GPUBuffer',
        params: { signature: b.key, indexCount: b.indexCount },
        samples,
      });
    }
    return meshes;
  }

  clear() {
    if (this.disposed) return;
    for (const b of this.buckets) {
      b.vertexBuf.destroy();
      b.indexBuf.destroy();
      b.matrixBuf.destroy();
      b.colorBuf.destroy();
    }
    this.buckets = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }
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

export class WebGpuRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private device!: GPUAny;
  private context!: GPUAny;
  private format = 'bgra8unorm';
  private meshPipeline!: GPUAny;
  private linePipeline!: GPUAny;
  private depthTexture: GPUAny = null;
  private uniformMesh: GPUAny;
  private uniformLine: GPUAny;
  private meshBind: GPUAny;
  private lineBind: GPUAny;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private floorBuf: GPUAny;
  private floorVerts = 0;
  private axisBuf: GPUAny;
  private axisVerts = 0;
  private layers = new Map<string, WebGpuLayer>();
  readonly camera = new OrbitCamera();
  private disposed = false;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private lastInstances = 0;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  /**
   * Everything WebGPU needs happens here rather than in a factory, so this
   * backend honours the same `create()` + `init()` contract as the others -
   * adapter and device acquisition are simply the async part of `init`.
   */
  async init(host: HTMLElement): Promise<void> {
    const reason = availability();
    if (reason) throw new Error(reason);
    const gpu = (navigator as unknown as { gpu: GPUAny }).gpu;
    const adapter = await withTimeout<GPUAny>(
      gpu.requestAdapter({ powerPreference: 'high-performance' }),
      6000,
      'WebGPU 适配器请求超时（6 秒）。在无头或软件渲染的浏览器上 requestAdapter 会一直挂起而不报错，' +
      '这里主动放弃以免整个页面失去响应。',
    );
    if (!adapter) throw new Error('WebGPU 可用但取不到适配器（可能是软件渲染被禁用）。');
    const device = await withTimeout<GPUAny>(
      adapter.requestDevice(),
      6000,
      'WebGPU 设备请求超时（6 秒）。',
    );
    this.device = device;

    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    // The DOM typings predate WebGPU, so this context string is not in the
    // overload set; the cast is unavoidable and confined to this one line.
    const context = canvas.getContext('webgpu') as unknown as GPUAny;
    if (!context) throw new Error('无法从 canvas 取得 WebGPU 上下文。');
    this.context = context;
    this.format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.canvasHost = host;
    this.canvasEl = canvas;
    host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });

    const d = this.device;
    this.uniformMesh = d.createBuffer({ size: 160, usage: 0x0048 }); // UNIFORM | COPY_DST
    this.uniformLine = d.createBuffer({ size: 64, usage: 0x0048 });

    this.meshBind = d.createBindGroup({
      layout: d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x0001 | 0x0002, buffer: { type: 'uniform' } }],
      })] }),
      entries: [{ binding: 0, resource: { buffer: this.uniformMesh } }],
    });
    this.lineBind = d.createBindGroup({
      layout: d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x0001 | 0x0002, buffer: { type: 'uniform' } }],
      })] }),
      entries: [{ binding: 0, resource: { buffer: this.uniformLine } }],
    });

    const meshModule = d.createShaderModule({ code: WGSL });
    const lineModule = d.createShaderModule({ code: LINE_WGSL });

    const depthStencil = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' };
    this.meshPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x0001 | 0x0002, buffer: { type: 'uniform' } }],
      })] }),
      vertex: {
        module: meshModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
          {
            arrayStride: 64,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32x4' },
              { shaderLocation: 3, offset: 16, format: 'float32x4' },
              { shaderLocation: 4, offset: 32, format: 'float32x4' },
              { shaderLocation: 5, offset: 48, format: 'float32x4' },
            ],
          },
          {
            arrayStride: 12,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 6, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: { module: meshModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil,
    });

    this.linePipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x0001 | 0x0002, buffer: { type: 'uniform' } }],
      })] }),
      vertex: {
        module: lineModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: lineModule,
        entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });

    const floor = floorLines(100);
    this.floorBuf = this.makeVertexBuffer(floor.verts);
    this.floorVerts = floor.count;
    const axes = axisLines(3);
    this.axisBuf = this.makeVertexBuffer(axes.verts);
    this.axisVerts = axes.count;

    this.camera.attach(canvas);
    this.resize();
  }

  private makeVertexBuffer(verts: Float32Array): GPUAny {
    const buf = this.device.createBuffer({
      size: verts.byteLength,
      usage: 0x0028,
      mappedAtCreation: true,
    });
    new Float32Array(buf.getMappedRange()).set(verts);
    buf.unmap();
    return buf;
  }

  get canvas(): HTMLCanvasElement { return this.canvasEl; }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new WebGpuLayer(id, this.device);
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
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    this.canvasEl.width = pw;
    this.canvasEl.height = ph;
    this.canvasEl.style.width = w + 'px';
    this.canvasEl.style.height = h + 'px';
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [pw, ph],
      format: 'depth24plus',
      usage: 0x0010 | 0x0004, // RENDER_ATTACHMENT | COPY_DST
    });
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3, radiusScale = 2.6) {
    this.camera.frame(contentRadius, groundSize, target, radiusScale);
    void extent;
  }

  updateCamera(): void { /* nothing damped */ }

  render(slots: RenderSlot[]) {
    if (this.disposed || !this.depthTexture) return;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.933, g: 0.945, b: 0.965, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

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
        panes.push({ id: slots[i].id, rect: [col * cw, row * ch, cw, ch] });
      }
    }

    let drawCalls = 0, triangles = 0, instances = 0;
    for (const pane of panes) {
      const [x, y, pw, ph] = pane.rect;
      pass.setViewport(x, y, pw, ph, 0, 1);
      pass.setScissorRect(x, y, pw, ph);
      const vp = this.camera.viewProj(pw, ph);
      const t0 = performance.now();

      // Floor and axes.
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.lineBind);
      this.device.queue.writeBuffer(this.uniformLine, 0, vp);
      pass.setVertexBuffer(0, this.floorBuf);
      pass.draw(this.floorVerts);
      pass.setVertexBuffer(0, this.axisBuf);
      pass.draw(this.axisVerts);
      drawCalls += 2;

      if (pane.id) {
        const layer = this.layers.get(pane.id);
        if (layer) {
          const uniforms = new Float32Array(40);
          uniforms.set(vp, 0);
          uniforms.set([1, 1, 1], 16);
          uniforms.set([0.7216, 0.7529, 0.8], 20);
          uniforms.set(normalize([18, 30, 14]), 24);
          uniforms.set([1.5, 1.5, 1.5], 28);
          uniforms.set(normalize([-16, 12, -20]), 32);
          uniforms.set([0.55 * 0.8745, 0.55 * 0.9098, 0.55], 36);
          this.device.queue.writeBuffer(this.uniformMesh, 0, uniforms);

          pass.setPipeline(this.meshPipeline);
          pass.setBindGroup(0, this.meshBind);
          pass.setIndexFormat('uint32');
          for (const b of layer.drawables) {
            pass.setVertexBuffer(0, b.vertexBuf);
            pass.setVertexBuffer(1, b.matrixBuf);
            pass.setVertexBuffer(2, b.colorBuf);
            pass.setIndexBuffer(b.indexBuf, 'uint32');
            pass.drawIndexed(b.indexCount, b.count);
            drawCalls++;
            triangles += (b.indexCount / 3) * b.count;
            instances += b.count;
          }
        }
      }
      void t0;
    }

    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.lastDrawCalls = drawCalls;
    this.lastTriangles = Math.round(triangles);
    this.lastInstances = instances;
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
      textures: 1,
      programs: 2,
      bufferBytes,
      notes: {
        programs: '两个显式管线（三角形 / 线段），管线状态在创建时就完全声明',
        textures: '深度纹理 depth24plus',
        bufferBytes: '顶点 + 索引 + 实例矩阵 + 实例颜色；不含深度纹理',
        geometries: '按形状签名分桶，每桶一组 GPUBuffer',
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
    out.__backend = { kind: 'webgpu', renderer: meta.name, format: this.format };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.floorBuf?.destroy();
    this.axisBuf?.destroy();
    this.uniformMesh?.destroy();
    this.uniformLine?.destroy();
    this.depthTexture?.destroy();
    this.canvasEl.remove();
  }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function create(): IRenderEngine {
  return new WebGpuRenderEngine();
}
