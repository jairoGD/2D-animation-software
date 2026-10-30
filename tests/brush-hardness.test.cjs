const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tipCode = source.slice(source.indexOf('function updateBrushTip('), source.indexOf('function boxBlurHorizontal('));
const paintCode = source.slice(source.indexOf('function brushMask('), source.indexOf('function beginEraserStroke('));
assert.ok(tipCode.startsWith('function updateBrushTip(') && paintCode.startsWith('function brushMask('));

class Canvas {
  constructor(width = 0, height = 0) {
    this._width = width;
    this._height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.ctx = {
      canvas: this,
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x, y, w, h) => {
        const image = this.ctx.createImageData(w, h);
        for (let row = 0; row < h; row++) {
          image.data.set(this.pixels.subarray(((y + row) * this.width + x) * 4, ((y + row) * this.width + x + w) * 4), row * w * 4);
        }
        return image;
      },
      putImageData: (image, x, y) => {
        for (let row = 0; row < image.height; row++) {
          this.pixels.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * this.width + x) * 4);
        }
      }
    };
  }
  get width() { return this._width; }
  set width(value) { this._width = value; this.pixels = new Uint8ClampedArray(value * this.height * 4); }
  get height() { return this._height; }
  set height(value) { this._height = value; this.pixels = new Uint8ClampedArray(this.width * value * 4); }
  getContext() { return this.ctx; }
}

const state = {
  brushSize: 40, fgColor: '#ff0000', brushHardness: 0, opacity: 0.5,
  brushTipDirty: true, brushTipCanvas: null, lassoActive: false
};
const context = { state, document: { getElementById: () => ({ checked: true }), createElement: () => new Canvas() }, Math, Uint8Array, Uint8ClampedArray };
vm.createContext(context);
vm.runInContext(`${tipCode}\n${paintCode}`, context);

const softHalf = context.brushMask(10, 0, 20, 0);
assert.ok(softHalf > 0 && softHalf < 0.2, 'minimum hardness needs a distinctly soft falloff');
assert.ok(context.brushMask(10, 0, 20, 0.5) > softHalf);
assert.equal(context.brushMask(10, 0, 20, 1), 1);
assert.ok(context.brushMask(0.5, 0.5, 1, 0) > 0, 'small soft tips must remain visible');
assert.equal(context.brushMask(20, 0, 20, 0), 0);
let previousCoverage = 1;
for (let distance = 1; distance <= 20; distance++) {
  const coverage = context.brushMask(distance, 0, 20, 0);
  assert.ok(coverage <= previousCoverage, 'the soft edge must fall smoothly without rings');
  previousCoverage = coverage;
}

context.updateBrushTip();
const layer = new Canvas(64, 64);
context.beginPaintStroke(layer.ctx);
context.drawPaintStamp(layer.ctx, 32, 32, state.brushTipCanvas);
const first = layer.ctx.getImageData(0, 0, 64, 64).data;
context.drawPaintStamp(layer.ctx, 32, 32, state.brushTipCanvas);
const second = layer.ctx.getImageData(0, 0, 64, 64).data;
assert.deepEqual([...second], [...first], 'overlapping stamps must not accumulate opacity');
const center = (32 + 32 * 64) * 4;
const edge = (42 + 32 * 64) * 4;
assert.ok(second[center + 3] > second[edge + 3] && second[edge + 3] > 0);
assert.equal(second[center], 255, 'painting over transparency must keep the brush color clean');
context.drawPaintStamp(layer.ctx, 33, 32, state.brushTipCanvas);
const moved = layer.ctx.getImageData(0, 0, 64, 64).data;
for (let index = 3; index < moved.length; index += 4) {
  assert.ok(moved[index] <= 128, 'adjacent stamps must not build opacity above the selected stroke opacity');
}
context.clearPaintStroke();

state.lassoActive = false;
const tiledLayer = new Canvas(128, 128);
context.beginPaintStroke(tiledLayer.ctx);
context.drawPaintStamp(tiledLayer.ctx, 64, 64, state.brushTipCanvas);
assert.equal(state.paintTiles.size, 4, 'a stamp crossing tile boundaries must save each touched tile');
assert.ok(tiledLayer.ctx.getImageData(63, 63, 1, 1).data[3] > 0);
assert.ok(tiledLayer.ctx.getImageData(64, 64, 1, 1).data[3] > 0);
context.drawPaintStamp(tiledLayer.ctx, 65, 64, state.brushTipCanvas);
assert.ok(tiledLayer.ctx.getImageData(64, 64, 1, 1).data[3] <= 128);
context.clearPaintStroke();

const selectedLayer = new Canvas(64, 64);
for (let i = 0; i < selectedLayer.pixels.length; i += 4) selectedLayer.pixels.set([255, 255, 255, 255], i);
state.lassoActive = true;
state.selectionMask = new Uint8Array(64 * 64);
state.selectionMask[32 + 32 * 64] = 1;
context.beginPaintStroke(selectedLayer.ctx);
context.drawPaintStamp(selectedLayer.ctx, 32, 32, state.brushTipCanvas);
const selectedCenter = selectedLayer.ctx.getImageData(32, 32, 1, 1).data;
const unselectedNeighbor = selectedLayer.ctx.getImageData(33, 32, 1, 1).data;
assert.equal(selectedCenter[0], 255);
assert.ok(selectedCenter[1] >= 120 && selectedCenter[1] <= 135 && selectedCenter[1] === selectedCenter[2],
  'soft paint should blend cleanly over an opaque layer');
assert.equal(selectedCenter[3], 255);
assert.deepEqual([...unselectedNeighbor], [255, 255, 255, 255], 'the brush must respect the selection mask');
context.clearPaintStroke();

console.log('Brush hardness checks passed');
