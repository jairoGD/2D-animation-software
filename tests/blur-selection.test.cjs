const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const blurCode = source.slice(source.indexOf('function boxBlurHorizontal('), source.indexOf('function brushMask('));
const stampCode = source.slice(source.indexOf('function drawBrushStamp('), source.indexOf('function drawSoftBrushStroke('));
assert.ok(blurCode.startsWith('function boxBlurHorizontal(') && stampCode.startsWith('function drawBrushStamp('));

function stamp(pixels, selected, strength = 1) {
  const width = 9, height = 5;
  const state = {
    tool: 'brush', isAltDrawing: true, brushBlurRadius: 1,
    brushBlurStrength: strength, opacity: 1, brushHardness: 100,
    lassoActive: true, selectionMask: selected,
    blurOriginalPixels: null, blurScratchPixels: null, blurSelectionMask: null
  };
  const ctx = {
    canvas: { width, height },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        data.set(pixels.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
      }
      return { data, width: w, height: h };
    },
    putImageData(image, x, y) {
      for (let row = 0; row < image.height; row++) {
        pixels.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * width + x) * 4);
      }
    }
  };
  const context = { state, window: { event: { altKey: true } }, brushMask: () => 1, Uint8Array, Uint8ClampedArray, Math };
  vm.createContext(context);
  vm.runInContext(`${blurCode}\n${stampCode}\ndrawBrushStamp(ctx, 4, 2, 6, 12, null);`, Object.assign(context, { ctx }));
  return pixels;
}

function pixel(data, x, y) {
  return [...data.slice((x + y * 9) * 4, (x + y * 9) * 4 + 4)];
}

{
  const pixels = new Uint8ClampedArray(9 * 5 * 4);
  const selected = new Uint8Array(9 * 5);
  for (let y = 1; y <= 3; y++) for (let x = 2; x <= 6; x++) {
    selected[x + y * 9] = 1;
    pixels.set(x < 4 ? [255, 0, 0, 255] : [255, 255, 0, 255], (x + y * 9) * 4);
  }
  pixels.set([0, 0, 255, 255], (4 + 1 * 9) * 4);
  selected[4 + 1 * 9] = 0; // unselected hole inside the captured region
  stamp(pixels, selected);
  const mixed = pixel(pixels, 3, 2);
  assert.equal(mixed[0], 255);
  assert.ok(mixed[1] > 0 && mixed[1] < 255, 'selected red and yellow should still mix');
  assert.equal(mixed[2], 0, 'unselected blue must not bleed through a hole in the mask');
  assert.deepEqual(pixel(pixels, 4, 1), [0, 0, 255, 255]);
}

{
  const pixels = new Uint8ClampedArray(9 * 5 * 4);
  const selected = new Uint8Array(9 * 5);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 9; x++) {
    pixels.set([255, 255, 255, 255], (x + y * 9) * 4);
    if (x >= 2 && x <= 6 && y >= 1 && y <= 3) {
      selected[x + y * 9] = 1;
      pixels.set([255, 0, 0, 255], (x + y * 9) * 4);
    }
  }
  stamp(pixels, selected);
  assert.deepEqual(pixel(pixels, 2, 2), [255, 0, 0, 255], 'white outside selection must not tint its edge');
  assert.deepEqual(pixel(pixels, 1, 2), [255, 255, 255, 255], 'outside selection must stay unchanged');
}

{
  const pixels = new Uint8ClampedArray(9 * 5 * 4);
  const selected = new Uint8Array(9 * 5);
  selected[2 + 2 * 9] = 1;
  selected[3 + 2 * 9] = 1;
  pixels.set([255, 0, 0, 255], (2 + 2 * 9) * 4);
  pixels.set([0, 255, 0, 0], (3 + 2 * 9) * 4); // hidden RGB in transparent pixel
  stamp(pixels, selected, 0.5);
  const blurredTransparent = pixel(pixels, 3, 2);
  assert.ok(blurredTransparent[3] > 0, 'blur should spread into selected transparency');
  assert.deepEqual(blurredTransparent.slice(0, 3), [255, 0, 0], 'transparent pixels must not create a dark or green halo');
  assert.deepEqual(pixel(pixels, 4, 2), [0, 0, 0, 0], 'transparent area outside selection must stay unchanged');
}

console.log('Selection blur checks passed');
