import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Red Ceramic Mug
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRedCeramicMugModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Red Ceramic Mug";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["base"] = createSculptMaterial(
    "base",
    {"id": "base", "name": "Red ceramic glaze", "type": "MeshPhysicalMaterial", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#B61B1E", "color": "#B61B1E", "albedo": {"dominant": "#680E11", "secondary": ["#D34139", "#8C1318", "#B61B1E"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_albedo.png", "url": "base_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#680E11", "#D34139", "#8C1318", "#B61B1E", "#AF9390"], "pattern": "reference-derived pixel palette", "amplitude": 0.225, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 1.0], "anisotropy": 8, "texelDensityIntent": "cylindrical body uses 2x horizontal repeat; handle uses 1x along arc"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.02, "description": "large cylindrical curvature and handle arc"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.005, "description": "rim bevel and handle cross-section"}, {"id": "micro", "frequency": 32.0, "amplitude": 0.001, "description": "glaze micro-imperfection noise"}], "roughness": {"base": 0.22, "variation": 0.08, "map": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_roughness.png", "url": "base_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}}, "metalness": 0.0, "normal": {"strength": 0.25, "map": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_normal.png", "url": "base_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.019, "map": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_height.png", "url": "base_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_ao.png", "url": "base_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "intensity": 0.6}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "local-gloss", "target": "mug-body", "type": "roughness", "roughness": 0.15, "clearcoat": 0.7, "evidenceRef": "full-object", "mask": "vertical gradient: glossier near highlight band"}, {"id": "handle-contact-wear", "target": "mug-handle", "type": "roughness", "roughness": 0.35, "evidenceRef": "full-object", "mask": "finger-contact zones along outer arc"}], "shaderNotes": ["use reference albedo map for local color variation", "clearcoat catches rim and highlight; keep metalness at 0 for dielectric ceramic"], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/philokun/code/img2threejs/workspace/reference/Product_photography_of_a_singl_2026-08-05T08-53-38.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_albedo.png", "url": "base_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_roughness.png", "url": "base_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_height.png", "url": "base_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_normal.png", "url": "base_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/philokun/code/img2threejs/workspace/pbr/base_ao.png", "url": "base_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 1024, "sourceHeight": 1024, "mapSize": 1024, "cropBBoxPixels": {"x": 78, "y": 297, "width": 654, "height": 516}, "mask": {"backgroundColor": "#D2D2D5", "backgroundNoise": 26.019, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1903}, "mapStats": {"valueRange": 0.5351, "heightP90Gradient": 0.04191, "roughnessBase": 0.688, "roughnessVariation": 0.077, "normalStrength": 0.205, "blurRadius": 21}, "palette": ["#680E11", "#D34139", "#8C1318", "#B61B1E", "#AF9390"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "clearcoat": 0.55, "clearcoatRoughness": 0.08, "ior": 1.5, "transmission": 0.0, "envMapIntensity": 1.0},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_mug_body_0 = null;
  const endpoint_mug_body_0 = makeAttachmentEndpoint(attachment_mug_body_0);
  const node_mug_body_0 = new THREE.Group();
  node_mug_body_0.name = "Mug body__pivot";
  if (endpoint_mug_body_0) {
    node_mug_body_0.position.copy(endpoint_mug_body_0.start);
    node_mug_body_0.rotation.set(0, 0, 0);
    node_mug_body_0.scale.set(1, 1, 1);
  } else {
    node_mug_body_0.position.set(0.0, 0.5, 0.0);
    node_mug_body_0.rotation.set(0.0, 0.0, 0.0);
    node_mug_body_0.scale.set(1.0, 1.0, 1.0);
  }
  node_mug_body_0.userData.sculptComponent = {"id": "mug-body", "name": "Mug body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Hollow ceramic body is generated as a closed cylinder volume; rim and base rings are separate meso/micro parts for edge definition.", "geometryDescriptor": {"topologyIntent": "open-top cylinder with wall thickness", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 4}, "deformationStack": ["taper lower 5% inward for base ring"], "uvStrategy": "cylindrical unwrap with vertical seam at handle attachment", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 0.85, "height": 1.0, "depth": 0.85, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 0.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0.5, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "handle-upper", "localPosition": [-0.43, 0.78, 0], "localRotation": [0, 0, 0]}, {"id": "handle-lower", "localPosition": [-0.43, 0.28, 0], "localRotation": [0, 0, 0]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.85, 1.0, 0.85], "isTrigger": false, "notes": "conservative cylindrical proxy for the body"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mug-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "base", "materialLayers": ["base"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["base-ring"], "surfaceDetail": {"macroRoughness": 0.25, "microRoughness": 0.05, "bumpAmplitude": 0.002, "normalPattern": "subtle glaze imperfection", "displacementPattern": "none", "occlusionPattern": "soft cavity at base ring", "edgeWearPattern": "none", "notes": "glossy ceramic with soft reflections"}, "evidenceRefs": ["full-object"], "details": ["base-ridge"], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(182, 27, 30, 1.0)", "secondaryAlbedo": "rgba(211, 65, 57, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.95, "evidenceRef": "full-object", "colorGradient": {"type": "radial", "stops": [{"color": "rgba(211, 65, 57, 1.0)", "position": 0.0}, {"color": "rgba(182, 27, 30, 1.0)", "position": 0.6}, {"color": "rgba(104, 14, 17, 1.0)", "position": 1.0}]}}};
  node_mug_body_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0.5, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "handle-upper", "localPosition": [-0.43, 0.78, 0], "localRotation": [0, 0, 0]}, {"id": "handle-lower", "localPosition": [-0.43, 0.28, 0], "localRotation": [0, 0, 0]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.85, 1.0, 0.85], "isTrigger": false, "notes": "conservative cylindrical proxy for the body"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mug-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mug_body_0);
  nodes["mug-body"] = node_mug_body_0;
  const mesh_mug_body_0Geometry = endpoint_mug_body_0
    ? new THREE.CylinderGeometry(endpoint_mug_body_0.endRadius, endpoint_mug_body_0.baseRadius, endpoint_mug_body_0.length, 32, 12)
    : new THREE.CylinderGeometry(0.425, 0.425, 1.0, 64, 16);
  const mesh_mug_body_0 = new THREE.Mesh(
    mesh_mug_body_0Geometry,
    materialMap["base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mug_body_0.name = "Mug body";
  if (endpoint_mug_body_0) {
    mesh_mug_body_0.position.copy(endpoint_mug_body_0.midpoint);
    mesh_mug_body_0.quaternion.copy(endpoint_mug_body_0.quaternion);
  }
  mesh_mug_body_0.castShadow = options.castShadow ?? true;
  mesh_mug_body_0.receiveShadow = options.receiveShadow ?? true;
  mesh_mug_body_0.userData.sculptComponent = {"id": "mug-body", "name": "Mug body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Hollow ceramic body is generated as a closed cylinder volume; rim and base rings are separate meso/micro parts for edge definition.", "geometryDescriptor": {"topologyIntent": "open-top cylinder with wall thickness", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 4}, "deformationStack": ["taper lower 5% inward for base ring"], "uvStrategy": "cylindrical unwrap with vertical seam at handle attachment", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 0.85, "height": 1.0, "depth": 0.85, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 0.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0.5, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "handle-upper", "localPosition": [-0.43, 0.78, 0], "localRotation": [0, 0, 0]}, {"id": "handle-lower", "localPosition": [-0.43, 0.28, 0], "localRotation": [0, 0, 0]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.85, 1.0, 0.85], "isTrigger": false, "notes": "conservative cylindrical proxy for the body"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mug-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "base", "materialLayers": ["base"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["base-ring"], "surfaceDetail": {"macroRoughness": 0.25, "microRoughness": 0.05, "bumpAmplitude": 0.002, "normalPattern": "subtle glaze imperfection", "displacementPattern": "none", "occlusionPattern": "soft cavity at base ring", "edgeWearPattern": "none", "notes": "glossy ceramic with soft reflections"}, "evidenceRefs": ["full-object"], "details": ["base-ridge"], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(182, 27, 30, 1.0)", "secondaryAlbedo": "rgba(211, 65, 57, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.95, "evidenceRef": "full-object", "colorGradient": {"type": "radial", "stops": [{"color": "rgba(211, 65, 57, 1.0)", "position": 0.0}, {"color": "rgba(182, 27, 30, 1.0)", "position": 0.6}, {"color": "rgba(104, 14, 17, 1.0)", "position": 1.0}]}}};
  node_mug_body_0.add(mesh_mug_body_0);
  meshes["mug-body"] = mesh_mug_body_0;
  colliders["mug-body"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.85, 1.0, 0.85], "isTrigger": false, "notes": "conservative cylindrical proxy for the body"};
  destructionGroups["mug-body"] ??= [];
  destructionGroups["mug-body"].push(node_mug_body_0);
  const socket_mug_body_handle_upper_0 = new THREE.Object3D();
  socket_mug_body_handle_upper_0.name = "handle-upper";
  socket_mug_body_handle_upper_0.position.set(-0.43, 0.78, 0.0);
  socket_mug_body_handle_upper_0.rotation.set(0.0, 0.0, 0.0);
  socket_mug_body_handle_upper_0.userData.socket = {"id": "handle-upper", "localPosition": [-0.43, 0.78, 0], "localRotation": [0, 0, 0]};
  node_mug_body_0.add(socket_mug_body_handle_upper_0);
  sockets["mug-body:handle-upper"] = socket_mug_body_handle_upper_0;
  const socket_mug_body_handle_lower_1 = new THREE.Object3D();
  socket_mug_body_handle_lower_1.name = "handle-lower";
  socket_mug_body_handle_lower_1.position.set(-0.43, 0.28, 0.0);
  socket_mug_body_handle_lower_1.rotation.set(0.0, 0.0, 0.0);
  socket_mug_body_handle_lower_1.userData.socket = {"id": "handle-lower", "localPosition": [-0.43, 0.28, 0], "localRotation": [0, 0, 0]};
  node_mug_body_0.add(socket_mug_body_handle_lower_1);
  sockets["mug-body:handle-lower"] = socket_mug_body_handle_lower_1;

  const attachment_mug_handle_1 = {"parentId": "mug-body", "parentSocket": "handle-upper", "localStart": [-0.43, 0.78, 0], "localEnd": [-0.43, 0.28, 0], "contactType": "embed-ceramic", "embedDepth": 0.03, "gapTolerance": 0.0, "contactNormal": [-1, 0, 0], "evidenceRefs": ["full-object"]};
  const endpoint_mug_handle_1 = makeAttachmentEndpoint(attachment_mug_handle_1);
  const node_mug_handle_1 = new THREE.Group();
  node_mug_handle_1.name = "Mug handle__pivot";
  if (endpoint_mug_handle_1) {
    node_mug_handle_1.position.copy(endpoint_mug_handle_1.start);
    node_mug_handle_1.rotation.set(0, 0, 0);
    node_mug_handle_1.scale.set(1, 1, 1);
  } else {
    node_mug_handle_1.position.set(-0.46, 0.53, 0.0);
    node_mug_handle_1.rotation.set(0.0, 0.0, -0.15);
    node_mug_handle_1.scale.set(1.0, 1.0, 1.0);
  }
  node_mug_handle_1.userData.sculptComponent = {"id": "mug-handle", "name": "Mug handle", "level": "meso", "role": "handle", "importance": 0.9, "confidence": 0.9, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "C-shaped handle is an extruded tubular form attached at two points; torus primitive captures the major arc.", "geometryDescriptor": {"topologyIntent": "tubular curved handle with circular cross-section", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.005, "segments": 2}, "deformationStack": ["bend torus arc 220 degrees", "slightly flatten cross-section where fingers grip"], "uvStrategy": "tubular unwrap along the arc", "normalStrategy": "smooth normals"}, "parent": "mug-body", "attachment": {"parentId": "mug-body", "parentSocket": "handle-upper", "localStart": [-0.43, 0.78, 0], "localEnd": [-0.43, 0.28, 0], "contactType": "embed-ceramic", "embedDepth": 0.03, "gapTolerance": 0.0, "contactNormal": [-1, 0, 0], "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.32, "tube": 0.055, "length": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.46, 0.53, 0], "rotation": [0, 0, -0.15], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "handle", "pivot": {"mode": "parent-socket", "localPosition": [-0.43, 0.53, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [-0.46, 0.53, 0], "scale": [0.11, 0.55, 0.11], "isTrigger": false, "notes": "capsule proxy aligned with handle arc"}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "mug-handle", "seamRefs": ["handle-upper", "handle-lower"], "detachableFragments": ["mug-handle"], "breakImpulse": 2.0, "debrisMaterial": "base"}}, "material": "base", "materialLayers": ["base"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.06, "bumpAmplitude": 0.001, "normalPattern": "subtle glaze flow lines", "displacementPattern": "none", "occlusionPattern": "contact shadow at attachment points", "edgeWearPattern": "none", "notes": "same glaze as body, slightly higher roughness from handling"}, "evidenceRefs": ["full-object"], "details": ["handle-contour"], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(182, 27, 30, 1.0)", "secondaryAlbedo": "rgba(140, 19, 24, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.92, "evidenceRef": "full-object"}};
  node_mug_handle_1.userData.actionProfile = {"animationRole": "handle", "pivot": {"mode": "parent-socket", "localPosition": [-0.43, 0.53, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [-0.46, 0.53, 0], "scale": [0.11, 0.55, 0.11], "isTrigger": false, "notes": "capsule proxy aligned with handle arc"}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "mug-handle", "seamRefs": ["handle-upper", "handle-lower"], "detachableFragments": ["mug-handle"], "breakImpulse": 2.0, "debrisMaterial": "base"}};
  (nodes["mug-body"] ?? root).add(node_mug_handle_1);
  nodes["mug-handle"] = node_mug_handle_1;
  const handleCurve_mug_handle_1 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-0.31, -0.25, 0),
    new THREE.Vector3(0, -0.5, 0),
  ]);
  const mesh_mug_handle_1Geometry = new THREE.TubeGeometry(handleCurve_mug_handle_1, 64, 0.055, 12, false);
  const mesh_mug_handle_1 = new THREE.Mesh(
    mesh_mug_handle_1Geometry,
    materialMap["base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mug_handle_1.name = "Mug handle";
  mesh_mug_handle_1.castShadow = options.castShadow ?? true;
  mesh_mug_handle_1.receiveShadow = options.receiveShadow ?? true;
  mesh_mug_handle_1.userData.sculptComponent = {"id": "mug-handle", "name": "Mug handle", "level": "meso", "role": "handle", "importance": 0.9, "confidence": 0.9, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "C-shaped handle is an extruded tubular form attached at two points; torus primitive captures the major arc.", "geometryDescriptor": {"topologyIntent": "tubular curved handle with circular cross-section", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.005, "segments": 2}, "deformationStack": ["bend torus arc 220 degrees", "slightly flatten cross-section where fingers grip"], "uvStrategy": "tubular unwrap along the arc", "normalStrategy": "smooth normals"}, "parent": "mug-body", "attachment": {"parentId": "mug-body", "parentSocket": "handle-upper", "localStart": [-0.43, 0.78, 0], "localEnd": [-0.43, 0.28, 0], "contactType": "embed-ceramic", "embedDepth": 0.03, "gapTolerance": 0.0, "contactNormal": [-1, 0, 0], "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.32, "tube": 0.055, "length": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.46, 0.53, 0], "rotation": [0, 0, -0.15], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "handle", "pivot": {"mode": "parent-socket", "localPosition": [-0.43, 0.53, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [-0.46, 0.53, 0], "scale": [0.11, 0.55, 0.11], "isTrigger": false, "notes": "capsule proxy aligned with handle arc"}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "mug-handle", "seamRefs": ["handle-upper", "handle-lower"], "detachableFragments": ["mug-handle"], "breakImpulse": 2.0, "debrisMaterial": "base"}}, "material": "base", "materialLayers": ["base"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.06, "bumpAmplitude": 0.001, "normalPattern": "subtle glaze flow lines", "displacementPattern": "none", "occlusionPattern": "contact shadow at attachment points", "edgeWearPattern": "none", "notes": "same glaze as body, slightly higher roughness from handling"}, "evidenceRefs": ["full-object"], "details": ["handle-contour"], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(182, 27, 30, 1.0)", "secondaryAlbedo": "rgba(140, 19, 24, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.92, "evidenceRef": "full-object"}};
  node_mug_handle_1.add(mesh_mug_handle_1);
  meshes["mug-handle"] = mesh_mug_handle_1;
  colliders["mug-handle"] = {"type": "capsule", "offset": [-0.46, 0.53, 0], "scale": [0.11, 0.55, 0.11], "isTrigger": false, "notes": "capsule proxy aligned with handle arc"};
  destructionGroups["mug-handle"] ??= [];
  destructionGroups["mug-handle"].push(node_mug_handle_1);

  const attachment_rim_ring_2 = {"parentId": "mug-body", "parentSocket": "rim-top", "localStart": [0, 1.0, 0], "localEnd": [0, 1.0, 0], "contactType": "overlap-ceramic", "overlap": 0.02, "gapTolerance": 0.0, "contactNormal": [0, 1, 0], "evidenceRefs": ["full-object"]};
  const endpoint_rim_ring_2 = makeAttachmentEndpoint(attachment_rim_ring_2);
  const node_rim_ring_2 = new THREE.Group();
  node_rim_ring_2.name = "Rim ring__pivot";
  if (endpoint_rim_ring_2) {
    node_rim_ring_2.position.copy(endpoint_rim_ring_2.start);
    node_rim_ring_2.rotation.set(0, 0, 0);
    node_rim_ring_2.scale.set(1, 1, 1);
  } else {
    node_rim_ring_2.position.set(0.0, 1.0, 0.0);
    node_rim_ring_2.rotation.set(0.0, 0.0, 0.0);
    node_rim_ring_2.scale.set(1.0, 1.0, 1.0);
  }
  node_rim_ring_2.userData.sculptComponent = {"id": "rim-ring", "name": "Rim ring", "level": "micro", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "Thin rounded lip at the top opening; adds specular catch and silhouette definition.", "geometryDescriptor": {"topologyIntent": "rounded top edge ring", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "cylindrical unwrap", "normalStrategy": "smooth normals"}, "parent": "mug-body", "attachment": {"parentId": "mug-body", "parentSocket": "rim-top", "localStart": [0, 1.0, 0], "localEnd": [0, 1.0, 0], "contactType": "overlap-ceramic", "overlap": 0.02, "gapTolerance": 0.0, "contactNormal": [0, 1, 0], "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.42, "tube": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 1.0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rim", "pivot": {"mode": "parent-socket", "localPosition": [0, 1.0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.84, 0.03, 0.84], "isTrigger": false, "notes": "thin rim proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mug-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "base", "materialLayers": ["base"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.03, "bumpAmplitude": 0.001, "normalPattern": "sharp rim specular catch", "displacementPattern": "none", "occlusionPattern": "none", "edgeWearPattern": "none", "notes": "slightly glossier at the rim"}, "evidenceRefs": ["full-object"], "details": ["rim-bevel"], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 65, 57, 1.0)", "secondaryAlbedo": "rgba(182, 27, 30, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_rim_ring_2.userData.actionProfile = {"animationRole": "rim", "pivot": {"mode": "parent-socket", "localPosition": [0, 1.0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.84, 0.03, 0.84], "isTrigger": false, "notes": "thin rim proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mug-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mug-body"] ?? root).add(node_rim_ring_2);
  nodes["rim-ring"] = node_rim_ring_2;
  const mesh_rim_ring_2Geometry = endpoint_rim_ring_2
    ? new THREE.CylinderGeometry(endpoint_rim_ring_2.endRadius, endpoint_rim_ring_2.baseRadius, endpoint_rim_ring_2.length, 32, 12)
    : new THREE.TorusGeometry(0.42, 0.015, 16, 96);
  const mesh_rim_ring_2 = new THREE.Mesh(
    mesh_rim_ring_2Geometry,
    materialMap["base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_ring_2.name = "Rim ring";
  if (endpoint_rim_ring_2) {
    mesh_rim_ring_2.position.copy(endpoint_rim_ring_2.midpoint);
    mesh_rim_ring_2.quaternion.copy(endpoint_rim_ring_2.quaternion);
  }
  mesh_rim_ring_2.castShadow = options.castShadow ?? true;
  mesh_rim_ring_2.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_ring_2.userData.sculptComponent = {"id": "rim-ring", "name": "Rim ring", "level": "micro", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "Thin rounded lip at the top opening; adds specular catch and silhouette definition.", "geometryDescriptor": {"topologyIntent": "rounded top edge ring", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "cylindrical unwrap", "normalStrategy": "smooth normals"}, "parent": "mug-body", "attachment": {"parentId": "mug-body", "parentSocket": "rim-top", "localStart": [0, 1.0, 0], "localEnd": [0, 1.0, 0], "contactType": "overlap-ceramic", "overlap": 0.02, "gapTolerance": 0.0, "contactNormal": [0, 1, 0], "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.42, "tube": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 1.0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rim", "pivot": {"mode": "parent-socket", "localPosition": [0, 1.0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.84, 0.03, 0.84], "isTrigger": false, "notes": "thin rim proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mug-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "base", "materialLayers": ["base"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.03, "bumpAmplitude": 0.001, "normalPattern": "sharp rim specular catch", "displacementPattern": "none", "occlusionPattern": "none", "edgeWearPattern": "none", "notes": "slightly glossier at the rim"}, "evidenceRefs": ["full-object"], "details": ["rim-bevel"], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 65, 57, 1.0)", "secondaryAlbedo": "rgba(182, 27, 30, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_rim_ring_2.add(mesh_rim_ring_2);
  meshes["rim-ring"] = mesh_rim_ring_2;
  colliders["rim-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.84, 0.03, 0.84], "isTrigger": false, "notes": "thin rim proxy"};
  destructionGroups["mug-body"] ??= [];
  destructionGroups["mug-body"].push(node_rim_ring_2);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRedCeramicMugLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Red Ceramic Mug look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["key light: soft directional from upper-right, warm white, intensity ~1.2", "fill light: large diffuse from upper-left, cool white, intensity ~0.4", "rim or environment light: subtle environment reflection from studio grey dome", "exposure: middle-grey reference background, no blown highlights", "tone mapping: ACESFilmicToneMapping with neutral contrast", "background: solid light grey (#E8E8EA) to match studio backdrop", "contact shadow: soft ground shadow beneath the base"];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRedCeramicMugEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRedCeramicMugCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRedCeramicMugPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRedCeramicMugRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRedCeramicMugInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
