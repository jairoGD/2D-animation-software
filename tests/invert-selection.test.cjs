const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const width = 12, height = 10;
const rasterCode = source.slice(source.indexOf('function rasterizeSelectionPaths('), source.indexOf('// ─── History (Undo/Redo)'));
const edgeCode = source.slice(source.indexOf('function tracePixelMaskEdges('), source.indexOf('// Before Transform starts'));
const invertCode = source.slice(source.indexOf('function getExistingSelectionMask('), source.indexOf('function bakeLassoSelection('));
assert.ok(rasterCode.startsWith('function rasterizeSelectionPaths(') && edgeCode.startsWith('function tracePixelMaskEdges(') && invertCode.startsWith('function getExistingSelectionMask('));

const state = {
  tool: 'lasso', lassoActive: true, lassoTransformMode: false,
  lassoMaskCanvas: {}, lassoBoundingBox: {},
  lassoCurrentOffset: { x: 0, y: 0 }, selectionMask: null
};
const context = {
  canvasW: width, canvasH: height, Uint8Array, Math, Map, state,
  getLCtx: () => ({}), selectionNeedsResampling: () => false,
  bakeLassoSelection: () => {},
  extractLassoSelection: mask => {
    state.selectionMask = new Uint8Array(mask);
    state.lassoMaskCanvas = {};
    state.lassoBoundingBox = {};
  },
  drawLassoSelectionOutline: () => {}, compositeAll: () => {}, saveHistory: () => {},
  document: { createElement: () => { throw new Error('An unchanged selection must not be redrawn'); } }
};
vm.createContext(context);
vm.runInContext(`${rasterCode}\n${edgeCode}\n${invertCode}`, context);

function checkRepeatedInversions(original) {
  state.selectionMask = new Uint8Array(original);
  for (let inversion = 1; inversion <= 12; inversion++) {
    const expected = Uint8Array.from(state.selectionMask, value => value === 1 ? 0 : 1);
    context.invertSelection();
    assert.deepEqual([...state.selectionMask], [...expected], `mask moved pixels on inversion ${inversion}`);
    assert.ok(state.lassoPaths.length > 0);
    const rasterized = context.rasterizeSelectionPaths(state.lassoPaths);
    assert.deepEqual([...rasterized], [...expected], `contour moved pixels on inversion ${inversion}`);
  }
  assert.deepEqual([...state.selectionMask], [...original], 'an even number of inversions must restore the exact original mask');
}

const rectangle = new Uint8Array(width * height);
for (let y = 2; y < 8; y++) for (let x = 3; x < 9; x++) rectangle[x + y * width] = 1;
checkRepeatedInversions(rectangle);

const irregular = new Uint8Array(width * height);
for (const [x, y] of [[1, 1], [2, 1], [2, 2], [4, 3], [5, 3], [4, 4], [8, 6], [9, 6], [9, 7]]) {
  irregular[x + y * width] = 1;
}
checkRepeatedInversions(irregular);

console.log('Selection inversion checks passed');
