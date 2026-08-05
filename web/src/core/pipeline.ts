import * as THREE from 'three';

export type Pt = [number, number];

export interface MaskResult {
  mask: Uint8Array;
  width: number;
  height: number;
  avgColor: [number, number, number];
  roughness: number;
}

function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Build a binary object mask from RGBA pixels.
 * - transparent pixels -> background
 * - pixels close to the (corner-estimated) background color -> background
 * - a flood fill from the 4 corners removes soft shadows / halos.
 */
export function makeMask(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  opts?: { threshold?: number }
): MaskResult {
  const threshold = opts?.threshold ?? 55;
  const N = width * height;
  const d = data as number[];

  // estimate background from 5x5 corner patches
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  let br = 0, bg = 0, bb = 0, cnt = 0;
  for (const [cx, cy] of corners) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        br += d[i]; bg += d[i + 1]; bb += d[i + 2]; cnt++;
      }
    }
  }
  br /= cnt; bg /= cnt; bb /= cnt;

  const isBg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const a = d[i * 4 + 3];
    if (a < 128) { isBg[i] = 1; continue; }
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    if (colorDist(r, g, b, br, bg, bb) < threshold) isBg[i] = 1;
  }

  // flood fill bg from corners over the bg set
  const stack: number[] = [];
  const mark = (x: number, y: number) => {
    const i = y * width + x;
    if (!isBg[i]) { isBg[i] = 1; stack.push(i); }
  };
  for (const [cx, cy] of corners) {
    if (cx >= 0 && cy >= 0 && cx < width && cy < height) mark(cx, cy);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width, y = (i / width) | 0;
    if (x > 0) mark(x - 1, y);
    if (x < width - 1) mark(x + 1, y);
    if (y > 0) mark(x, y - 1);
    if (y < height - 1) mark(x, y + 1);
  }

  const mask = new Uint8Array(N);
  let sr = 0, sg = 0, sb = 0, obj = 0;
  for (let i = 0; i < N; i++) {
    if (!isBg[i]) {
      mask[i] = 1;
      sr += d[i * 4]; sg += d[i * 4 + 1]; sb += d[i * 4 + 2]; obj++;
    }
  }

  let avgColor: [number, number, number] = [128, 128, 128];
  let roughness = 0.6;
  if (obj > 0) {
    avgColor = [Math.round(sr / obj), Math.round(sg / obj), Math.round(sb / obj)];
    let v = 0;
    for (let i = 0; i < N; i++) {
      if (!isBg[i]) {
        const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        v += (l - 128) * (l - 128);
      }
    }
    v /= obj;
    roughness = Math.min(0.95, Math.max(0.3, 0.35 + v / 18000));
  }

  return { mask, width, height, avgColor, roughness };
}

/**
 * Marching-squares contour of the object mask -> ordered closed loop (pixel coords).
 */
export function marchingSquares(mask: Uint8Array, w: number, h: number): Pt[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const interp = (va: number, vb: number) => {
    const den = vb - va;
    return Math.abs(den) < 1e-6 ? 0.5 : (0.5 - va) / den;
  };
  type Edge = 'T' | 'R' | 'B' | 'L';
  const CASES: Record<number, [Edge, Edge][]> = {
    1: [['B', 'L']], 2: [['R', 'B']], 3: [['R', 'L']], 4: [['T', 'R']],
    5: [['T', 'L'], ['B', 'R']], 6: [['T', 'B']], 7: [['T', 'L']], 8: [['T', 'L']],
    9: [['T', 'B']], 10: [['T', 'R'], ['B', 'L']], 11: [['R', 'B']], 12: [['R', 'L']],
    13: [['B', 'L']], 14: [['L', 'B']],
  };

  const segs: [number, number, number, number][] = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      const pair = CASES[c];
      if (!pair) continue;
      const pt = (e: Edge): [number, number] => {
        switch (e) {
          case 'T': return [x + interp(tl, tr), y];
          case 'R': return [x + 1, y + interp(tr, br)];
          case 'B': return [x + interp(bl, br), y + 1];
          case 'L': return [x, y + interp(tl, bl)];
        }
      };
      for (const [a, b] of pair) {
        const pa = pt(a), pb = pt(b);
        segs.push([pa[0], pa[1], pb[0], pb[1]]);
      }
    }
  }
  return chainSegments(segs);
}

