import * as THREE from 'three';
import { makeMask, marchingSquares, simplify, buildExtrudedModel } from '../src/core/pipeline';

// Synthetic 120x120 image with a filled circle (object) on a white background.
const W = 120, H = 120;
const data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const dx = x - 60, dy = y - 60;
    const inside = dx * dx + dy * dy < 35 * 35;
    if (inside) { data[i] = 200; data[i + 1] = 40; data[i + 2] = 40; }
    else { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; }
    data[i + 3] = 255;
  }
}

const mask = makeMask(data, W, H);
console.log('mask object pixels:', mask.mask.reduce((a, b) => a + b, 0));
console.log('avgColor:', mask.avgColor, 'roughness:', mask.roughness.toFixed(3));

const loop = marchingSquares(mask.mask, W, H);
const simp = simplify(loop, 1.4);
console.log('contour length:', loop.length, 'simplified:', simp.length);

const res = buildExtrudedModel(mask, null, { targetHeight: 2.4 });
if (!res) { console.error('FAILED: buildExtrudedModel returned null'); process.exit(1); }
const pos = res.geometry.attributes.position;
console.log('geometry vertices:', pos.count, 'groups:', res.geometry.groups.length);
if (pos.count < 12) { console.error('FAILED: too few vertices'); process.exit(1); }
console.log('SMOKE TEST PASSED ✅');
