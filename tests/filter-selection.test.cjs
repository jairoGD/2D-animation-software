const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const blurCode = source.slice(source.indexOf('function boxBlurHorizontal('), source.indexOf('function brushMask('));
const filterCode = source.slice(source.indexOf('function renderColorAdjustment('), source.indexOf('const colorAdjustModal ='));
assert.ok(blurCode.startsWith('function boxBlurHorizontal(') && filterCode.startsWith('function renderColorAdjustment('));
const adjustmentOpen = source.slice(source.indexOf('filterCategoryButtons.forEach('), source.indexOf('// Cancel action', source.indexOf('filterCategoryButtons.forEach(')));
const rampOpen = source.slice(source.indexOf("menuColorRamp.addEventListener('click'"), source.indexOf('// Cancel Action', source.indexOf("menuColorRamp.addEventListener('click'")));
assert.match(adjustmentOpen, /extractLassoSelection\(null, true\)/,
  'adjustment panels must keep a selected stencil floating during preview');
assert.match(rampOpen, /extractLassoSelection\(null, true\)/,
  'Color Ramp must keep a selected stencil floating during preview');

class Canvas {
  constructor(width = 0, height = 0, pixels = null) {
    this.width = width;
    this.height = height;
    this.pixels = pixels || new Uint8ClampedArray(width * height * 4);
    this.ctx = {
      filter: 'none',
      drawImage: sourceCanvas => { this.pixels = new Uint8ClampedArray(sourceCanvas.pixels); },
      getImageData: () => ({ data: new Uint8ClampedArray(this.pixels) }),
      putImageData: image => { this.pixels.set(image.data); }
    };
  }
  getContext() { return this.ctx; }
}

const context = {
  document: { createElement: () => new Canvas() },
  reduceCanvasColors: () => {},
  Uint8Array, Uint8ClampedArray, Math
};
vm.createContext(context);
vm.runInContext(`${blurCode}\n${filterCode}`, context);

const width = 9, height = 5;
const pixels = new Uint8ClampedArray(width * height * 4);
const mask = new Uint8ClampedArray(pixels.length);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const index = (x + y * width) * 4;
  pixels.set([255, 255, 255, 255], index);
  if (x >= 2 && x <= 6 && y >= 1 && y <= 3) {
    pixels.set([255, 0, 0, 255], index);
    mask[index + 3] = 255;
  }
}
const sourceCanvas = new Canvas(width, height, pixels);
const maskCanvas = new Canvas(width, height, mask);
const settings = { depth: 1, filterString: 'none', mosaic: 1, colorCount: 0 };
const result = context.renderColorAdjustment(sourceCanvas, settings, maskCanvas);
const pixel = (canvas, x, y) => [...canvas.pixels.slice((x + y * width) * 4, (x + y * width) * 4 + 4)];
assert.deepEqual(pixel(result, 2, 2), [255, 0, 0, 255], 'white outside selection must not affect filter blur');
assert.deepEqual(pixel(result, 1, 2), [0, 0, 0, 0], 'filter result must exclude pixels outside selection');

sourceCanvas.pixels.set([0, 255, 0, 0], (3 + 2 * width) * 4);
const transparentResult = context.renderColorAdjustment(sourceCanvas, settings, maskCanvas);
const transparentPixel = pixel(transparentResult, 3, 2);
assert.ok(transparentPixel[3] > 0, 'selected transparency should receive blurred color');
assert.deepEqual(transparentPixel.slice(0, 3), [255, 0, 0], 'hidden RGB must not create a halo');

console.log('Filter selection checks passed');