function chainSegments(segs: [number, number, number, number][]): Pt[] {
  if (!segs.length) return [];
  const key = (p: Pt) => `${Math.round(p[0] * 1000)}_${Math.round(p[1] * 1000)}`;
  const coords = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  const add = (p: Pt): string => {
    const k = key(p);
    if (!coords.has(k)) { coords.set(k, p); adj.set(k, []); }
    return k;
  };
  for (const s of segs) {
    const k1 = add([s[0], s[1]]);
    const k2 = add([s[2], s[3]]);
    adj.get(k1)!.push(k2);
    adj.get(k2)!.push(k1);
  }
  let best: string[] = [];
  for (const start of adj.keys()) {
    const path: string[] = [];
    let cur = start, prev: string | null = null, guard = 0;
    while (guard++ < 200000) {
      path.push(cur);
      const nbrs = adj.get(cur)!;
      let nx: string | null = null;
      for (const n of nbrs) { if (n !== prev) { nx = n; break; } }
      if (nx === null) break;
      prev = cur; cur = nx;
      if (cur === start) break;
    }
    if (path.length > best.length) best = path;
  }
  return best.map((k) => coords.get(k)!);
}

/** Douglas-Peucker polyline simplification. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  let dmax = 0, idx = 0;
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[pts.length - 1];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - x0) * dy - (pts[i][1] - y0) * dx) / len;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > tol) {
    const left = simplify(pts.slice(0, idx + 1), tol);
    const right = simplify(pts.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[pts.length - 1]];
}

/** Monotone-chain convex hull (used as a safe fallback). */
export function convexHull(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function objectPixels(mask: Uint8Array, w: number, h: number): Pt[] {
  const out: Pt[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) out.push([x, y]);
  return out;
}

function makeUVGen(w: number, h: number, scale: number): any {
  const u = (x: number) => (x / scale + w / 2) / w;
  const v = (y: number) => (h / 2 - y / scale) / h;
  const mk = (verts: number[], i: number) =>
    new THREE.Vector2(u(verts[i * 3]), v(verts[i * 3 + 1]));
  return {
    generateTopUV(_g: any, verts: number[], a: number, b: number, c: number) {
      return [mk(verts, a), mk(verts, b), mk(verts, c)];
    },
    generateBottomUV(_g: any, verts: number[], a: number, b: number, c: number) {
      return [mk(verts, a), mk(verts, b), mk(verts, c)];
    },
    generateSideWallUV(_g: any, verts: number[], a: number, b: number, c: number, dd?: number) {
      const z = new THREE.Vector2(0, 0);
      return dd === undefined ? [z, z, z] : [z, z, z, z];
    },
  };
}

export interface BuildResult {
  mesh: THREE.Mesh;
  geometry: THREE.ExtrudeGeometry;
  materials: THREE.Material[];
  texture: THREE.Texture | null;
  info: { depth: number; vertices: number; avgColor: [number, number, number]; roughness: number };
}

/**
 * Turn a mask + source canvas into an extruded 3D mesh:
 * contour -> THREE.Shape -> ExtrudeGeometry (capped with the photo, sides with avg color).
 */
export function buildExtrudedModel(
  mask: MaskResult,
  sourceCanvas: HTMLCanvasElement | null,
  opts?: { targetHeight?: number }
): BuildResult | null {
  const { width: w, height: h, mask: m, avgColor, roughness } = mask;
  let loop = marchingSquares(m, w, h);
  if (loop.length < 5) loop = convexHull(objectPixels(m, w, h));
  if (loop.length < 3) return null;

  const simp = simplify(loop, 1.4);
  const target = opts?.targetHeight ?? 2.4;
  const scale = target / h;

  const shape = new THREE.Shape();
  simp.forEach((p, i) => {
    const x = (p[0] - w / 2) * scale;
    const y = (h / 2 - p[1]) * scale;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();

  const depth = target * 0.2;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.28,
    bevelSize: depth * 0.2,
    bevelSegments: 2,
    steps: 1,
    UVGenerator: makeUVGen(w, h, scale),
  });
  geo.center();
  geo.computeVertexNormals();

  const tex = sourceCanvas ? new THREE.CanvasTexture(sourceCanvas) : null;
  if (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.flipY = true;
  }
  const col = new THREE.Color(avgColor[0] / 255, avgColor[1] / 255, avgColor[2] / 255);
  const capMat = new THREE.MeshStandardMaterial({
    map: tex || null,
    color: tex ? 0xffffff : col,
    roughness,
    metalness: 0.04,
  });
  const wallMat = new THREE.MeshStandardMaterial({ color: col, roughness, metalness: 0.04 });

  const mesh = new THREE.Mesh(geo, [capMat, wallMat]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return {
    mesh,
    geometry: geo,
    materials: [capMat, wallMat],
    texture: tex,
    info: { depth, vertices: geo.attributes.position.count, avgColor, roughness },
  };
}
