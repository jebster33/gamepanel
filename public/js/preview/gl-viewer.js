// A tiny dependency-free WebGL2 model viewer: orbit camera, headlight shading, wireframe overlay,
// UV checker and per-mesh textures. Browser only (call createViewer from the page, not at import time).

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUv; in vec3 aCol;
uniform mat4 uMVP; uniform mat4 uView;
out vec3 vNrm; out vec2 vUv; out vec3 vCol;
void main() {
  vNrm = mat3(uView) * aNrm; vUv = aUv; vCol = aCol;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNrm; in vec2 vUv; in vec3 vCol;
uniform sampler2D uTex; uniform vec4 uColor;
uniform int uMode; uniform bool uHasTex; uniform bool uTopDown; uniform bool uUseVertexColor; uniform vec3 uLineColor;
out vec4 outColor;
void main() {
  if (uMode == 3) { outColor = vec4(uLineColor, 1.0); return; }
  vec2 uv = vec2(vUv.x, uTopDown ? vUv.y : 1.0 - vUv.y);
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  float light = 0.28 + 0.72 * max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  vec4 base = uColor;
  if (uUseVertexColor) base.rgb *= vCol;
  if (uMode == 1) {
    vec2 g = floor(vUv * 8.0);
    float c = mod(g.x + g.y, 2.0);
    vec3 tint = vec3(fract(vUv.x), fract(vUv.y), 0.5);
    base = vec4(mix(vec3(0.18), vec3(0.92), c) * 0.7 + tint * 0.3, 1.0);
  } else if (uHasTex) {
    vec4 t = texture(uTex, uv);
    if (t.a < 0.05) discard;
    base = vec4(t.rgb * (uUseVertexColor ? vCol : vec3(1.0)), t.a);
  }
  outColor = vec4(base.rgb * light, base.a);
}`;

const m4 = {
  perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  },
  // Column-major (GL) helpers.
  mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  },
  lookAt(eye, at, up) {
    const z = norm(sub(eye, at));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  },
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function glSupported() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

export function createViewer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
  if (!gl) throw new Error('WebGL 2 is not available in this browser');
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.bindAttribLocation(prog, 1, 'aNrm');
  gl.bindAttribLocation(prog, 2, 'aUv');
  gl.bindAttribLocation(prog, 3, 'aCol');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = Object.fromEntries(['uMVP', 'uView', 'uTex', 'uColor', 'uMode', 'uHasTex', 'uTopDown', 'uUseVertexColor', 'uLineColor'].map((n) => [n, gl.getUniformLocation(prog, n)]));

  const opts = { wireframe: false, uvChecker: false, textures: true };
  let items = []; // GPU meshes
  let center = [0, 0, 0];
  let radius = 1;
  const cam = { yaw: 0.6, pitch: 0.35, dist: 3, target: [0, 0, 0] };
  let raf = 0;
  let destroyed = false;

  const makeBuffer = (target, data) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };

  function upload(mesh) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bufs = [];
    const attr = (loc, data, size, fallback) => {
      if (data) {
        bufs.push(makeBuffer(gl.ARRAY_BUFFER, data));
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(loc);
        gl.vertexAttrib4f(loc, ...fallback);
      }
    };
    attr(0, mesh.positions, 3);
    attr(1, mesh.normals, 3, [0, 0, 1, 0]);
    attr(2, mesh.uvs, 2, [0, 0, 0, 0]);
    attr(3, mesh.colors, 3, [1, 1, 1, 1]);
    const ibo = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    // Wireframe uses its own line index list; the triangle one stays bound in the VAO.
    const lines = new Uint32Array(mesh.indices.length * 2);
    for (let i = 0, o = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = mesh.indices[i];
      const b = mesh.indices[i + 1];
      const c = mesh.indices[i + 2];
      lines.set([a, b, b, c, c, a], o);
      o += 6;
    }
    const lvao = gl.createVertexArray();
    gl.bindVertexArray(lvao);
    for (let loc = 0; loc < 4; loc++) {
      // Re-point the same attribute buffers for the wireframe VAO.
      const data = [mesh.positions, mesh.normals, mesh.uvs, mesh.colors][loc];
      if (data) {
        const b = bufs.shift();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, [3, 3, 2, 3][loc], gl.FLOAT, false, 0, 0);
        bufs.push(b);
      } else {
        gl.disableVertexAttribArray(loc);
        gl.vertexAttrib4f(loc, ...[[0, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 0], [1, 1, 1, 1]][loc]);
      }
    }
    const lbo = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, lines);
    gl.bindVertexArray(null);
    return { mesh, vao, lvao, count: mesh.indices.length, lcount: lines.length, tex: null, bufs: [...bufs, ibo, lbo] };
  }

  function makeTexture(img) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.rgba instanceof Uint8Array ? img.rgba : new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  function freeItems() {
    for (const it of items) {
      gl.deleteVertexArray(it.vao);
      gl.deleteVertexArray(it.lvao);
      for (const b of it.bufs) gl.deleteBuffer(b);
      if (it.tex) gl.deleteTexture(it.tex);
    }
    items = [];
  }

  function fit() {
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const it of items) {
      const p = it.mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (p[i + k] < min[k]) min[k] = p[i + k];
          if (p[i + k] > max[k]) max[k] = p[i + k];
        }
      }
    }
    if (!isFinite(min[0])) {
      min = [-1, -1, -1];
      max = [1, 1, 1];
    }
    center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-6);
  }

  function reset() {
    cam.yaw = 0.6;
    cam.pitch = 0.35;
    cam.dist = radius * 2.6;
    cam.target = [...center];
    draw();
  }

  function draw() {
    if (destroyed) return;
    const w = canvas.clientWidth * (window.devicePixelRatio || 1);
    const h = canvas.clientHeight * (window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w) || canvas.height !== Math.round(h)) {
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.06, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const eye = [cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
    const view = m4.lookAt(eye, cam.target, [0, 1, 0]);
    const proj = m4.perspective(0.8, canvas.width / canvas.height, radius * 0.01, radius * 200);
    gl.uniformMatrix4fv(U.uView, false, view);
    gl.uniformMatrix4fv(U.uMVP, false, m4.mul(proj, view));
    gl.uniform1i(U.uTex, 0);
    for (const it of items) {
      const { mesh } = it;
      const hasTex = !!it.tex && opts.textures && !opts.uvChecker;
      gl.uniform1i(U.uMode, opts.uvChecker ? 1 : 0);
      gl.uniform1i(U.uHasTex, hasTex ? 1 : 0);
      gl.uniform1i(U.uTopDown, mesh.uvTopDown ? 1 : 0);
      gl.uniform1i(U.uUseVertexColor, mesh.colors ? 1 : 0);
      gl.uniform4fv(U.uColor, mesh.material.color.length === 4 ? mesh.material.color : [...mesh.material.color, 1]);
      if (it.tex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, it.tex);
      }
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.bindVertexArray(it.vao);
      gl.drawElements(gl.TRIANGLES, it.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if (opts.wireframe) {
        gl.uniform1i(U.uMode, 3);
        gl.uniform3f(U.uLineColor, 0.78, 1, 0.2);
        gl.bindVertexArray(it.lvao);
        gl.drawElements(gl.LINES, it.lcount, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
  }
  const schedule = () => {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  };

  // Mouse: drag rotates, shift/right-drag pans, wheel zooms.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) {
      const s = cam.dist * 0.0016;
      const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
      for (let k = 0; k < 3; k++) cam.target[k] -= right[k] * dx * s;
      cam.target[1] += dy * s;
    } else {
      cam.yaw -= dx * 0.01;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.01));
    }
    schedule();
  });
  const end = () => {
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cam.dist = Math.max(radius * 0.05, Math.min(radius * 50, cam.dist * Math.exp(e.deltaY * 0.001)));
      schedule();
    },
    { passive: false }
  );
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  ro?.observe(canvas);

  return {
    setModel(model) {
      freeItems();
      items = model.meshes.map(upload);
      fit();
      reset();
    },
    /** Give one mesh (by index) a texture: { width, height, rgba } or null to clear. */
    setTexture(index, img) {
      const it = items[index];
      if (!it) return;
      if (it.tex) gl.deleteTexture(it.tex);
      it.tex = img ? makeTexture(img) : null;
      schedule();
    },
    setOptions(next) {
      Object.assign(opts, next);
      schedule();
    },
    reset,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      freeItems();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
