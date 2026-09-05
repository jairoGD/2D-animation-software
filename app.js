/* ═══════════════════════════════════════════════════════════════
   Illustra — Core Engine
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── State ──────────────────────────────────────────────────────
const state = {
  tool: 'pencil',
  fgColor: '#000000',
  bgColor: '#ffffff',
  // bgMode controls how the canvas background is displayed and exported.
  // Solid modes: 'white' | 'black' | 'color'
  // Transparent modes (checkerboard display, transparent export):
  //   'trans-bright' | 'trans-dark' | 'trans-white' | 'trans-black' | 'trans-color'
  bgMode: 'white',
  brushSize: 1,
  brushHardness: 100,
  brushSpacing: 0.15,
  brushBlurRadius: 5,
  brushBlurStrength: 0.25,
  brushTipCanvas: null,
  // Per-tool independent sizes (pencil / brush / eraser each remember their own)
  toolSizes: { pencil: 1, brush: 16, eraser: 24, line: 1, rect: 4, circle: 4, curve: 1 },
  opacity: 1,
  bucketThreshold: 30,
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  isDrawing: false,
  // Lasso Selection State
  lassoType: 'free', // 'free' or 'rect'
  lassoPath: [],
  lassoPaths: [],
  lassoActive: false,
  lassoAnimState: false,
  lassoSelectionCanvas: null,
  lassoMaskCanvas: null, // exact boolean mask pixel buffer
  lassoBoundingBox: null,
  lassoCurrentOffset: { x: 0, y: 0 },
  lassoPrevOffset: { x: 0, y: 0 },
  lassoStartOffset: { x: 0, y: 0 },
  lassoDragged: false,
  lassoTransformMode: false,
  lassoScaleX: 1,
  lassoScaleY: 1,
  lassoRotation: 0,
  lassoDragStart: null,
  spaceDown: false,
  lastX: 0,
  lastY: 0,
  panStartX: 0,
  panStartY: 0,
  panStartMouseX: 0,
  panStartMouseY: 0,
  isMovingAllBitmaps: false,
  moveAllLayers: false,
  moveAllStartX: 0,
  moveAllStartY: 0,
  moveAllCurrentDX: 0,
  moveAllCurrentDY: 0,
  shapeStartX: 0,
  shapeStartY: 0,
  // Curve Tool State
  curveStep: 0,
  curvePoints: [],
  history: [],
  redoStack: [],
  maxHistory: 40,
  // Shift+click straight-line anchor
  shiftAnchor: null,   // { x, y } in canvas coords, or null
  shiftDown: false,
  // Timeline State
  currentFrame: 0,
  totalFrames: 24,
  isPlaying: false,
  fps: 12,
  loop: true,
  onionSkin: false,
  // Lasso Clipboard (internal — stores copied/cut selection)
  lassoClipboard: null,   // { canvas, path, boundingBox }
  lassoCutPending: false, // true when the floating selection came from Ctrl+X
  isExporting: false,
  allLayersActive: false,
};

// ─── Canvas / Layer Setup ───────────────────────────────────────
const mainCanvas    = document.getElementById('main-canvas');
const previewCanvas = document.getElementById('preview-canvas');
const displayCtx    = mainCanvas.getContext('2d');  // composite display
const pctx          = previewCanvas.getContext('2d');
const container     = document.getElementById('canvas-container');

let canvasW = 512;
let canvasH = 512;

// ─── Layer / Frame System ────────────────────────────────────────
let layers        = [];   // array of { id, name, visible, opacity, frames: [{ canvas, ctx, isKeyframe }] }
let layerIdCount  = 1;
let activeLayerIdx = 0;

function getLCtx() {
  const f = layers[activeLayerIdx]?.frames[state.currentFrame];
  if (f) {
    if (!f.canvas) {
      const c = document.createElement('canvas');
      c.width = canvasW;
      c.height = canvasH;
      f.canvas = c;
      f.ctx = c.getContext('2d');
    }
    return f.ctx;
  }
  return null;
}

function createFrameData() {
  return {
    canvas: null,
    ctx: null,
    isKeyframe: false,
    offsetX: 0,
    offsetY: 0,
    backingCanvas: null
  };
}

function syncBackingCanvas(f) {
  if (!f || !f.canvas) return;
  if (!f.backingCanvas) {
    f.backingCanvas = document.createElement('canvas');
    f.backingCanvas.width = canvasW * 3;
    f.backingCanvas.height = canvasH * 3;
  }
  const bctx = f.backingCanvas.getContext('2d');
  const targetX = canvasW - (f.offsetX || 0);
  const targetY = canvasH - (f.offsetY || 0);
  bctx.clearRect(targetX, targetY, canvasW, canvasH);
  bctx.drawImage(f.canvas, targetX, targetY);
}

window.syncBackingCanvas = syncBackingCanvas;

function createLayerData(name) {
  const layer = {
    id: layerIdCount++,
    name: name || `Layer ${layerIdCount - 1}`,
    visible: true,
    opacity: 1,
    blendMode: 'source-over',
    frames: []
  };
  for (let f = 0; f < state.totalFrames; f++) {
    layer.frames.push(createFrameData());
  }
  return layer;
}

function markActiveFrameAsKeyframe() {
  const f = layers[activeLayerIdx]?.frames[state.currentFrame];
  if (f && !f.isKeyframe) {
    f.isKeyframe = true;
    renderTimeline();
  }
}

function getDisplayFrame(layer, frameIdx) {
  for (let i = frameIdx; i >= 0; i--) {
    const f = layer.frames[i];
    if (f && f.isKeyframe) return f;
  }
  return null;
}

function getNextKeyframe(layer, frameIdx) {
  for (let i = frameIdx + 1; i < state.totalFrames; i++) {
    const f = layer.frames[i];
    if (f && f.isKeyframe) return f;
  }
  return null;
}

// ─── Background helpers ──────────────────────────────────────────
// Returns the solid hex color to use for non-transparent bg modes.
function _resolveBgSolidColor() {
  switch (state.bgMode) {
    case 'white':       return '#ffffff';
    case 'black':       return '#000000';
    case 'color':       return state.bgColor;
    case 'trans-white': return '#ffffff';
    case 'trans-black': return '#000000';
    case 'trans-color': return state.bgColor;
    default:            return '#ffffff';
  }
}

// Draws a checkerboard pattern for transparent bg modes.
function _drawCheckerboard(ctx, w, h, mode) {
  const size = 12; // checker square size in canvas pixels
  let c1, c2;
  switch (mode) {
    case 'trans-bright': c1 = '#cccccc'; c2 = '#ffffff'; break;
    case 'trans-dark':   c1 = '#444444'; c2 = '#666666'; break;
    case 'trans-white':  c1 = '#e8e8e8'; c2 = '#ffffff'; break;
    case 'trans-black':  c1 = '#1a1a1a'; c2 = '#333333'; break;
    case 'trans-color':  c1 = state.bgColor; c2 = _lightenHex(state.bgColor, 30); break;
    default:             c1 = '#cccccc'; c2 = '#ffffff';
  }
  const cols = Math.ceil(w / size);
  const rows = Math.ceil(h / size);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? c1 : c2;
      ctx.fillRect(col * size, row * size, size, size);
    }
  }
}

// Helper: lighten a hex color by a given amount (0-255)
function _lightenHex(hex, amount) {
  const r = Math.min(255, parseInt(hex.slice(1,3),16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3,5),16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5,7),16) + amount);
  return `rgb(${r},${g},${b})`;
}

function compositeAll() {
  displayCtx.clearRect(0, 0, canvasW, canvasH);

  const hasVisibleVideo = layers.some(l => l.visible && l.isVideo && l.video && !l.videoOffline);
  const isTransparent = state.bgMode && state.bgMode.startsWith('trans-');

  if (state.isExporting) {
    // On export: transparent modes leave background empty (alpha=0); solid modes fill
    if (!isTransparent) {
      displayCtx.fillStyle = _resolveBgSolidColor();
      displayCtx.fillRect(0, 0, canvasW, canvasH);
    }
  } else if (!hasVisibleVideo) {
    if (isTransparent) {
      // Draw a checkerboard to visually indicate transparency
      _drawCheckerboard(displayCtx, canvasW, canvasH, state.bgMode);
    } else {
      displayCtx.fillStyle = _resolveBgSolidColor();
      displayCtx.fillRect(0, 0, canvasW, canvasH);
    }
  }

  const mdx = state.isMovingAllBitmaps ? state.moveAllCurrentDX : 0;
  const mdy = state.isMovingAllBitmaps ? state.moveAllCurrentDY : 0;

  // 1. Onion Skin (Low opacity preview of prev and next frame)
  if (state.onionSkin && !state.isPlaying) {
    displayCtx.globalAlpha = 0.25;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.visible || l.isVideo) continue;
      let currentDisplay = getDisplayFrame(l, state.currentFrame);
      let prevIdx = currentDisplay ? l.frames.indexOf(currentDisplay) - 1 : state.currentFrame - 1;
      if (prevIdx >= 0) {
        const prevF = getDisplayFrame(l, prevIdx);
        if (prevF && prevF.canvas) {
          let sourceCanvas = prevF.canvas;
          let drawX = 0;
          let drawY = 0;
          const isMovingThisLayer = state.isMovingAllBitmaps && (state.moveAllLayers || l === layers[activeLayerIdx]);
          if (isMovingThisLayer) {
            if (prevF.backingCanvas) {
              sourceCanvas = prevF.backingCanvas;
              drawX = -canvasW + (prevF.offsetX || 0) + mdx;
              drawY = -canvasH + (prevF.offsetY || 0) + mdy;
            } else {
              drawX = mdx;
              drawY = mdy;
            }
          }
          displayCtx.drawImage(sourceCanvas, drawX, drawY);
        }
      }
    }

    displayCtx.globalAlpha = 0.15;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.visible || l.isVideo) continue;
      const nextF = getNextKeyframe(l, state.currentFrame);
      if (nextF && nextF.canvas) {
        let sourceCanvas = nextF.canvas;
        let drawX = 0;
        let drawY = 0;
        const isMovingThisLayer = state.isMovingAllBitmaps && (state.moveAllLayers || l === layers[activeLayerIdx]);
        if (isMovingThisLayer) {
          if (nextF.backingCanvas) {
            sourceCanvas = nextF.backingCanvas;
            drawX = -canvasW + (nextF.offsetX || 0) + mdx;
            drawY = -canvasH + (nextF.offsetY || 0) + mdy;
          } else {
            drawX = mdx;
            drawY = mdy;
          }
        }
        displayCtx.drawImage(sourceCanvas, drawX, drawY);
      }
    }
  }

  // 2. Composite visible layers current frame
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.isVideo) {
      if (l.video) {
        if (l.visible && !l.videoOffline) {
          const targetTime = state.currentFrame / state.fps;

          l.video.style.display = 'block';
          l.video.style.opacity = l.opacity;

          if (state.isPlaying) {
            if (l.video.paused) {
              l.video.play().catch(() => {});
            }
            const drift = Math.abs(l.video.currentTime - targetTime);
            if (drift > 0.15) {
              l.video.currentTime = targetTime;
            }
          } else {
            if (!l.video.paused) {
              l.video.pause();
            }
            if (l.video._targetTime !== targetTime) {
              l.video._targetTime = targetTime;
              l.video.currentTime = targetTime;
            }
          }

          if (state.isExporting && l.video.readyState >= 2) {
            displayCtx.save();
            displayCtx.globalAlpha = l.opacity;
            const blendMode = l.blendMode || 'source-over';
            const isMovingThisLayer = state.isMovingAllBitmaps && (state.moveAllLayers || l === layers[activeLayerIdx]);
            const vDrawX = isMovingThisLayer ? mdx : 0;
            const vDrawY = isMovingThisLayer ? mdy : 0;
            if (blendMode === 'invert') {
              const tempCanvas = document.createElement('canvas');
              tempCanvas.width = canvasW;
              tempCanvas.height = canvasH;
              const tempCtx = tempCanvas.getContext('2d');
              tempCtx.drawImage(mainCanvas, 0, 0);
              tempCtx.globalCompositeOperation = 'difference';
              tempCtx.fillStyle = '#ffffff';
              tempCtx.fillRect(0, 0, canvasW, canvasH);
              tempCtx.globalCompositeOperation = 'destination-in';
              tempCtx.drawImage(l.video, vDrawX, vDrawY, canvasW, canvasH);
              displayCtx.globalCompositeOperation = 'source-over';
              displayCtx.drawImage(tempCanvas, 0, 0);
            } else if (blendMode === 'mask') {
              displayCtx.globalCompositeOperation = 'destination-in';
              displayCtx.drawImage(l.video, vDrawX, vDrawY, canvasW, canvasH);
            } else {
              displayCtx.globalCompositeOperation = blendMode;
              try {
                displayCtx.drawImage(l.video, vDrawX, vDrawY, canvasW, canvasH);
              } catch (e) {
                console.warn("Error drawing video during export:", e);
              }
            }
            displayCtx.restore();
          }
        } else {
          l.video.style.display = 'none';
          if (!l.video.paused) {
            l.video.pause();
          }
        }
      }
    } else {
      if (!l.visible) continue;
      const f = (state.lassoActive && l === layers[activeLayerIdx]) ? l.frames[state.currentFrame] : getDisplayFrame(l, state.currentFrame);
      if (f && f.canvas) {
        displayCtx.save();
        displayCtx.globalAlpha = l.opacity;
        let sourceCanvas = f.canvas;
        let drawX = 0;
        let drawY = 0;
        const isMovingThisLayer = state.isMovingAllBitmaps && (state.moveAllLayers || l === layers[activeLayerIdx]);
        if (isMovingThisLayer) {
          if (f.backingCanvas) {
            sourceCanvas = f.backingCanvas;
            drawX = -canvasW + (f.offsetX || 0) + mdx;
            drawY = -canvasH + (f.offsetY || 0) + mdy;
          } else {
            drawX = mdx;
            drawY = mdy;
          }
        }
        if (state.colorRampPreview && state.colorRampPreview.active && 
            (state.colorRampPreview.allLayers || l === layers[activeLayerIdx]) &&
            !state.lassoActive) {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = sourceCanvas.width;
          tempCanvas.height = sourceCanvas.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(sourceCanvas, 0, 0);
          applyLUTToCanvas(tempCanvas, state.colorRampPreview.lut);
          sourceCanvas = tempCanvas;
        }

        if (state.colorAdjustPreview && 
            (state.colorAdjustPreview.allLayers || l === layers[activeLayerIdx]) &&
            !state.lassoActive) {
          const mosaic = state.colorAdjustPreview.mosaic || 1;
          if (mosaic > 1) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = canvasW;
            tempCanvas.height = canvasH;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.filter = state.colorAdjustPreview.filterString;
            tempCtx.drawImage(f.canvas, 0, 0);

            const tinyCanvas = document.createElement('canvas');
            tinyCanvas.width = Math.max(1, Math.floor(canvasW / mosaic));
            tinyCanvas.height = Math.max(1, Math.floor(canvasH / mosaic));
            const tinyCtx = tinyCanvas.getContext('2d');
            tinyCtx.imageSmoothingEnabled = false;
            tinyCtx.drawImage(tempCanvas, 0, 0, tinyCanvas.width, tinyCanvas.height);

            tempCtx.clearRect(0, 0, canvasW, canvasH);
            tempCtx.imageSmoothingEnabled = false;
            tempCtx.drawImage(tinyCanvas, 0, 0, canvasW, canvasH);

            sourceCanvas = tempCanvas;
          } else {
            displayCtx.filter = state.colorAdjustPreview.filterString;
          }
        }
        
        const blendMode = l.blendMode || 'source-over';
        if (blendMode === 'invert') {
          // Custom Invert Backdrop Mode:
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = canvasW;
          tempCanvas.height = canvasH;
          const tempCtx = tempCanvas.getContext('2d');
          
          // Draw displayCanvas content so far
          tempCtx.drawImage(mainCanvas, 0, 0);
          
          // Invert the backdrop image on the temp canvas
          tempCtx.globalCompositeOperation = 'difference';
          tempCtx.fillStyle = '#ffffff';
          tempCtx.fillRect(0, 0, canvasW, canvasH);
          
          // Mask the inverted backdrop with the source canvas
          tempCtx.globalCompositeOperation = 'destination-in';
          tempCtx.drawImage(sourceCanvas, drawX, drawY);
          
          // Draw the masked inverted backdrop back to displayCtx
          displayCtx.globalCompositeOperation = 'source-over';
          displayCtx.drawImage(tempCanvas, 0, 0);
        } else if (blendMode === 'mask') {
          displayCtx.globalCompositeOperation = 'destination-in';
          displayCtx.drawImage(sourceCanvas, drawX, drawY);
        } else {
          displayCtx.globalCompositeOperation = blendMode;
          displayCtx.drawImage(sourceCanvas, drawX, drawY);
        }
        
        // Draw floating lasso selection if active on this layer
        if (state.lassoActive && state.lassoSelectionCanvas && l === layers[activeLayerIdx]) {
          displayCtx.save();
          displayCtx.imageSmoothingEnabled = isAntiAliasingEnabled();
          const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
          const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
          displayCtx.translate(cx, cy);
          displayCtx.rotate(state.lassoRotation || 0);
          displayCtx.scale(state.lassoScaleX || 1, state.lassoScaleY || 1);
          displayCtx.translate(-cx, -cy);

          if (state.colorRampPreview && state.colorRampPreview.active) {
            const filterCanvas = document.createElement('canvas');
            filterCanvas.width = state.lassoSelectionCanvas.width;
            filterCanvas.height = state.lassoSelectionCanvas.height;
            const filterCtx = filterCanvas.getContext('2d');
            filterCtx.drawImage(state.lassoSelectionCanvas, 0, 0);
            applyLUTToCanvas(filterCanvas, state.colorRampPreview.lut);
            
            if (state.lassoMaskCanvas) {
              filterCtx.globalCompositeOperation = 'destination-in';
              filterCtx.drawImage(state.lassoMaskCanvas, 0, 0);
            }
            displayCtx.drawImage(
              filterCanvas,
              state.lassoBoundingBox.x + state.lassoCurrentOffset.x,
              state.lassoBoundingBox.y + state.lassoCurrentOffset.y
            );
          } else if (state.colorAdjustPreview) {
            const filterCanvas = document.createElement('canvas');
            filterCanvas.width = state.lassoSelectionCanvas.width;
            filterCanvas.height = state.lassoSelectionCanvas.height;
            const filterCtx = filterCanvas.getContext('2d');
            filterCtx.filter = state.colorAdjustPreview.filterString;
            filterCtx.drawImage(state.lassoSelectionCanvas, 0, 0);
            
            const mosaic = state.colorAdjustPreview.mosaic || 1;
            if (mosaic > 1) {
              const tinyCanvas = document.createElement('canvas');
              tinyCanvas.width = Math.max(1, Math.floor(filterCanvas.width / mosaic));
              tinyCanvas.height = Math.max(1, Math.floor(filterCanvas.height / mosaic));
              const tinyCtx = tinyCanvas.getContext('2d');
              tinyCtx.imageSmoothingEnabled = false;
              tinyCtx.drawImage(filterCanvas, 0, 0, tinyCanvas.width, tinyCanvas.height);
              
              filterCtx.clearRect(0, 0, filterCanvas.width, filterCanvas.height);
              filterCtx.imageSmoothingEnabled = false;
              filterCtx.drawImage(tinyCanvas, 0, 0, filterCanvas.width, filterCanvas.height);
            }

            if (state.lassoMaskCanvas) {
              filterCtx.filter = 'none';
              filterCtx.globalCompositeOperation = 'destination-in';
              filterCtx.drawImage(state.lassoMaskCanvas, 0, 0);
            }
            displayCtx.drawImage(
              filterCanvas,
              state.lassoBoundingBox.x + state.lassoCurrentOffset.x,
              state.lassoBoundingBox.y + state.lassoCurrentOffset.y
            );
          } else {
            displayCtx.drawImage(
              state.lassoSelectionCanvas,
              state.lassoBoundingBox.x + state.lassoCurrentOffset.x,
              state.lassoBoundingBox.y + state.lassoCurrentOffset.y
            );
          }
          displayCtx.restore();
        }
        displayCtx.restore();
      }
    }
  }
  displayCtx.globalAlpha = 1;
  updateLayerThumbs();
}

// ─── Layers ──────────────────────────────────────────────────────
function addLayer(name) {
  const l = createLayerData(name);
  layers.splice(activeLayerIdx, 0, l);
  renderLayerPanel();
  renderTimeline();
  compositeAll();
  saveHistory();
}

function mergeActiveLayerDown() {
  if (activeLayerIdx >= layers.length - 1) {
    showToast('⚠️ No layer below to merge!');
    return;
  }
  
  const topLayer = layers[activeLayerIdx];
  const bottomLayer = layers[activeLayerIdx + 1];
  
  if (topLayer.isVideo || bottomLayer.isVideo) {
    showToast('⚠️ Cannot merge video layers!');
    return;
  }
  
  // Combine topLayer into bottomLayer frame by frame
  const mergedFrames = [];
  for (let f = 0; f < state.totalFrames; f++) {
    const isKey = topLayer.frames[f].isKeyframe || bottomLayer.frames[f].isKeyframe;
    if (isKey) {
      const fd = createFrameData();
      fd.isKeyframe = true;
      fd.canvas = document.createElement('canvas');
      fd.canvas.width = canvasW;
      fd.canvas.height = canvasH;
      fd.ctx = fd.canvas.getContext('2d');
      
      const bDisp = getDisplayFrame(bottomLayer, f);
      if (bDisp && bDisp.canvas) {
        fd.ctx.drawImage(bDisp.canvas, 0, 0);
      }
      
      const tDisp = getDisplayFrame(topLayer, f);
      if (tDisp && tDisp.canvas) {
        fd.ctx.save();
        fd.ctx.globalAlpha = topLayer.opacity;
        const blendMode = topLayer.blendMode || 'source-over';
        if (blendMode === 'invert') {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = canvasW;
          tempCanvas.height = canvasH;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(fd.canvas, 0, 0);
          tempCtx.globalCompositeOperation = 'difference';
          tempCtx.fillStyle = '#ffffff';
          tempCtx.fillRect(0, 0, canvasW, canvasH);
          tempCtx.globalCompositeOperation = 'destination-in';
          tempCtx.drawImage(tDisp.canvas, 0, 0);
          fd.ctx.globalCompositeOperation = 'source-over';
          fd.ctx.drawImage(tempCanvas, 0, 0);
        } else if (blendMode === 'mask') {
          fd.ctx.globalCompositeOperation = 'destination-in';
          fd.ctx.drawImage(tDisp.canvas, 0, 0);
        } else {
          fd.ctx.globalCompositeOperation = blendMode;
          fd.ctx.drawImage(tDisp.canvas, 0, 0);
        }
        fd.ctx.restore();
      }
      mergedFrames.push(fd);
    } else {
      const fd = createFrameData();
      fd.isKeyframe = false;
      mergedFrames.push(fd);
    }
  }
  
  bottomLayer.frames = mergedFrames;
  
  // Remove topLayer
  layers.splice(activeLayerIdx, 1);
  
  renderLayerPanel();
  renderTimeline();
  compositeAll();
  saveHistory();
  showToast('🥞 Layers merged!');
}

function deleteActiveLayer() {
  if (layers.length <= 1) return;
  layers.splice(activeLayerIdx, 1);
  activeLayerIdx = Math.max(0, activeLayerIdx - 1);
  renderLayerPanel();
  renderTimeline();
  compositeAll();
  saveHistory();
}

function moveActiveLayer(dir) { // dir: -1=up in list, 1=down in list
  const target = activeLayerIdx + dir;
  if (target < 0 || target >= layers.length) return;
  [layers[activeLayerIdx], layers[target]] = [layers[target], layers[activeLayerIdx]];
  activeLayerIdx = target;
  renderLayerPanel();
  renderTimeline();
  compositeAll();
  saveHistory();
}

// ─── Layer Panel UI (Sidebar) ────────────────────────────────────
const layersList = document.getElementById('layers-list');

function renderLayerPanel() {
  if (typeof syncDOMVideos === 'function') syncDOMVideos();
  layersList.innerHTML = '';
  layers.forEach((l, i) => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (i === activeLayerIdx ? ' active' : '');
    item.dataset.idx = i;

    const vis = document.createElement('button');
    vis.className = 'layer-vis-btn' + (l.visible ? '' : ' hidden-layer');
    vis.title = l.visible ? 'Ocultar' : 'Mostrar';
    vis.innerHTML = l.visible
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    vis.addEventListener('click', e => { e.stopPropagation(); l.visible = !l.visible; renderLayerPanel(); renderTimeline(); compositeAll(); });

    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    const tc = document.createElement('canvas');
    tc.width = 64; tc.height = 48;
    const tcCtx = tc.getContext('2d');
    if (l.isVideo && l.video) {
      if (!l.videoOffline && l.video.readyState >= 2) {
        try {
          tcCtx.drawImage(l.video, 0, 0, canvasW, canvasH, 0, 0, 64, 48);
        } catch (e) {
          tcCtx.fillStyle = '#222';
          tcCtx.fillRect(0, 0, 64, 48);
        }
      } else {
        tcCtx.fillStyle = '#2a1a1a';
        tcCtx.fillRect(0, 0, 64, 48);
        tcCtx.fillStyle = '#f87171';
        tcCtx.font = 'bold 9px sans-serif';
        tcCtx.textAlign = 'center';
        tcCtx.textBaseline = 'middle';
        tcCtx.fillText('OFFLINE', 32, 24);
      }
    } else {
      const activeFrame = l.frames[state.currentFrame];
      if (activeFrame && activeFrame.canvas) {
        tcCtx.drawImage(activeFrame.canvas, 0, 0, canvasW, canvasH, 0, 0, 64, 48);
      }
    }
    thumb.appendChild(tc);
    l._thumbCanvas = tc;

    const nameEl = document.createElement('span');
    nameEl.className = 'layer-name';
    nameEl.textContent = l.name;

    item.appendChild(vis);
    item.appendChild(thumb);
    item.appendChild(nameEl);

    // Double-click to rename the layer
    item.addEventListener('dblclick', e => {
      if (e.target.closest('.layer-vis-btn') || e.target.closest('.layer-link-btn')) return;
      e.stopPropagation();
      startRename(l, nameEl, item);
    });

    // Add blend mode badge if not normal
    const currentBlend = l.blendMode || 'source-over';
    if (currentBlend !== 'source-over') {
      const badge = document.createElement('span');
      badge.className = 'layer-blend-badge';
      badge.textContent = getBlendModeLabel(currentBlend);
      item.appendChild(badge);
    }

    if (l.isVideo) {
      const linkBtn = document.createElement('button');
      linkBtn.className = 'layer-link-btn' + (l.videoOffline ? ' offline' : '');
      linkBtn.title = l.videoOffline ? 'Reconectar vídeo offline (localizar arquivo)' : 'Alterar arquivo de vídeo';
      linkBtn.innerHTML = l.videoOffline ? '⚠️ Reconectar' : '🔗 Link';
      linkBtn.style.cssText = `
        background: none;
        border: none;
        color: ${l.videoOffline ? 'var(--danger, #f87171)' : 'var(--text-secondary, #9090b8)'};
        font-family: var(--font, sans-serif);
        font-size: 10px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
        transition: color 0.15s, background-color 0.15s;
      `;
      linkBtn.addEventListener('mouseenter', () => {
        linkBtn.style.backgroundColor = 'rgba(255,255,255,0.06)';
        if (!l.videoOffline) linkBtn.style.color = 'var(--accent, #a78bfa)';
      });
      linkBtn.addEventListener('mouseleave', () => {
        linkBtn.style.backgroundColor = 'transparent';
        linkBtn.style.color = l.videoOffline ? 'var(--danger, #f87171)' : 'var(--text-secondary, #9090b8)';
      });
      linkBtn.addEventListener('click', e => {
        e.stopPropagation();
        reconnectVideoLayer(l);
      });
      item.appendChild(linkBtn);
    }
    item.addEventListener('click', () => {
      if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) {
        bakeLassoSelection();
      }
      activeLayerIdx = i;
      updateLayerOpacitySlider();
      renderLayerPanel();
      renderTimeline();
    });
    item.addEventListener('contextmenu', e => {
      e.preventDefault();
      if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) {
        bakeLassoSelection();
      }
      activeLayerIdx = i;
      updateLayerOpacitySlider();
      renderLayerPanel();
      renderTimeline();
      showLayerContextMenu(e, i);
    });
    layersList.appendChild(item);
  });
  updateLayerOpacitySlider();
}

function startRename(layer, nameEl, item) {
  const inp = document.createElement('input');
  inp.className = 'layer-name-input';
  inp.value = layer.name;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => {
    layer.name = inp.value.trim() || layer.name;
    renderLayerPanel();
    renderTimeline();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = layer.name; inp.blur(); } });
}

function updateLayerThumbs() {
  layers.forEach(l => {
    if (l._thumbCanvas) {
      const tc = l._thumbCanvas.getContext('2d');
      tc.clearRect(0, 0, 64, 48);
      if (l.isVideo && l.video) {
        if (!l.videoOffline && l.video.readyState >= 2) {
          try {
            tc.drawImage(l.video, 0, 0, canvasW, canvasH, 0, 0, 64, 48);
          } catch (e) {
            tc.fillStyle = '#222';
            tc.fillRect(0, 0, 64, 48);
          }
        } else {
          tc.fillStyle = '#2a1a1a';
          tc.fillRect(0, 0, 64, 48);
          tc.fillStyle = '#f87171';
          tc.font = 'bold 9px sans-serif';
          tc.textAlign = 'center';
          tc.textBaseline = 'middle';
          tc.fillText('OFFLINE', 32, 24);
        }
      } else {
        const activeFrame = l.frames[state.currentFrame];
        if (activeFrame && activeFrame.canvas) {
          tc.drawImage(activeFrame.canvas, 0, 0, canvasW, canvasH, 0, 0, 64, 48);
        }
      }
    }
  });
}

function updateLayerOpacitySlider() {
  const l = layers[activeLayerIdx];
  if (!l) return;
  const slider = document.getElementById('layer-opacity');
  const val    = document.getElementById('layer-opacity-val');
  slider.value = Math.round(l.opacity * 100);
  val.textContent = slider.value + '%';
}

document.getElementById('layer-opacity').addEventListener('input', e => {
  const l = layers[activeLayerIdx];
  if (!l) return;
  l.opacity = parseInt(e.target.value) / 100;
  document.getElementById('layer-opacity-val').textContent = e.target.value + '%';
  compositeAll();
});
document.getElementById('layer-opacity').addEventListener('pointerup', () => document.getElementById('layer-opacity').blur());

document.getElementById('btn-add-layer').addEventListener('click', () => addLayer());
document.getElementById('btn-merge-layer').addEventListener('click', () => mergeActiveLayerDown());
document.getElementById('btn-del-layer').addEventListener('click', () => deleteActiveLayer());
document.getElementById('btn-layer-up').addEventListener('click',   () => moveActiveLayer(-1));
document.getElementById('btn-layer-down').addEventListener('click', () => moveActiveLayer(1));

// ─── Timeline Manager ───────────────────────────────────────────
function setCurrentFrame(f) {
  const targetFrame = Math.min(Math.max(0, f), state.totalFrames - 1);
  if (targetFrame === state.currentFrame) return;

  if (state.isPlaying) {
    if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) {
      bakeLassoSelection();
    }
    state.currentFrame = targetFrame;
    compositeAll();
    renderTimeline();
    renderLayerPanel();
    return;
  }

  if (state.lassoActive && state.lassoSelectionCanvas && !state.isPreservingSelection) {
    const savedMask = state.selectionMask;
    const savedPath = state.lassoPath;
    const savedPaths = state.lassoPaths;
    const savedBBox = state.lassoBoundingBox;
    
    state.isPreservingSelection = true;
    bakeLassoSelection();
    
    state.currentFrame = targetFrame;
    
    state.lassoActive = true;
    state.lassoPath = savedPath;
    state.lassoPaths = savedPaths;
    state.lassoBoundingBox = savedBBox;
    
    extractLassoSelection(savedMask);
    drawLassoSelectionOutline();
    state.isPreservingSelection = false;
    compositeAll();
    renderTimeline();
    renderLayerPanel();
  } else {
    state.currentFrame = targetFrame;
    compositeAll();
    renderTimeline();
    renderLayerPanel();
  }
}

function changeActiveLayerPreservingSelection(newIdx, newFrame = null) {
  if (newIdx === activeLayerIdx && (newFrame === null || newFrame === state.currentFrame)) {
    if (newFrame !== null) setCurrentFrame(newFrame);
    return;
  }

  const layerChanged = (newIdx !== activeLayerIdx);
  const frameChanged = (newFrame !== null && newFrame !== state.currentFrame);
  
  if (state.lassoActive && state.lassoSelectionCanvas && (layerChanged || frameChanged)) {
    const savedMask = state.selectionMask;
    const savedPath = state.lassoPath;
    const savedPaths = state.lassoPaths;
    const savedBBox = state.lassoBoundingBox;
    
    state.isPreservingSelection = true;
    bakeLassoSelection();
    
    if (layerChanged) activeLayerIdx = newIdx;
    if (frameChanged) setCurrentFrame(newFrame);
    
    state.lassoActive = true;
    state.lassoPath = savedPath;
    state.lassoPaths = savedPaths;
    state.lassoBoundingBox = savedBBox;
    
    extractLassoSelection(savedMask);
    drawLassoSelectionOutline();
    state.isPreservingSelection = false;
    compositeAll();
  } else {
    if (layerChanged) activeLayerIdx = newIdx;
    if (frameChanged) setCurrentFrame(newFrame);
    compositeAll();
  }
  
  updateLayerOpacitySlider();
  renderLayerPanel();
  renderTimeline();
}

function renderTimeline() {
  const layersListContainer = document.getElementById('timeline-layers-list');
  const gridRowsContainer   = document.getElementById('timeline-grid-rows');
  const rulerContainer      = document.getElementById('timeline-grid-ruler');
  const playhead            = document.getElementById('timeline-playhead');

  if (!layersListContainer || !gridRowsContainer || !rulerContainer || !playhead) return;

  layersListContainer.innerHTML = '';
  gridRowsContainer.innerHTML   = '';
  rulerContainer.innerHTML      = '';

  // 0. Prepend header row with add/delete/move layer buttons to align with ruler tick
  const headerRow = document.createElement('div');
  headerRow.className = 'timeline-layers-header';
  
  const upBtn = document.createElement('button');
  upBtn.className = 'layer-icon-btn';
  upBtn.id = 'btn-timeline-layer-up';
  upBtn.title = 'Mover camada acima';
  upBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="18 15 12 9 6 15" /></svg>`;
  upBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moveActiveLayer(-1);
  });

  const downBtn = document.createElement('button');
  downBtn.className = 'layer-icon-btn';
  downBtn.id = 'btn-timeline-layer-down';
  downBtn.title = 'Mover camada abaixo';
  downBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9" /></svg>`;
  downBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moveActiveLayer(1);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'layer-icon-btn';
  addBtn.id = 'btn-timeline-add-layer';
  addBtn.title = 'Nova camada de animação';
  addBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addLayer();
  });

  const mergeBtn = document.createElement('button');
  mergeBtn.className = 'layer-icon-btn';
  mergeBtn.id = 'btn-timeline-merge-layer';
  mergeBtn.title = 'Mesclar com a camada de baixo';
  mergeBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M19 12l-7 7-7-7" /><path d="M4 21h16" /></svg>`;
  mergeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mergeActiveLayerDown();
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'layer-icon-btn danger';
  delBtn.id = 'btn-timeline-del-layer';
  delBtn.title = 'Excluir camada selecionada';
  delBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteActiveLayer();
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'layer-icon-btn';
  clearBtn.id = 'btn-timeline-clear-layer';
  clearBtn.title = 'Limpar o canvas da camada selecionada';
  clearBtn.innerHTML = `<span class="layer-clear-icon" aria-hidden="true"></span>`;
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearActiveCanvas();
  });

  headerRow.appendChild(upBtn);
  headerRow.appendChild(downBtn);
  headerRow.appendChild(addBtn);
  headerRow.appendChild(mergeBtn);
  headerRow.appendChild(delBtn);
  headerRow.appendChild(clearBtn);
  layersListContainer.appendChild(headerRow);

  // 1. Render Ruler Ticks
  for (let f = 0; f < state.totalFrames; f++) {
    const tick = document.createElement('div');
    tick.className = 'timeline-ruler-tick';
    const displayNum = f + 1;
    if (displayNum === 1 || displayNum % 5 === 0) {
      tick.classList.add('five');
      tick.textContent = displayNum;
    }
    tick.addEventListener('click', () => setCurrentFrame(f));
    rulerContainer.appendChild(tick);
  }

  // 2. Render Layers list and tracks
  layers.forEach((l, idx) => {
    // Layer row label
    const layerRow = document.createElement('div');
    layerRow.className = 'timeline-layer-row' + (idx === activeLayerIdx ? ' active' : '');
    layerRow.dataset.idx = idx;
    
    // Visibility toggle icon
    const visBtn = document.createElement('button');
    visBtn.className = 'layer-vis-btn' + (l.visible ? '' : ' hidden-layer');
    visBtn.style.marginRight = '4px';
    visBtn.innerHTML = l.visible
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    visBtn.addEventListener('click', e => {
      e.stopPropagation();
      l.visible = !l.visible;
      renderLayerPanel();
      renderTimeline();
      compositeAll();
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'timeline-layer-name';
    nameSpan.textContent = l.name;

    layerRow.appendChild(visBtn);
    layerRow.appendChild(nameSpan);

    // Add blend mode badge if not normal
    const currentBlend = l.blendMode || 'source-over';
    if (currentBlend !== 'source-over') {
      const badge = document.createElement('span');
      badge.className = 'layer-blend-badge';
      badge.textContent = getBlendModeLabel(currentBlend);
      layerRow.appendChild(badge);
    }

    if (l.isVideo) {
      const linkBtn = document.createElement('button');
      linkBtn.className = 'layer-link-btn' + (l.videoOffline ? ' offline' : '');
      linkBtn.title = l.videoOffline ? 'Reconectar vídeo offline (localizar arquivo)' : 'Alterar arquivo de vídeo';
      linkBtn.innerHTML = l.videoOffline ? '⚠️ Reconectar' : '🔗 Link';
      linkBtn.style.cssText = `
        background: none;
        border: none;
        color: ${l.videoOffline ? 'var(--danger, #f87171)' : 'var(--text-secondary, #9090b8)'};
        font-family: var(--font, sans-serif);
        font-size: 10px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
        transition: color 0.15s, background-color 0.15s;
      `;
      linkBtn.addEventListener('mouseenter', () => {
        linkBtn.style.backgroundColor = 'rgba(255,255,255,0.06)';
        if (!l.videoOffline) linkBtn.style.color = 'var(--accent, #a78bfa)';
      });
      linkBtn.addEventListener('mouseleave', () => {
        linkBtn.style.backgroundColor = 'transparent';
        linkBtn.style.color = l.videoOffline ? 'var(--danger, #f87171)' : 'var(--text-secondary, #9090b8)';
      });
      linkBtn.addEventListener('click', e => {
        e.stopPropagation();
        reconnectVideoLayer(l);
      });
      layerRow.appendChild(linkBtn);
    }

    layerRow.addEventListener('click', () => {
      changeActiveLayerPreservingSelection(idx);
    });

    layerRow.addEventListener('contextmenu', e => {
      e.preventDefault();
      changeActiveLayerPreservingSelection(idx);
      showLayerContextMenu(e, idx);
    });

    // Double-click to rename the layer
    layerRow.addEventListener('dblclick', e => {
      if (e.target.closest('.layer-vis-btn') || e.target.closest('.layer-link-btn')) return;
      e.stopPropagation();
      startRename(l, nameSpan, layerRow);
    });
    layersListContainer.appendChild(layerRow);

    // Grid track cells
    const track = document.createElement('div');
    track.className = 'timeline-track';
    track.dataset.layerIdx = idx;

    for (let f = 0; f < state.totalFrames; f++) {
      const cell = document.createElement('div');
      cell.className = 'timeline-cell';
      if (f === state.currentFrame) {
        cell.classList.add('active-frame');
      }

      if (l.isVideo) {
        // Video layer: check if frame is within video duration
        const duration = l.videoOffline ? (l.videoDuration || 0) : (l.video ? l.video.duration : 0);
        const videoFramesCount = Math.ceil(duration * state.fps);
        if (f < videoFramesCount) {
          cell.classList.add('video-frame-span');
          if (l.videoOffline) {
            cell.style.backgroundColor = 'rgba(239, 68, 68, 0.12)';
            cell.style.borderTopColor = 'rgba(239, 68, 68, 0.25)';
            cell.style.borderBottomColor = 'rgba(239, 68, 68, 0.25)';
          }
          if (f === 0) {
            const tag = document.createElement('span');
            tag.className = 'timeline-video-tag';
            if (l.videoOffline) tag.style.color = '#f87171';
            tag.textContent = (l.videoOffline ? '⚠️ ' : '🎬 ') + l.name.substring(0, 10);
            cell.appendChild(tag);
          }
        } else {
          cell.classList.add('video-frame-empty');
        }
      } else {
        // Standard layer: draw keyframe dot or empty cell
        const frameData = l.frames[f];
        if (frameData && frameData.isKeyframe) {
          const dot = document.createElement('div');
          dot.className = 'keyframe-dot';
          cell.appendChild(dot);
        } else {
          cell.classList.add('empty-keyframe');
        }
      }

      cell.addEventListener('click', () => {
        if (l.isVideo) {
          const duration = l.videoOffline ? (l.videoDuration || 0) : (l.video ? l.video.duration : 0);
          const videoFramesCount = Math.ceil(duration * state.fps);
          if (f >= videoFramesCount) return;
        }
        changeActiveLayerPreservingSelection(idx, f);
      });

      if (!l.isVideo) {
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          changeActiveLayerPreservingSelection(idx, f);
          showTimelineContextMenu(e, idx, f);
        });
      }

      track.appendChild(cell);
    }
    gridRowsContainer.appendChild(track);
  });

  // 3. Sync scroll between layers list and grid rows
  const gridOuter = document.getElementById('timeline-grid-outer');
  if (gridOuter) {
    const layersListContainer = document.getElementById('timeline-layers-list');
    layersListContainer.scrollTop = gridOuter.scrollTop;
  }

  // 4. Update Playhead position
  playhead.style.left = (state.currentFrame * 20) + 'px';

  // 5. Update indicators
  document.getElementById('current-frame-indicator').textContent = state.currentFrame + 1;
  document.getElementById('total-frames-indicator').textContent = state.totalFrames;

  // 6. Keep the total-frames input in sync
  const tfInput = document.getElementById('timeline-total-frames');
  if (tfInput) tfInput.value = state.totalFrames;
}

let playInterval = null;

function togglePlay() {
  if (state.isPlaying) {
    pause();
  } else {
    play();
  }
}

function play() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  document.getElementById('btn-play').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>`;
  document.getElementById('btn-play').title = 'Pausar animação';

  // Play all active, visible video layers immediately
  layers.forEach(l => {
    if (l.isVideo && l.video && l.visible && !l.videoOffline) {
      l.video.play().catch(() => {});
    }
  });

  const intervalTime = 1000 / state.fps;
  playInterval = setInterval(() => {
    let nextFrame = state.currentFrame + 1;
    if (nextFrame >= state.totalFrames) {
      if (state.loop) {
        nextFrame = 0;
        // Loop video playback
        layers.forEach(l => {
          if (l.isVideo && l.video && l.visible && !l.videoOffline) {
            l.video.currentTime = 0;
          }
        });
      } else {
        pause();
        return;
      }
    }
    setCurrentFrame(nextFrame);
  }, intervalTime);
}

function pause() {
  if (!state.isPlaying) return;
  state.isPlaying = false;
  clearInterval(playInterval);
  playInterval = null;
  document.getElementById('btn-play').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  document.getElementById('btn-play').title = 'Iniciar animação';

  // Pause all video layers
  layers.forEach(l => {
    if (l.isVideo && l.video) {
      l.video.pause();
    }
  });

  renderTimeline();
}

// ─── Timeline Action Listeners ──────────────────────────────────
document.getElementById('btn-play').addEventListener('click', togglePlay);

const fpsInput = document.getElementById('timeline-fps');
fpsInput.addEventListener('change', () => {
  state.fps = Math.min(Math.max(1, parseInt(fpsInput.value) || 12), 60);
  fpsInput.value = state.fps;
  if (state.isPlaying) {
    pause();
    play();
  }
});
fpsInput.addEventListener('keydown', e => e.stopPropagation());

const loopCheck = document.getElementById('timeline-loop');
loopCheck.addEventListener('change', () => {
  state.loop = loopCheck.checked;
});

const onionBtn = document.getElementById('btn-onion');
onionBtn.addEventListener('click', () => {
  state.onionSkin = !state.onionSkin;
  onionBtn.classList.toggle('active', state.onionSkin);
  compositeAll();
});

document.getElementById('btn-add-frame-col').addEventListener('click', () => {
  state.totalFrames++;
  layers.forEach(l => {
    if (!l.isVideo) l.frames.push(createFrameData());
  });
  renderTimeline();
});

document.getElementById('btn-del-frame-col').addEventListener('click', () => {
  if (state.totalFrames <= 1) return;
  state.totalFrames--;
  layers.forEach(l => {
    if (!l.isVideo) l.frames.pop();
  });
  if (state.currentFrame >= state.totalFrames) {
    setCurrentFrame(state.totalFrames - 1);
  } else {
    renderTimeline();
  }
});

// ─── Total Frames input ───────────────────────────────────────────
const totalFramesInput = document.getElementById('timeline-total-frames');

function applyTotalFrames(newTotal) {
  newTotal = Math.max(1, Math.min(9999, newTotal));
  if (newTotal === state.totalFrames) return;

  if (newTotal > state.totalFrames) {
    // Add blank frames
    const toAdd = newTotal - state.totalFrames;
    layers.forEach(l => {
      if (!l.isVideo) {
        for (let i = 0; i < toAdd; i++) l.frames.push(createFrameData());
      }
    });
  } else {
    // Trim frames
    layers.forEach(l => {
      if (!l.isVideo) l.frames.splice(newTotal);
    });
    if (state.currentFrame >= newTotal) {
      state.currentFrame = newTotal - 1;
    }
  }

  state.totalFrames = newTotal;
  totalFramesInput.value = newTotal;
  renderTimeline();
  compositeAll();
}

totalFramesInput.addEventListener('change', () => {
  applyTotalFrames(parseInt(totalFramesInput.value) || 1);
});
totalFramesInput.addEventListener('keydown', e => {
  e.stopPropagation(); // prevent shortcut conflicts while typing
  if (e.key === 'Enter') { totalFramesInput.blur(); }
});
// Keep input in sync when + / - buttons are used
const _origAddFrame = document.getElementById('btn-add-frame-col');
_origAddFrame.addEventListener('click', () => {
  totalFramesInput.value = state.totalFrames;
});
document.getElementById('btn-del-frame-col').addEventListener('click', () => {
  totalFramesInput.value = state.totalFrames;
});

function initCanvas(w, h, bgColor = '#ffffff') {
  canvasW = w; canvasH = h;
  mainCanvas.width    = w; mainCanvas.height   = h;
  previewCanvas.width = w; previewCanvas.height = h;
  state.bgColor = bgColor;

  // Reset layers to one fresh transparent layer
  layers = []; layerIdCount = 1; activeLayerIdx = 0;
  layers.push(createLayerData('Layer 1'));

  compositeAll();
  centerCanvas();
  saveHistory();
  renderLayerPanel();
  renderTimeline();
  document.getElementById('canvas-size-display').textContent = `${w} × ${h} px`;
}

function centerCanvas() {
  const area = container.getBoundingClientRect();
  const fitScale = Math.min(
    (area.width  - 80) / canvasW,
    (area.height - 80) / canvasH,
    1
  );
  state.zoom = fitScale;
  state.panX = (area.width  - canvasW * fitScale) / 2;
  state.panY = (area.height - canvasH * fitScale) / 2;
  applyTransform();
}

function applyTransform() {
  const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  mainCanvas.style.transform   = t;
  previewCanvas.style.transform = t;
  
  // Real-time sync of video layers during pan/zoom
  for (const l of layers) {
    if (l.isVideo && l.video) {
      l.video.style.transform = t;
    }
  }

  document.getElementById('zoom-indicator').textContent =
    Math.round(state.zoom * 100) + '%';
}

// ─── Coordinate Helpers ──────────────────────────────────────────
function clientToCanvas(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  let x = (clientX - rect.left - state.panX) / state.zoom;
  let y = (clientY - rect.top  - state.panY) / state.zoom;
  
  const aaCheckbox = document.getElementById('anti-alias-toggle');
  const antiAlias = aaCheckbox ? aaCheckbox.checked : true;
  
  if (!antiAlias) {
    x = Math.floor(x) + 0.5;
    y = Math.floor(y) + 0.5;
  }
  
  return { x, y };
}

// ─── History (Undo/Redo) ─────────────────────────────────────────
function snapshotLayers() {
  return layers.map(l => {
    if (l.isVideo) {
      return {
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        blendMode: l.blendMode || 'source-over',
        isVideo: true,
        videoSrc: l.video ? l.video.src : '',
        videoPath: l.videoPath || '',
        videoCacheId: l.videoCacheId || '',
        videoDuration: l.videoOffline ? (l.videoDuration || 0) : (l.video ? l.video.duration : 0),
        videoOffline: !!l.videoOffline
      };
    }
    return {
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode || 'source-over',
      frames: l.frames.map(f => {
        if (f.canvas) {
          syncBackingCanvas(f);
        }
        return {
          isKeyframe: f.isKeyframe,
          data: (f.isKeyframe && f.ctx) ? f.ctx.getImageData(0, 0, canvasW, canvasH) : null,
          offsetX: f.offsetX || 0,
          offsetY: f.offsetY || 0,
          backingData: (f.isKeyframe && f.backingCanvas) ? f.backingCanvas.getContext('2d').getImageData(0, 0, canvasW * 3, canvasH * 3) : null
        };
      })
    };
  });
}

function restoreSnapshot(snap) {
  const layersData = Array.isArray(snap) ? snap : snap.layers;
  const currentActiveIdx = activeLayerIdx;

  // Preserve the current visibility status of each layer by ID
  const currentVisibility = {};
  layers.forEach(l => {
    currentVisibility[l.id] = l.visible;
  });

  layers = layersData.map(s => {
    // Keep current visibility if the layer exists in current state, else use snapshot
    const isVisible = currentVisibility[s.id] !== undefined ? currentVisibility[s.id] : s.visible;

    if (s.isVideo) {
      const existing = layers.find(l => l.id === s.id && l.isVideo);
      let video;
      if (existing) {
        video = existing.video;
        if (s.videoSrc && video.src !== s.videoSrc) {
          video.src = s.videoSrc;
        }
      } else {
        video = document.createElement('video');
        video.src = s.videoSrc || s.videoPath || '';
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
      }
      const restoredLayer = {
        id: s.id,
        name: s.name,
        visible: isVisible,
        opacity: s.opacity,
        blendMode: s.blendMode || 'source-over',
        isVideo: true,
        video: video,
        videoPath: s.videoPath || '',
        videoCacheId: s.videoCacheId || '',
        videoDuration: s.videoDuration || 0,
        videoOffline: !!s.videoOffline,
        frames: []
      };

      // Hook up error event for safety
      if (!restoredLayer.videoOffline) {
        video.addEventListener('error', () => {
          restoredLayer.videoOffline = true;
          renderLayerPanel();
          renderTimeline();
        }, { once: true });
      }

      return restoredLayer;
    }
    const restoredFrames = s.frames.map(sf => {
      const fd = createFrameData();
      fd.isKeyframe = sf.isKeyframe;
      fd.offsetX = sf.offsetX || 0;
      fd.offsetY = sf.offsetY || 0;
      if (sf.data) {
        const c = document.createElement('canvas');
        c.width = canvasW;
        c.height = canvasH;
        fd.canvas = c;
        fd.ctx = c.getContext('2d');
        fd.ctx.putImageData(sf.data, 0, 0);
      }
      if (sf.backingData) {
        const bc = document.createElement('canvas');
        bc.width = canvasW * 3;
        bc.height = canvasH * 3;
        const bctx = bc.getContext('2d');
        bctx.putImageData(sf.backingData, 0, 0);
        fd.backingCanvas = bc;
      }
      return fd;
    });
    return {
      id: s.id,
      name: s.name,
      visible: isVisible,
      opacity: s.opacity,
      blendMode: s.blendMode || 'source-over',
      frames: restoredFrames
    };
  });
  
  activeLayerIdx = Math.max(0, Math.min(currentActiveIdx, layers.length - 1));
  renderLayerPanel();
  renderTimeline();
  compositeAll();
}

function saveHistory() {
  state.history.push({
    layers: snapshotLayers(),
    activeLayerIdx: activeLayerIdx
  });
  if (state.history.length > state.maxHistory) state.history.shift();
  state.redoStack = [];
}

function flashUndoRedo(type) {
  const indicator = document.getElementById('zoom-indicator');
  const orig = indicator.textContent;
  indicator.textContent = type === 'undo' ? '↩ Undo' : '↪ Redo';
  indicator.style.color = type === 'undo' ? '#f87171' : '#4ade80';
  setTimeout(() => {
    indicator.textContent = Math.round(state.zoom * 100) + '%';
    indicator.style.color = '';
  }, 500);
}

// Discard the floating lasso selection WITHOUT baking it back.
// Used by undo/redo: the snapshot restore will put the pixels back correctly.
function discardLassoSelection() {
  // If there are floating pixels (extracted but not yet baked), bake them back
  // so that undo/redo can properly restore the pixel state.
  if (state.lassoSelectionCanvas && state.lassoBoundingBox) {
    const lctx = getLCtx();
    if (lctx) {
      markActiveFrameAsKeyframe();
      lctx.save();
      lctx.globalCompositeOperation = 'source-over';
      lctx.imageSmoothingEnabled = isAntiAliasingEnabled();
      const cx = state.lassoBoundingBox.x + (state.lassoCurrentOffset.x||0) + state.lassoBoundingBox.w / 2;
      const cy = state.lassoBoundingBox.y + (state.lassoCurrentOffset.y||0) + state.lassoBoundingBox.h / 2;
      lctx.translate(cx, cy);
      lctx.rotate(state.lassoRotation || 0);
      lctx.scale(state.lassoScaleX || 1, state.lassoScaleY || 1);
      lctx.translate(-cx, -cy);
      lctx.drawImage(
        state.lassoSelectionCanvas,
        state.lassoBoundingBox.x + (state.lassoCurrentOffset.x||0),
        state.lassoBoundingBox.y + (state.lassoCurrentOffset.y||0)
      );
      lctx.restore();
    }
  }
  state.lassoActive          = false;
  state.lassoPath            = [];
  state.lassoPaths           = [];
  state.lassoSelectionCanvas = null;
  state.lassoMaskCanvas      = null;
  state.lassoBoundingBox     = null;
  state.lassoCurrentOffset   = { x: 0, y: 0 };
  state.lassoPrevOffset      = { x: 0, y: 0 };
  state.lassoStartOffset     = { x: 0, y: 0 };
  state.lassoDragged         = false;
  state.lassoDragStart       = null;
  state.lassoCutPending      = false;
  state.lassoTransformMode   = false;
  state.selectionMask        = null;
  pctx.clearRect(0, 0, canvasW, canvasH);
}

// Used ONLY by undo/redo — clears lasso state WITHOUT baking floating pixels.
// The snapshot restore will put the correct pixel data back, so baking here
// would double-draw and corrupt the layer.
function _clearLassoStateOnly() {
  state.lassoActive          = false;
  state.lassoPath            = [];
  state.lassoPaths           = [];
  state.lassoSelectionCanvas = null;
  state.lassoMaskCanvas      = null;
  state.lassoBoundingBox     = null;
  state.lassoCurrentOffset   = { x: 0, y: 0 };
  state.lassoPrevOffset      = { x: 0, y: 0 };
  state.lassoStartOffset     = { x: 0, y: 0 };
  state.lassoDragged         = false;
  state.lassoDragStart       = null;
  state.lassoCutPending      = false;
  state.lassoTransformMode   = false;
  state.selectionMask        = null;
  pctx.clearRect(0, 0, canvasW, canvasH);
}

function undo() {
  if (state.history.length < 2) return;

  if (state.lassoActive) {
    if (state.lassoSelectionCanvas) {
      // Floating mode: pixels were extracted to a canvas.
      // Clear ALL lasso state — the snapshot will restore the correct pixel data.
      _clearLassoStateOnly();
    }
    // Stencil mode (lassoSelectionCanvas == null): the selection is just a
    // clipping mask while painting. Keep lasso state; only restore pixel data.
    // No clear needed — the selection outline and mask remain active.
  }

  state.shiftAnchor = null;
  clearPreview();
  state.redoStack.push(state.history.pop());
  restoreSnapshot(state.history[state.history.length - 1]);

  // Re-draw the selection outline after snapshot restore (stencil mode)
  if (state.lassoActive && !state.lassoSelectionCanvas) {
    drawLassoSelectionOutline();
  }

  flashUndoRedo('undo');
}

function redo() {
  if (!state.redoStack.length) return;

  if (state.lassoActive) {
    if (state.lassoSelectionCanvas) {
      // Floating mode: clear lasso state so the snapshot can restore correctly.
      _clearLassoStateOnly();
    }
    // Stencil mode: keep the selection active, just restore the pixel data.
  }

  state.shiftAnchor = null;
  clearPreview();
  const snap = state.redoStack.pop();
  state.history.push(snap);
  restoreSnapshot(snap);

  // Re-draw the selection outline after snapshot restore (stencil mode)
  if (state.lassoActive && !state.lassoSelectionCanvas) {
    drawLassoSelectionOutline();
  }

  flashUndoRedo('redo');
}

// ─── Drawing Helpers ─────────────────────────────────────────────
function getDrawColor(alpha = state.opacity) {
  const hex = state.fgColor;
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function applySelectionClip(ctx) {
  if (!state.lassoActive || !state.lassoPaths || state.lassoPaths.length === 0) return;
  
  ctx.beginPath();
  state.lassoPaths.forEach(path => {
    if (!path || path.length < 2) return;
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(path[i].x, path[i].y);
    }
    ctx.closePath();
  });
  ctx.clip("evenodd");
  ctx.beginPath();
}

function updateSelectionMask(providedMask) {
  if (!state.lassoActive) {
    state.selectionMask = null;
    return;
  }
  
  if (providedMask) {
    state.selectionMask = providedMask;
    return;
  }
  
  const mask = new Uint8Array(canvasW * canvasH);
  if (!state.lassoBoundingBox || !state.lassoMaskCanvas) {
    state.selectionMask = null;
    return;
  }
  
  const bbox = state.lassoBoundingBox;
  const w = bbox.w;
  const h = bbox.h;
  const maskCtx = state.lassoMaskCanvas.getContext('2d');
  const imgData = maskCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (x + y * w) * 4;
      if (data[idx + 3] > 128) {
        const cx = x + bbox.x;
        const cy = y + bbox.y;
        if (cx >= 0 && cx < canvasW && cy >= 0 && cy < canvasH) {
          mask[cx + cy * canvasW] = 1;
        }
      }
    }
  }
  state.selectionMask = mask;
}

function bakeFloatingSelectionOnly() {
  if (!state.lassoActive || !state.lassoSelectionCanvas) return;
  const lctx = getLCtx();
  if (lctx) {
    markActiveFrameAsKeyframe();
    lctx.save();
    lctx.globalCompositeOperation = 'source-over';
    lctx.imageSmoothingEnabled = isAntiAliasingEnabled();
    
    const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
    const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
    lctx.translate(cx, cy);
    lctx.rotate(state.lassoRotation || 0);
    lctx.scale(state.lassoScaleX || 1, state.lassoScaleY || 1);
    lctx.translate(-cx, -cy);

    lctx.drawImage(
      state.lassoSelectionCanvas,
      state.lassoBoundingBox.x + state.lassoCurrentOffset.x,
      state.lassoBoundingBox.y + state.lassoCurrentOffset.y
    );
    lctx.restore();
  }
  
  // Transform the vector paths by the drag translation/rotation/scale
  if (state.lassoPaths && state.lassoPaths.length > 0) {
    const ox = state.lassoCurrentOffset.x;
    const oy = state.lassoCurrentOffset.y;
    const rotation = state.lassoRotation || 0;
    const scaleX = state.lassoScaleX || 1;
    const scaleY = state.lassoScaleY || 1;
    
    const cx = state.lassoBoundingBox.x + ox + state.lassoBoundingBox.w / 2;
    const cy = state.lassoBoundingBox.y + oy + state.lassoBoundingBox.h / 2;
    
    state.lassoPaths = state.lassoPaths.map(path => {
      return path.map(p => {
        let lx = p.x + ox - cx;
        let ly = p.y + oy - cy;
        let rx = lx * scaleX;
        let ry = ly * scaleY;
        let nx = rx * Math.cos(rotation) - ry * Math.sin(rotation) + cx;
        let ny = rx * Math.sin(rotation) + ry * Math.cos(rotation) + cy;
        return { x: nx, y: ny };
      });
    });
    
    // Recalculate bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    state.lassoPaths.forEach(path => {
      path.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
    });
    minX = Math.floor(Math.max(0, minX));
    maxX = Math.ceil(Math.min(canvasW, maxX));
    minY = Math.floor(Math.max(0, minY));
    maxY = Math.ceil(Math.min(canvasH, maxY));
    state.lassoBoundingBox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    
    // Regenerate lassoMaskCanvas
    const w = state.lassoBoundingBox.w;
    const h = state.lassoBoundingBox.h;
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w || 1; maskCanvas.height = h || 1;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.fillStyle = 'white';
    maskCtx.beginPath();
    state.lassoPaths.forEach(path => {
      if (!path || path.length < 2) return;
      maskCtx.moveTo(path[0].x - state.lassoBoundingBox.x, path[0].y - state.lassoBoundingBox.y);
      for (let i = 1; i < path.length; i++) {
        maskCtx.lineTo(path[i].x - state.lassoBoundingBox.x, path[i].y - state.lassoBoundingBox.y);
      }
      maskCtx.closePath();
    });
    maskCtx.fill("evenodd");
    
    state.lassoPaths.forEach(path => {
      if (!path) return;
      for (let i = 0; i < path.length; i++) {
        maskCtx.fillRect(path[i].x - state.lassoBoundingBox.x, path[i].y - state.lassoBoundingBox.y, 1, 1);
      }
    });
    
    state.lassoMaskCanvas = maskCanvas;
  }
  
  state.lassoSelectionCanvas = null;
  state.lassoTransformMode  = false;
  state.lassoCurrentOffset  = { x: 0, y: 0 };
  state.lassoPrevOffset     = { x: 0, y: 0 };
  state.lassoStartOffset    = { x: 0, y: 0 };
  state.lassoDragged        = false;
  state.lassoCutPending     = false;
  
  // Re-generate the Uint8Array mask to keep everything fully synced
  updateSelectionMask();
  
  const btn = document.getElementById('btn-lasso-transform');
  if (btn) {
    btn.classList.add('hidden');
    btn.classList.remove('active');
  }
  
  pctx.clearRect(0, 0, canvasW, canvasH);
  if (lctx) {
    compositeAll();
    saveHistory();
  }
}

function updateBrushTip() {
  if (!state.brushTipCanvas) {
    state.brushTipCanvas = document.createElement('canvas');
  }
  const canvas = state.brushTipCanvas;
  const size = Math.max(1, Math.round(state.brushSize));
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  
  const radius = size / 2;
  let colorHex = state.fgColor || '#000000';
  if (colorHex.charAt(0) !== '#') colorHex = '#000000';
  let r = 0, g = 0, b = 0;
  if (colorHex.length === 7) {
    r = parseInt(colorHex.slice(1,3), 16) || 0;
    g = parseInt(colorHex.slice(3,5), 16) || 0;
    b = parseInt(colorHex.slice(5,7), 16) || 0;
  } else if (colorHex.length === 4) {
    r = parseInt(colorHex.charAt(1) + colorHex.charAt(1), 16) || 0;
    g = parseInt(colorHex.charAt(2) + colorHex.charAt(2), 16) || 0;
    b = parseInt(colorHex.charAt(3) + colorHex.charAt(3), 16) || 0;
  }
  
  const hardness = state.brushHardness !== undefined ? state.brushHardness : 100;
  const hRatio = hardness / 100;
  
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      const alpha = brushMask(dx, dy, radius, hRatio);
      
      const idx = (x + y * size) * 4;
      data[idx]     = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function alphaWeightedBoxBlur(imgData, size, radius) {
  const data = imgData.data;
  const width = size;
  const height = size;
  const outData = new Uint8ClampedArray(data.length);
  
  const passes = 2;
  let currentData = data;
  let nextData = outData;
  
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
        
        for (let ky = -radius; ky <= radius; ky++) {
          const ny = y + ky;
          if (ny < 0 || ny >= height) continue;
          
          for (let kx = -radius; kx <= radius; kx++) {
            const nx = x + kx;
            if (nx < 0 || nx >= width) continue;
            
            const idx = (nx + ny * width) * 4;
            const r = currentData[idx];
            const g = currentData[idx+1];
            const b = currentData[idx+2];
            const a = currentData[idx+3];
            
            sumR += r * a;
            sumG += g * a;
            sumB += b * a;
            sumA += a;
            count++;
          }
        }
        
        const idx = (x + y * width) * 4;
        if (sumA > 0) {
          nextData[idx]   = Math.round(sumR / sumA);
          nextData[idx+1] = Math.round(sumG / sumA);
          nextData[idx+2] = Math.round(sumB / sumA);
          nextData[idx+3] = Math.round(sumA / count);
        } else {
          nextData[idx]   = currentData[idx];
          nextData[idx+1] = currentData[idx+1];
          nextData[idx+2] = currentData[idx+2];
          nextData[idx+3] = 0;
        }
      }
    }
    const temp = currentData;
    currentData = nextData;
    nextData = temp;
  }
  
  if (currentData !== data) {
    data.set(currentData);
  }
}

function brushMask(dx, dy, radius, hardness) {
  const d = Math.sqrt(dx * dx + dy * dy);
  const t = d / radius;

  if (t >= 1) return 0;

  hardness = Math.max(0, Math.min(1, hardness));

  const aaCheckbox = document.getElementById('anti-alias-toggle');
  const antiAlias = aaCheckbox ? aaCheckbox.checked : true;

  if (antiAlias) {
    const minFeatherWidth = radius > 0 ? (1.0 / radius) : 1.0;
    const maxHardness = Math.max(0, 1.0 - minFeatherWidth);
    hardness = Math.min(hardness, maxHardness);
  }

  if (t <= hardness) return 1;

  const feather = (t - hardness) / (1 - hardness);

  // smoothstep falloff
  return 1 - feather * feather * (3 - 2 * feather);
}

function drawBrushStamp(ctx, cx, cy, radius, size, brushCanvas) {
  const rx = Math.round(cx - radius);
  const ry = Math.round(cy - radius);

  // Sync state.isAltDrawing with current event altKey to prevent stuck states
  if (state.tool === 'brush') {
    if (typeof window !== 'undefined' && window.event) {
      state.isAltDrawing = window.event.altKey;
    }
  }

  if (state.tool === 'brush' && state.isAltDrawing) {
    const blurRadius = state.brushBlurRadius || 5;
    const padding = blurRadius + 2;
    const capturedSize = size + 2 * padding;
    
    // Bounding box for capture (centered at cx, cy)
    const capX = Math.round(cx - radius - padding);
    const capY = Math.round(cy - radius - padding);
    
    if (isNaN(capX) || isNaN(capY)) return;
    
    if (!state.blurSrcCanvas) {
      state.blurSrcCanvas = document.createElement('canvas');
    }
    
    if (state.blurSrcCanvas.width !== capturedSize || state.blurSrcCanvas.height !== capturedSize) {
      state.blurSrcCanvas.width = capturedSize;
      state.blurSrcCanvas.height = capturedSize;
    }
    
    const srcCtx = state.blurSrcCanvas.getContext('2d', { willReadFrequently: true });
    
    let sx = capX;
    let sy = capY;
    let sw = capturedSize;
    let sh = capturedSize;
    
    let dx = 0;
    let dy = 0;
    let dw = capturedSize;
    let dh = capturedSize;
    
    const canvasW = ctx.canvas.width;
    const canvasH = ctx.canvas.height;
    
    if (sx < 0) { dx = -sx; dw += sx; sw += sx; sx = 0; }
    if (sy < 0) { dy = -sy; dh += sy; sh += sy; sy = 0; }
    if (sx + sw > canvasW) { const diff = (sx + sw) - canvasW; sw -= diff; dw -= diff; }
    if (sy + sh > canvasH) { const diff = (sy + sh) - canvasH; sh -= diff; dh -= diff; }
    
    if (sw <= 0 || sh <= 0) return; // Completely off-screen
    
    srcCtx.clearRect(0, 0, capturedSize, capturedSize);
    srcCtx.drawImage(ctx.canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    
    const imgData = srcCtx.getImageData(0, 0, capturedSize, capturedSize);
    const originalData = new Uint8ClampedArray(imgData.data);
    
    alphaWeightedBoxBlur(imgData, capturedSize, blurRadius);
    const blurredData = imgData.data;
    
    const strength = (state.brushBlurStrength !== undefined ? state.brushBlurStrength : 0.25) * (state.opacity !== undefined ? state.opacity : 1.0);
    const hardness = state.brushHardness !== undefined ? state.brushHardness : 100;
    
    for (let y = 0; y < capturedSize; y++) {
      for (let x = 0; x < capturedSize; x++) {
        const px = capX + x;
        const py = capY + y;
        
        let isSelected = true;
        if (state.lassoActive && state.selectionMask) {
          if (px >= 0 && py >= 0 && px < canvasW && py < canvasH) {
            isSelected = state.selectionMask[px + py * canvasW] === 1;
          } else {
            isSelected = false;
          }
        }
        
        let amount = 0;
        if (isSelected) {
          const d_x = px - cx + 0.5;
          const d_y = py - cy + 0.5;
          const mask = brushMask(d_x, d_y, radius, hardness / 100);
          amount = mask * strength;
        }
        
        const idx = (x + y * capturedSize) * 4;
        if (amount > 0) {
          blurredData[idx]   = originalData[idx]   * (1 - amount) + blurredData[idx]   * amount;
          blurredData[idx+1] = originalData[idx+1] * (1 - amount) + blurredData[idx+1] * amount;
          blurredData[idx+2] = originalData[idx+2] * (1 - amount) + blurredData[idx+2] * amount;
          blurredData[idx+3] = originalData[idx+3] * (1 - amount) + blurredData[idx+3] * amount;
        } else {
          blurredData[idx]   = originalData[idx];
          blurredData[idx+1] = originalData[idx+1];
          blurredData[idx+2] = originalData[idx+2];
          blurredData[idx+3] = originalData[idx+3];
        }
      }
    }
    
    ctx.putImageData(imgData, capX, capY);
  } else {
    ctx.drawImage(brushCanvas, rx, ry);
  }
}

function drawSoftBrushStroke(ctx, x0, y0, x1, y1) {
  if (!state.brushTipCanvas) {
    updateBrushTip();
  }
  const brushCanvas = state.brushTipCanvas;
  const size = state.brushSize;
  const radius = size / 2;
  
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  // Configurable spacing ensures smooth curves without "bumpy" circles
  const step = Math.max(1, size * (state.brushSpacing !== undefined ? state.brushSpacing : 0.15));
  const steps = Math.ceil(dist / step);
  
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = state.opacity;
  
  if (steps === 0) {
    drawBrushStamp(ctx, x0, y0, radius, size, brushCanvas);
  } else {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + dx * t;
      const cy = y0 + dy * t;
      drawBrushStamp(ctx, cx, cy, radius, size, brushCanvas);
    }
  }
  ctx.globalAlpha = prevAlpha;
}

function drawSoftBrushQuadratic(ctx, p0, cp, p1, size) {
  if (!state.brushTipCanvas) {
    updateBrushTip();
  }
  const brushCanvas = state.brushTipCanvas;
  const radius = size / 2;
  
  const dx1 = cp.x - p0.x;
  const dy1 = cp.y - p0.y;
  const dx2 = p1.x - cp.x;
  const dy2 = p1.y - cp.y;
  const approxDist = Math.sqrt(dx1*dx1 + dy1*dy1) + Math.sqrt(dx2*dx2 + dy2*dy2);
  
  // Configurable spacing ensures smooth curves without "bumpy" circles
  const step = Math.max(1, size * (state.brushSpacing !== undefined ? state.brushSpacing : 0.15));
  const steps = Math.ceil(approxDist / step);
  
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = state.opacity;
  
  if (steps === 0) {
    drawBrushStamp(ctx, p0.x, p0.y, radius, size, brushCanvas);
  } else {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const cx = mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p1.x;
      const cy = mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p1.y;
      drawBrushStamp(ctx, cx, cy, radius, size, brushCanvas);
    }
  }
  ctx.globalAlpha = prevAlpha;
}

function configCtx(context, tool) {
  context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  context.lineCap     = 'round';
  context.lineJoin    = 'round';
  context.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : getDrawColor();
  context.fillStyle   = getDrawColor();
  context.globalAlpha = 1;

  const aaCheckbox = document.getElementById('anti-alias-toggle');
  const antiAlias = aaCheckbox ? aaCheckbox.checked : true;

  if (!antiAlias && tool !== 'fill' && tool !== 'lasso' && tool !== 'eyedropper') {
    // If using Bresenham, no filter is needed! Massive performance boost.
    if (state.brushSize === 1) {
      context.filter = 'none';
    } else {
      context.filter = 'url(#pixelate-stroke)';
    }
    context.imageSmoothingEnabled = false;
    context.lineWidth = Math.max(0.5, state.brushSize - 0.5);
  } else {
    context.filter = 'none';
    context.imageSmoothingEnabled = true;
    context.lineWidth = state.brushSize;
  }
}

function isAntiAliasingEnabled() {
  const aaCheckbox = document.getElementById('anti-alias-toggle');
  return aaCheckbox ? aaCheckbox.checked : true;
}

function isAliased1px() {
  const aaCheckbox = document.getElementById('anti-alias-toggle');
  return aaCheckbox && !aaCheckbox.checked && state.brushSize === 1;
}

function drawBresenhamLine(ctx, x0, y0, x1, y1) {
  let x = Math.floor(x0);
  let y = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  const sx = x < endX ? 1 : -1;
  const sy = y < endY ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  while (true) {
    ctx.rect(x, y, 1, 1);
    if (x === endX && y === endY) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  ctx.fill();
  ctx.beginPath();
}

function drawBresenhamBezier(ctx, p0, p1, p2, p3) {
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const approxLen = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  const steps = Math.max(10, Math.floor(approxLen));
  
  let lastX = p0.x;
  let lastY = p0.y;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x;
    const y = u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y;
    
    let bx = Math.floor(lastX);
    let by = Math.floor(lastY);
    const endX = Math.floor(x);
    const endY = Math.floor(y);
    const dx = Math.abs(endX - bx);
    const dy = -Math.abs(endY - by);
    const sx = bx < endX ? 1 : -1;
    const sy = by < endY ? 1 : -1;
    let err = dx + dy;
    
    while (true) {
      ctx.rect(bx, by, 1, 1);
      if (bx === endX && by === endY) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; bx += sx; }
      if (e2 <= dx) { err += dx; by += sy; }
    }
    
    lastX = x;
    lastY = y;
  }
  ctx.fill();
}

// ─── Brush / Pencil Stroke ───────────────────────────────────────
function startStroke(x, y) {
  const lctx = getLCtx(); if (!lctx) return;
  markActiveFrameAsKeyframe();
  lctx.save();
  applySelectionClip(lctx);
  state.strokeLctx = lctx;
  configCtx(lctx, state.tool);

  if (state.tool === 'brush' && state.isAltDrawing) {
    if (!state.strokeSourceCanvas) {
      state.strokeSourceCanvas = document.createElement('canvas');
    }
    state.strokeSourceCanvas.width = canvasW;
    state.strokeSourceCanvas.height = canvasH;
    const sctx = state.strokeSourceCanvas.getContext('2d');
    sctx.clearRect(0, 0, canvasW, canvasH);
    sctx.drawImage(lctx.canvas, 0, 0);
  }
  if (isAliased1px()) {
    lctx.fillStyle = getDrawColor();
    lctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
  } else if (state.tool === 'brush') {
    if (!state.brushTipCanvas) {
      updateBrushTip();
    }
    const radius = state.brushSize / 2;
    const prevAlpha = lctx.globalAlpha;
    lctx.globalAlpha = state.opacity;
    drawBrushStamp(lctx, x, y, radius, state.brushSize, state.brushTipCanvas);
    lctx.globalAlpha = prevAlpha;
  } else {
    lctx.beginPath(); lctx.moveTo(x, y);
    lctx.arc(x, y, state.brushSize / 2, 0, Math.PI * 2);
    lctx.fill();
    lctx.beginPath(); lctx.moveTo(x, y);
  }
  state.lastDrawX = x;
  state.lastDrawY = y;
  compositeAll();
}

function continueStroke(x, y) {
  const lctx = getLCtx(); if (!lctx) return;
  configCtx(lctx, state.tool);
  if (isAliased1px()) {
    drawBresenhamLine(lctx, state.lastDrawX, state.lastDrawY, x, y);
  } else if (state.tool === 'brush') {
    drawSoftBrushStroke(lctx, state.lastDrawX, state.lastDrawY, x, y);
  } else {
    lctx.lineTo(x, y); lctx.stroke();
    lctx.beginPath(); lctx.moveTo(x, y);
  }
  state.lastDrawX = x;
  state.lastDrawY = y;
  compositeAll();
}

// ─── Shape Preview ───────────────────────────────────────────────
function clearPreview() {
  pctx.clearRect(0, 0, canvasW, canvasH);
  // Keep lasso outline visible if selection is active
  if (state.lassoActive) {
    drawLassoSelectionOutline();
  } else {
    previewCanvas.style.mixBlendMode = 'normal';
  }
}

// ─── Lasso Selection Helpers ─────────────────────────────────────
function drawAnimatedBresenhamPath(ctx, path, ox, oy) {
  let pixelCount = 0;
  ctx.fillStyle = '#ffffff';
  const drawState = state.lassoAnimState;
  
  for (let i = 0; i < path.length - 1; i++) {
    const p0 = path[i];
    const p1 = path[i+1];
    
    let x0 = Math.floor(p0.x + ox);
    let y0 = Math.floor(p0.y + oy);
    const x1 = Math.floor(p1.x + ox);
    const y1 = Math.floor(p1.y + oy);
    
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    
    let isFirstPoint = true;

    while (true) {
      // Avoid double-drawing the endpoint of the previous segment
      if (!(i > 0 && isFirstPoint)) {
        const dash = (pixelCount % 8) < 4;
        if (drawState ? !dash : dash) {
          ctx.fillRect(x0, y0, 1, 1);
        }
        pixelCount++;
      }
      isFirstPoint = false;
      
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
}

function drawLassoPreview() {
  previewCanvas.style.mixBlendMode = 'difference';
  pctx.clearRect(0, 0, canvasW, canvasH);
  pctx.save();
  pctx.filter = 'none';
  pctx.imageSmoothingEnabled = false;
  // Draw committed selection outline while user is drawing a new modifier path
  if (state.lassoActive && state.lassoPaths && state.lassoPaths.length > 0) {
    const ox = state.lassoCurrentOffset.x;
    const oy = state.lassoCurrentOffset.y;
    state.lassoPaths.forEach(path => drawAnimatedBresenhamPath(pctx, path, ox, oy));
  }
  // Draw the live new path being drawn
  if (state.lassoPath && state.lassoPath.length >= 2) {
    drawAnimatedBresenhamPath(pctx, state.lassoPath, 0, 0);
  }
  pctx.restore();
}

function drawLassoSelectionOutline() {
  previewCanvas.style.mixBlendMode = 'difference';
  pctx.clearRect(0, 0, canvasW, canvasH);
  let paths = [];
  if (state.lassoPaths && state.lassoPaths.length > 0) {
    paths = [...state.lassoPaths];
  }
  if (state.lassoPath && state.lassoPath.length >= 2) {
    if (paths.length === 0 || state.lassoDragged) {
      paths.push(state.lassoPath);
    }
  }
  if (paths.length === 0) return;
  const ox = state.lassoCurrentOffset.x;
  const oy = state.lassoCurrentOffset.y;
  
  pctx.save();
  pctx.filter = 'none';
  pctx.imageSmoothingEnabled = false;
  
  const cx = state.lassoBoundingBox ? (state.lassoBoundingBox.x + ox + state.lassoBoundingBox.w / 2) : 0;
  const cy = state.lassoBoundingBox ? (state.lassoBoundingBox.y + oy + state.lassoBoundingBox.h / 2) : 0;
  
  if (state.lassoBoundingBox) {
    pctx.translate(cx, cy);
    pctx.rotate(state.lassoRotation || 0);
    pctx.scale(state.lassoScaleX || 1, state.lassoScaleY || 1);
    pctx.translate(-cx, -cy);
  }

  // Draw animated outlines
  paths.forEach(path => {
    drawAnimatedBresenhamPath(pctx, path, ox, oy);
  });

  // Bounding box with handles for Transform Mode
  if (state.lassoTransformMode && state.lassoBoundingBox) {
    const bw = state.lassoBoundingBox.w;
    const bh = state.lassoBoundingBox.h;
    const bx = state.lassoBoundingBox.x + ox;
    const by = state.lassoBoundingBox.y + oy;

    // Draw 1px border around the bounding box using fillRect
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(bx, by, bw, 1);
    pctx.fillRect(bx, by + bh - 1, bw, 1);
    pctx.fillRect(bx, by, 1, bh);
    pctx.fillRect(bx + bw - 1, by, 1, bh);

    const rhs = Math.max(3, Math.round(8 / state.zoom));
    const rhhs = Math.floor(rhs / 2);
    
    const corners = [
      [bx, by],
      [bx + bw, by],
      [bx, by + bh],
      [bx + bw, by + bh]
    ];
    
    corners.forEach(([cx, cy]) => {
      // Draw handle fill
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(cx - rhhs, cy - rhhs, rhs, rhs);
      // Draw handle border
      pctx.fillStyle = '#000000';
      pctx.fillRect(cx - rhhs, cy - rhhs, rhs, 1);
      pctx.fillRect(cx - rhhs, cy + rhs - rhhs - 1, rhs, 1);
      pctx.fillRect(cx - rhhs, cy - rhhs, 1, rhs);
      pctx.fillRect(cx + rhs - rhhs - 1, cy - rhhs, 1, rhs);
    });
    
    // Add a rotation hint line at the top
    const rx = bx + bw/2;
    const ry = by - 20/state.zoom;
    
    pctx.fillStyle = '#ffffff';
    const lineY0 = Math.min(by, ry);
    const lineY1 = Math.max(by, ry);
    pctx.fillRect(rx, lineY0, 1, lineY1 - lineY0);
    
    // Draw rotation handle circle/dot as a filled square
    const rrad = Math.max(2, Math.round(4 / state.zoom));
    const rsize = rrad * 2;
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(rx - rrad, ry - rrad, rsize, rsize);
    
    // Draw handle border
    pctx.fillStyle = '#000000';
    pctx.fillRect(rx - rrad, ry - rrad, rsize, 1);
    pctx.fillRect(rx - rrad, ry + rsize - rrad - 1, rsize, 1);
    pctx.fillRect(rx - rrad, ry - rrad, 1, rsize);
    pctx.fillRect(rx + rsize - rrad - 1, ry - rrad, 1, rsize);
  }

  pctx.restore();
}

function extractLassoSelection(providedMask = null, forceKeepFloating = false) {
  const lctx = getLCtx();
  if (!lctx) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const paths = state.lassoPaths && state.lassoPaths.length > 0 ? state.lassoPaths : (state.lassoPath && state.lassoPath.length > 2 ? [state.lassoPath] : []);
  if (providedMask) {
    for (let y = 0; y < canvasH; y++) {
      for (let x = 0; x < canvasW; x++) {
        if (providedMask[x + y * canvasW] === 1) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  } else {
    paths.forEach(path => {
      path.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
    });
  }

  minX = Math.floor(Math.max(0, minX));
  maxX = Math.ceil(Math.min(canvasW, maxX));
  minY = Math.floor(Math.max(0, minY));
  maxY = Math.ceil(Math.min(canvasH, maxY));
  const w = maxX - minX;
  const h = maxY - minY;
  
  if (w < 4 || h < 4) {
    state.lassoActive = false;
    state.lassoPath = [];
    state.lassoPaths = [];
    state.lassoSelectionCanvas = null;
    state.lassoMaskCanvas = null;
    state.lassoBoundingBox = null;
    pctx.clearRect(0, 0, canvasW, canvasH);
    return;
  }

  state.lassoBoundingBox = { x: minX, y: minY, w, h };
  state.lassoCurrentOffset = { x: 0, y: 0 };
  state.lassoPrevOffset    = { x: 0, y: 0 };
  state.lassoStartOffset   = { x: 0, y: 0 };
  state.lassoScaleX = 1;
  state.lassoScaleY = 1;
  state.lassoRotation = 0;

  const btn = document.getElementById('btn-lasso-transform');
  if (btn) btn.classList.remove('hidden');

  // Create a mask canvas
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w || 1; maskCanvas.height = h || 1;
  const maskCtx = maskCanvas.getContext('2d');
  
  if (providedMask) {
    const tempImageData = maskCtx.createImageData(w || 1, h || 1);
    const tempData = tempImageData.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const val = providedMask[(x + minX) + (y + minY) * canvasW] === 1 ? 255 : 0;
        const idx = (x + y * w) * 4;
        tempData[idx] = val;
        tempData[idx+1] = val;
        tempData[idx+2] = val;
        tempData[idx+3] = val;
      }
    }
    maskCtx.putImageData(tempImageData, 0, 0);
  } else {
    maskCtx.fillStyle = 'white';
    maskCtx.beginPath();
    paths.forEach(path => {
      if (!path || path.length < 2) return;
      maskCtx.moveTo((path[0].x || 0) - minX, (path[0].y || 0) - minY);
      for (let i = 1; i < path.length; i++) {
        maskCtx.lineTo((path[i].x || 0) - minX, (path[i].y || 0) - minY);
      }
      maskCtx.closePath();
    });
    maskCtx.fill("evenodd");

    // Fill the boundary pixels to prevent shrinkage
    paths.forEach(path => {
      if (!path) return;
      for (let i = 0; i < path.length; i++) {
        maskCtx.fillRect((path[i].x || 0) - minX, (path[i].y || 0) - minY, 1, 1);
      }
    });
  }

  const maskData = maskCtx.getImageData(0, 0, w, h).data;

  const layerData = lctx.getImageData(minX, minY, w, h);
  const layerPixels = layerData.data;

  const selCanvas = document.createElement('canvas');
  selCanvas.width = w; selCanvas.height = h;
  const selCtx = selCanvas.getContext('2d');
  const selData = selCtx.createImageData(w, h);
  const selPixels = selData.data;

  let modified = false;
  // Transfer pixels perfectly using binary threshold
  for (let i = 0; i < maskData.length; i += 4) {
    if (maskData[i+3] > 128) {
      if (layerPixels[i+3] > 0) {
        selPixels[i]   = layerPixels[i];
        selPixels[i+1] = layerPixels[i+1];
        selPixels[i+2] = layerPixels[i+2];
        selPixels[i+3] = layerPixels[i+3];
        layerPixels[i+3] = 0; 
        modified = true;
      }
    }
  }

  selCtx.putImageData(selData, 0, 0);
  if (modified) {
    markActiveFrameAsKeyframe();
    lctx.putImageData(layerData, minX, minY);
  }
  state.lassoSelectionCanvas = selCanvas;
  state.lassoMaskCanvas = maskCanvas;

  updateSelectionMask(providedMask);

  if (state.tool !== 'lasso' && state.tool !== 'magicwand' && !forceKeepFloating) {
    bakeFloatingSelectionOnly();
  } else {
    compositeAll();
    if (modified) {
      saveHistory();
    }
  }
  return modified;
}

function traceMaskContours(mask) {
  const paths = [];
  const visitedGlobal = new Uint8Array(canvasW * canvasH);

  const dirs = [
    {dx: 1, dy: 0},   // 0: Right
    {dx: 1, dy: 1},   // 1: Down-Right
    {dx: 0, dy: 1},   // 2: Down
    {dx: -1, dy: 1},  // 3: Down-Left
    {dx: -1, dy: 0},  // 4: Left
    {dx: -1, dy: -1}, // 5: Up-Left
    {dx: 0, dy: -1},  // 6: Up
    {dx: 1, dy: -1}   // 7: Up-Right
  ];

  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const idx = x + y * canvasW;
      if (mask[idx] === 1 && visitedGlobal[idx] === 0) {
        let isBoundary = false;
        const testNeighbors = [
          [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]
        ];
        for (const [tx, ty] of testNeighbors) {
          if (tx < 0 || tx >= canvasW || ty < 0 || ty >= canvasH || mask[tx + ty * canvasW] === 0) {
            isBoundary = true;
            break;
          }
        }

        if (isBoundary) {
          const path = [];
          let cx = x;
          let cy = y;
          let backtrackDir = 4;
          let firstNextDir = -1;
          
          let loops = 0;
          const maxLoops = 20000;
          const visitedStates = new Set();

          while (loops < maxLoops) {
            path.push({ x: cx, y: cy });
            visitedGlobal[cx + cy * canvasW] = 1;

            const stateKey = `${cx},${cy},${backtrackDir}`;
            if (visitedStates.has(stateKey)) {
              break;
            }
            visitedStates.add(stateKey);

            let foundNext = false;
            let nextDir = -1;

            for (let i = 0; i < 8; i++) {
              const d = (backtrackDir + 1 + i) % 8;
              const nx = cx + dirs[d].dx;
              const ny = cy + dirs[d].dy;

              if (nx >= 0 && nx < canvasW && ny >= 0 && ny < canvasH) {
                if (mask[nx + ny * canvasW] === 1) {
                  nextDir = d;
                  foundNext = true;
                  break;
                }
              }
            }

            if (!foundNext) {
              break;
            }

            if (firstNextDir === -1) {
              firstNextDir = nextDir;
            }

            const nx = cx + dirs[nextDir].dx;
            const ny = cy + dirs[nextDir].dy;

            backtrackDir = (nextDir + 4) % 8;
            cx = nx;
            cy = ny;

            if (cx === x && cy === y) {
              if (nextDir === firstNextDir) {
                break;
              }
            }

            loops++;
          }

          if (path.length > 2) {
            path.push({ x: path[0].x, y: path[0].y });
            paths.push(path);
          }
        }
      }
    }
  }

  return paths;
}

function getCombinedLayersImageData() {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvasW || 1;
  tempCanvas.height = canvasH || 1;
  const tempCtx = tempCanvas.getContext('2d');

  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    
    const f = getDisplayFrame(l, state.currentFrame);
    if (f && f.canvas) {
      tempCtx.save();
      tempCtx.globalAlpha = l.opacity;
      
      const blendMode = l.blendMode || 'source-over';
      if (blendMode === 'invert') {
        const invCanvas = document.createElement('canvas');
        invCanvas.width = canvasW;
        invCanvas.height = canvasH;
        const invCtx = invCanvas.getContext('2d');
        invCtx.drawImage(tempCanvas, 0, 0);
        invCtx.globalCompositeOperation = 'difference';
        invCtx.fillStyle = '#ffffff';
        invCtx.fillRect(0, 0, canvasW, canvasH);
        invCtx.globalCompositeOperation = 'destination-in';
        invCtx.drawImage(f.canvas, 0, 0);
        tempCtx.globalCompositeOperation = 'source-over';
        tempCtx.drawImage(invCanvas, 0, 0);
      } else if (blendMode === 'mask') {
        tempCtx.globalCompositeOperation = 'destination-in';
        tempCtx.drawImage(f.canvas, 0, 0);
      } else {
        tempCtx.globalCompositeOperation = blendMode;
        tempCtx.drawImage(f.canvas, 0, 0);
      }
      tempCtx.restore();
    }
  }

  return tempCtx.getImageData(0, 0, canvasW, canvasH);
}

function magicWandSelect(sx, sy, isShift, isAlt) {
  const lctx = getLCtx();
  if (!lctx) return;

  const hasSelection = state.lassoActive && ((state.lassoPaths && state.lassoPaths.length > 0) || (state.lassoPath && state.lassoPath.length > 2));
  const existingMask = getExistingSelectionMask();
  if (hasSelection) {
    // Bake the selection back to the layer before flood fill
    bakeLassoSelection();
  }

  const imgData = (state.allLayersActive) ? getCombinedLayersImageData() : lctx.getImageData(0, 0, canvasW, canvasH);
  const data = imgData.data;

  const startPixelX = Math.floor(sx);
  const startPixelY = Math.floor(sy);
  if (startPixelX < 0 || startPixelX >= canvasW || startPixelY < 0 || startPixelY >= canvasH) return;

  const targetIdx = (startPixelX + startPixelY * canvasW) * 4;
  const tr = data[targetIdx];
  const tg = data[targetIdx+1];
  const tb = data[targetIdx+2];
  const ta = data[targetIdx+3];

  const tolerance = state.bucketThreshold;

  function match(x, y) {
    if (x < 0 || x >= canvasW || y < 0 || y >= canvasH) return false;
    const idx = (x + y * canvasW) * 4;
    return Math.abs(data[idx] - tr) <= tolerance &&
           Math.abs(data[idx+1] - tg) <= tolerance &&
           Math.abs(data[idx+2] - tb) <= tolerance &&
           Math.abs(data[idx+3] - ta) <= tolerance;
  }

  const stack = [[startPixelX, startPixelY]];
  const visited = new Uint8Array(canvasW * canvasH);
  visited[startPixelX + startPixelY * canvasW] = 1;

  while (stack.length > 0) {
    const [cx, cy] = stack.pop();
    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < canvasW && ny >= 0 && ny < canvasH) {
        const key = nx + ny * canvasW;
        if (!visited[key] && match(nx, ny)) {
          visited[key] = 1;
          stack.push([nx, ny]);
        }
      }
    }
  }

  // Combine masks
  const combinedMask = new Uint8Array(canvasW * canvasH);
  if (isShift && hasSelection) {
    for (let i = 0; i < combinedMask.length; i++) {
      combinedMask[i] = (existingMask[i] === 1 || visited[i] === 1) ? 1 : 0;
    }
  } else if (isAlt && hasSelection) {
    for (let i = 0; i < combinedMask.length; i++) {
      combinedMask[i] = (existingMask[i] === 1 && visited[i] === 0) ? 1 : 0;
    }
  } else {
    for (let i = 0; i < combinedMask.length; i++) {
      combinedMask[i] = visited[i];
    }
  }

  // Trace all contours
  const newPaths = traceMaskContours(combinedMask);

  if (newPaths.length > 0) {
    state.lassoPaths = newPaths;
    state.lassoPath = newPaths[0]; // fallback
    state.lassoActive = true;
    const modified = extractLassoSelection(combinedMask);
    drawLassoSelectionOutline();
    compositeAll();
    if (modified) {
      saveHistory();
    }
  } else {
    compositeAll();
  }
}

// Mirror of magicWandSelect but for a drawn lasso polygon path.
// Uses the same existingMask → bake → newMask → combine → extract pattern.
function lassoPathSelect(closedPath, isShift, isAlt) {
  const lctx = getLCtx();
  if (!lctx) return;

  const hasSelection = state.lassoActive && ((state.lassoPaths && state.lassoPaths.length > 0) || (state.lassoPath && state.lassoPath.length > 2));
  const existingMask = getExistingSelectionMask();
  
  if (hasSelection) {
    // Bake selection back to layer before working on new path
    bakeLassoSelection();
  }

  // Build new mask from the drawn polygon (same fill approach as original extractLassoSelection)
  const newMaskCanvas = document.createElement('canvas');
  newMaskCanvas.width = canvasW; newMaskCanvas.height = canvasH;
  const nmctx = newMaskCanvas.getContext('2d');
  nmctx.fillStyle = 'white';
  nmctx.beginPath();
  nmctx.moveTo(closedPath[0].x, closedPath[0].y);
  for (let i = 1; i < closedPath.length; i++) nmctx.lineTo(closedPath[i].x, closedPath[i].y);
  nmctx.closePath();
  nmctx.fill();
  for (let i = 0; i < closedPath.length; i++) nmctx.fillRect(closedPath[i].x, closedPath[i].y, 1, 1);
  const newMaskData = nmctx.getImageData(0, 0, canvasW, canvasH).data;
  const newMask = new Uint8Array(canvasW * canvasH);
  for (let i = 0; i < newMask.length; i++) newMask[i] = newMaskData[i * 4 + 3] > 128 ? 1 : 0;

  // Combine masks exactly like magicWandSelect
  const combinedMask = new Uint8Array(canvasW * canvasH);
  if (isShift && hasSelection) {
    for (let i = 0; i < combinedMask.length; i++) combinedMask[i] = (existingMask[i] === 1 || newMask[i] === 1) ? 1 : 0;
  } else if (isAlt && hasSelection) {
    for (let i = 0; i < combinedMask.length; i++) combinedMask[i] = (existingMask[i] === 1 && newMask[i] === 0) ? 1 : 0;
  } else {
    for (let i = 0; i < combinedMask.length; i++) combinedMask[i] = newMask[i];
  }

  const newPaths = traceMaskContours(combinedMask);
  if (newPaths.length > 0) {
    state.lassoPaths = newPaths;
    state.lassoPath = newPaths[0];
    state.lassoActive = true;
    const modified = extractLassoSelection(combinedMask);
    drawLassoSelectionOutline();
    compositeAll();
    if (modified) {
      saveHistory();
    }
  } else {
    compositeAll();
  }
}

function getExistingSelectionMask() {
  const mask = new Uint8Array(canvasW * canvasH);
  if (!state.lassoActive || !state.lassoMaskCanvas || !state.lassoBoundingBox) return mask;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = canvasW || 1; maskCanvas.height = canvasH || 1;
  const mctx = maskCanvas.getContext('2d');

  mctx.save();
  mctx.imageSmoothingEnabled = isAntiAliasingEnabled();
  const ox = state.lassoCurrentOffset.x || 0;
  const oy = state.lassoCurrentOffset.y || 0;
  
  if (state.lassoRotation || state.lassoScaleX !== undefined) {
    const cx = state.lassoBoundingBox.x + ox + state.lassoBoundingBox.w / 2;
    const cy = state.lassoBoundingBox.y + oy + state.lassoBoundingBox.h / 2;
    mctx.translate(cx, cy);
    mctx.rotate(state.lassoRotation || 0);
    mctx.scale(state.lassoScaleX !== undefined ? state.lassoScaleX : 1, state.lassoScaleY !== undefined ? state.lassoScaleY : 1);
    mctx.translate(-cx, -cy);
  }
  
  mctx.drawImage(state.lassoMaskCanvas, state.lassoBoundingBox.x + ox, state.lassoBoundingBox.y + oy);
  mctx.restore();

  const maskData = mctx.getImageData(0, 0, canvasW, canvasH).data;
  for (let i = 0; i < mask.length; i++) {
    mask[i] = maskData[i * 4 + 3] > 128 ? 1 : 0;
  }
  return mask;
}

function invertSelection() {
  const lctx = getLCtx();
  if (!lctx) return;
  
  if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive && state.lassoTransformMode) {
    return; // Don't invert during transform
  }

  let existingMask = new Uint8Array(canvasW * canvasH);
  if (state.lassoActive) {
    existingMask = getExistingSelectionMask();
    if (state.tool === 'lasso' || state.tool === 'magicwand') {
      bakeLassoSelection();
    } else {
      bakeFloatingSelectionOnly();
      state.lassoActive = false;
    }
  }

  const invertedMask = new Uint8Array(canvasW * canvasH);
  for (let i = 0; i < invertedMask.length; i++) {
    invertedMask[i] = existingMask[i] === 1 ? 0 : 1;
  }

  const newPaths = traceMaskContours(invertedMask);
  
  if (newPaths.length > 0) {
    state.lassoPaths = newPaths;
    state.lassoPath = newPaths[0]; // fallback
    state.lassoActive = true;
    extractLassoSelection(invertedMask);
    drawLassoSelectionOutline();
    compositeAll();
  } else {
    discardLassoSelection();
    compositeAll();
    saveHistory();
  }
}

function bakeLassoSelection() {
  if (!state.lassoActive || !state.lassoSelectionCanvas) return;
  const lctx = getLCtx();
  if (lctx) {
    markActiveFrameAsKeyframe();
    lctx.save();
    lctx.globalCompositeOperation = 'source-over';
    lctx.imageSmoothingEnabled = isAntiAliasingEnabled();
    
    const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
    const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
    lctx.translate(cx, cy);
    lctx.rotate(state.lassoRotation || 0);
    lctx.scale(state.lassoScaleX || 1, state.lassoScaleY || 1);
    lctx.translate(-cx, -cy);

    lctx.drawImage(
      state.lassoSelectionCanvas,
      state.lassoBoundingBox.x + state.lassoCurrentOffset.x,
      state.lassoBoundingBox.y + state.lassoCurrentOffset.y
    );
    lctx.restore();
  }
  
  state.lassoActive         = false;
  state.lassoPath           = [];
  state.lassoPaths          = [];
  state.lassoSelectionCanvas = null;
  state.lassoMaskCanvas     = null;
  state.lassoBoundingBox    = null;
  state.lassoCurrentOffset  = { x: 0, y: 0 };
  state.lassoPrevOffset     = { x: 0, y: 0 };
  state.lassoStartOffset    = { x: 0, y: 0 };
  state.lassoDragged        = false;
  state.lassoCutPending     = false;
  state.lassoTransformMode  = false;
  state.selectionMask       = null;
  
  const btn = document.getElementById('btn-lasso-transform');
  if (btn) {
    btn.classList.add('hidden');
    btn.classList.remove('active');
  }
  
  pctx.clearRect(0, 0, canvasW, canvasH);
  
  if (lctx) {
    compositeAll();
    saveHistory();
  }
}

function drawPreviewLine(x0, y0, x1, y1) {
  clearPreview();
  configCtx(pctx, state.tool);
  if (isAliased1px()) {
    drawBresenhamLine(pctx, x0, y0, x1, y1);
  } else {
    pctx.beginPath();
    pctx.moveTo(x0, y0);
    pctx.lineTo(x1, y1);
    pctx.stroke();
  }
}

function drawPreviewCurve() {
  clearPreview();
  configCtx(pctx, 'curve');
  const pts = state.curvePoints;
  if (!pts || pts.length < 2) return;

  if (isAliased1px()) {
    if (state.curveStep === 0) {
      drawBresenhamLine(pctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    } else if (state.curveStep === 1) {
      const cp1x = pts[2] ? pts[2].x : pts[1].x;
      const cp1y = pts[2] ? pts[2].y : pts[1].y;
      drawBresenhamBezier(pctx, pts[0], {x:cp1x, y:cp1y}, {x:cp1x, y:cp1y}, pts[1]);
    } else if (state.curveStep === 2) {
      const cp1x = pts[2] ? pts[2].x : pts[1].x;
      const cp1y = pts[2] ? pts[2].y : pts[1].y;
      const cp2x = pts[3] ? pts[3].x : cp1x;
      const cp2y = pts[3] ? pts[3].y : cp1y;
      drawBresenhamBezier(pctx, pts[0], {x:cp1x, y:cp1y}, {x:cp2x, y:cp2y}, pts[1]);
    }
    return;
  }

  pctx.beginPath();
  pctx.moveTo(pts[0].x, pts[0].y);
  
  if (state.curveStep === 0) {
    pctx.lineTo(pts[1].x, pts[1].y);
  } else if (state.curveStep === 1) {
    if (pts[2]) {
      pctx.bezierCurveTo(pts[2].x, pts[2].y, pts[2].x, pts[2].y, pts[1].x, pts[1].y);
    } else {
      pctx.lineTo(pts[1].x, pts[1].y);
    }
  } else if (state.curveStep === 2) {
    if (pts[3]) {
      pctx.bezierCurveTo(pts[2].x, pts[2].y, pts[3].x, pts[3].y, pts[1].x, pts[1].y);
    } else {
      pctx.bezierCurveTo(pts[2].x, pts[2].y, pts[2].x, pts[2].y, pts[1].x, pts[1].y);
    }
  }
  pctx.stroke();
}

function finalizeCurve() {
  const lctx = getLCtx();
  if (!lctx) return;
  markActiveFrameAsKeyframe();
  lctx.save();
  applySelectionClip(lctx);
  configCtx(lctx, 'curve');
  const pts = state.curvePoints;
  
  const cp1x = pts[2] ? pts[2].x : pts[1].x;
  const cp1y = pts[2] ? pts[2].y : pts[1].y;
  const cp2x = pts[3] ? pts[3].x : cp1x;
  const cp2y = pts[3] ? pts[3].y : cp1y;

  if (isAliased1px()) {
    drawBresenhamBezier(lctx, pts[0], {x:cp1x, y:cp1y}, {x:cp2x, y:cp2y}, pts[1]);
  } else {
    lctx.beginPath();
    lctx.moveTo(pts[0].x, pts[0].y);
    lctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pts[1].x, pts[1].y);
    lctx.stroke();
  }
  lctx.restore();
  
  clearPreview();
  compositeAll();
  saveHistory();
}

// Shows dashed preview line when Shift is held (no anchor dot)
function drawShiftPreview(toX, toY) {
  if (!state.shiftAnchor) return;
  clearPreview();
  if (toX === undefined) return; // nothing to draw without a target
  const { x: ax, y: ay } = state.shiftAnchor;
  pctx.save();
  pctx.globalCompositeOperation = 'source-over';
  pctx.strokeStyle = getDrawColor();
  pctx.lineWidth   = state.brushSize;
  pctx.lineCap     = 'round';
  pctx.setLineDash([8 / state.zoom, 6 / state.zoom]);
  pctx.beginPath();
  pctx.moveTo(ax, ay);
  pctx.lineTo(toX, toY);
  pctx.stroke();
  pctx.setLineDash([]);
  pctx.restore();
}

function drawPreviewRect(x0, y0, x1, y1) {
  clearPreview();
  configCtx(pctx, state.tool);
  pctx.beginPath();
  pctx.rect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0));
  pctx.stroke();
}

function drawPreviewCircle(x0, y0, x1, y1) {
  clearPreview();
  configCtx(pctx, state.tool);
  const rx = Math.abs(x1-x0)/2;
  const ry = Math.abs(y1-y0)/2;
  const cx = Math.min(x0,x1) + rx;
  const cy = Math.min(y0,y1) + ry;
  pctx.beginPath();
  pctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2);
  pctx.stroke();
}

function commitShape(x0, y0, x1, y1) {
  const lctx = getLCtx(); if (!lctx) return;
  markActiveFrameAsKeyframe();
  lctx.save();
  applySelectionClip(lctx);
  configCtx(lctx, state.tool);
  if (state.tool === 'line') {
    if (isAliased1px()) {
      drawBresenhamLine(lctx, x0, y0, x1, y1);
    } else {
      lctx.beginPath();
      lctx.moveTo(x0, y0);
      lctx.lineTo(x1, y1);
      lctx.stroke();
    }
  } else if (state.tool === 'rect') {
    lctx.beginPath();
    lctx.rect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0));
    lctx.stroke();
  } else if (state.tool === 'circle') {
    const rx = Math.abs(x1-x0)/2;
    const ry = Math.abs(y1-y0)/2;
    const cx = Math.min(x0,x1)+rx;
    const cy = Math.min(y0,y1)+ry;
    lctx.beginPath();
    lctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2);
    lctx.stroke();
  }
  lctx.restore();
  clearPreview();
  compositeAll();
  saveHistory();
}

// ─── Flood Fill (Bucket) ─────────────────────────────────────────
function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function floodFill(sx, sy, fillColorHex) {
  const lctx = getLCtx(); if (!lctx) return;
  markActiveFrameAsKeyframe();
  
  const layerImageData = lctx.getImageData(0, 0, canvasW, canvasH);
  const layerData = layerImageData.data;
  
  const matchImageData = (state.allLayersActive) ? getCombinedLayersImageData() : layerImageData;
  const matchData = matchImageData.data;
  
  const [fr, fg, fb] = hexToRgb(fillColorHex);
  const fa = Math.round(state.opacity * 255);

  const px = (Math.floor(sx) + Math.floor(sy) * canvasW) * 4;
  const tr = matchData[px], tg = matchData[px+1], tb = matchData[px+2], ta = matchData[px+3];

  if (layerData[px]===fr && layerData[px+1]===fg && layerData[px+2]===fb && layerData[px+3]===fa && !state.allLayersActive) return;

  const tolerance = state.bucketThreshold;
  function match(idx) {
    return Math.abs(matchData[idx]-tr) <= tolerance &&
           Math.abs(matchData[idx+1]-tg) <= tolerance &&
           Math.abs(matchData[idx+2]-tb) <= tolerance &&
           Math.abs(matchData[idx+3]-ta) <= tolerance;
  }

  const stack = [[Math.floor(sx), Math.floor(sy)]];
  const visited = new Uint8Array(canvasW * canvasH);

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x<0||x>=canvasW||y<0||y>=canvasH) continue;
    if (visited[x+y*canvasW]) continue;
    if (state.lassoActive) {
      if (!state.selectionMask || state.selectionMask[x + y * canvasW] !== 1) {
        continue;
      }
    }
    const idx = (x + y*canvasW)*4;
    if (!match(idx)) continue;
    visited[x+y*canvasW] = 1;
    layerData[idx]   = fr;
    layerData[idx+1] = fg;
    layerData[idx+2] = fb;
    layerData[idx+3] = fa;
    stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
  }

  lctx.putImageData(layerImageData, 0, 0);
  compositeAll();
  saveHistory();
}

// ─── Eyedropper ──────────────────────────────────────────────────
function pickColor(x, y) {
  const d = displayCtx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  const hex = '#' + [d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
  setFgColor(hex);
}

// ─── Brush stroke smoothing ──────────────────────────────────────
const brushPoints = [];

function smoothStroke(tool, x, y, pressure = 1) {
  if (tool === 'brush' && !isAliased1px()) {
    brushPoints.push({x, y});
    if (brushPoints.length < 3) {
      continueStroke(x, y);
      return;
    }
    const [p0, p1, p2] = brushPoints.slice(-3);
    const startPt = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const controlPt = p1;
    const endPt = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    
    const lctx = getLCtx(); if (!lctx) return;
    markActiveFrameAsKeyframe();
    configCtx(lctx, 'brush');
    drawSoftBrushQuadratic(lctx, startPt, controlPt, endPt, state.brushSize);
    lctx.beginPath();
    lctx.moveTo(endPt.x, endPt.y);
    compositeAll();
  } else {
    continueStroke(x, y);
  }
}

// ─── Pointer Events ──────────────────────────────────────────────
container.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  state.isAltDrawing = e.altKey;

  if (state.isPlaying) {
    pause();
  }

  if (state.spaceDown) {
    // Begin pan viewport
    state.isPanning = true;
    state.panStartX = state.panX;
    state.panStartY = state.panY;
    state.panStartMouseX = e.clientX;
    state.panStartMouseY = e.clientY;
    container.classList.add('panning-active');
    container.setPointerCapture(e.pointerId);
    return;
  } else if (e.button === 1) {
    // Begin MMB Move Bitmaps
    state.isMovingAllBitmaps = true;
    state.moveAllLayers = e.shiftKey;
    const {x, y} = clientToCanvas(e.clientX, e.clientY);
    state.moveAllStartX = x;
    state.moveAllStartY = y;
    state.moveAllCurrentDX = 0;
    state.moveAllCurrentDY = 0;
    container.setPointerCapture(e.pointerId);
    if (state.lassoActive) {
      bakeLassoSelection();
      compositeAll();
    }
    const targets = state.moveAllLayers ? layers : [layers[activeLayerIdx]];
    targets.forEach(l => {
      if (!l || l.isVideo) return;
      l.frames.forEach(f => {
        if (f.canvas) syncBackingCanvas(f);
      });
    });
    return;
  }

  const {x, y} = clientToCanvas(e.clientX, e.clientY);

  // Track click start for quick click deselect detection
  state.clickStartX = x;
  state.clickStartY = y;
  state.clickStartTime = Date.now();

  // Click outside canvas handling (discard selection if left click outside white page)
  if (state.lassoActive && (x < 0 || x >= canvasW || y < 0 || y >= canvasH)) {
    if (!state.spaceDown && e.button === 0) {
      discardLassoSelection(); // bakes floating pixels back first
      compositeAll();
      saveHistory();
      return;
    }
  }

  if (state.tool === 'fill') {
    floodFill(x, y, state.fgColor);
    return;
  }

  if (state.tool === 'eyedropper') {
    pickColor(x, y);
    return;
  }

  // ── Lasso and Magic Wand tool handling ───────────────────────────
  if (state.tool === 'lasso' || state.tool === 'magicwand') {
    if (state.lassoTransformMode && state.lassoActive && state.lassoBoundingBox) {
      const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
      const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
      const dx = x - cx;
      const dy = y - cy;
      
      const angle = -(state.lassoRotation || 0);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      let localX = dx * cosA - dy * sinA;
      let localY = dx * sinA + dy * cosA;
      
      const sX = state.lassoScaleX || 1;
      const sY = state.lassoScaleY || 1;
      localX /= sX;
      localY /= sY;
      
      const halfW = state.lassoBoundingBox.w / 2;
      const halfH = state.lassoBoundingBox.h / 2;
      
      const rotY = -halfH - 20 / state.zoom;
      const distToRot = Math.sqrt(Math.pow(localX, 2) + Math.pow(localY - rotY, 2));
      
      const distToTL = Math.sqrt(Math.pow(localX - (-halfW), 2) + Math.pow(localY - (-halfH), 2));
      const distToTR = Math.sqrt(Math.pow(localX - halfW, 2) + Math.pow(localY - (-halfH), 2));
      const distToBL = Math.sqrt(Math.pow(localX - (-halfW), 2) + Math.pow(localY - halfH, 2));
      const distToBR = Math.sqrt(Math.pow(localX - halfW, 2) + Math.pow(localY - halfH, 2));
      const minDistToScale = Math.min(distToTL, distToTR, distToBL, distToBR);

      // We use average scale for hit tolerance to keep it roughly the same size visually
      const hitTolerance = 12 / (state.zoom * ((sX + sY) / 2));

      if (distToRot <= hitTolerance) {
         state.isDrawing = true;
         state.lassoDragged = true;
         state.lassoDragAction = 'rotate';
         state.lassoStartAngle = Math.atan2(dy, dx);
         state.lassoBaseRotation = state.lassoRotation || 0;
         container.setPointerCapture(e.pointerId);
         return;
      } else if (minDistToScale <= hitTolerance) {
         state.isDrawing = true;
         state.lassoDragged = true;
         state.lassoDragAction = 'scale';
         
         const rot = -(state.lassoRotation || 0);
         const localDx = dx * Math.cos(rot) - dy * Math.sin(rot);
         const localDy = dx * Math.sin(rot) + dy * Math.cos(rot);
         
         state.lassoStartDistX = Math.abs(localDx);
         state.lassoStartDistY = Math.abs(localDy);
         state.lassoStartDist = Math.sqrt(dx*dx + dy*dy);
         state.lassoBaseScaleX = state.lassoScaleX || 1;
         state.lassoBaseScaleY = state.lassoScaleY || 1;
         state.lassoBaseScale = state.lassoScaleX || 1;
         
         container.setPointerCapture(e.pointerId);
         return;
      } else if (Math.abs(localX) <= halfW && Math.abs(localY) <= halfH) {
         state.isDrawing = true;
         state.lassoDragged = true;
         state.lassoDragAction = 'move';
         state.lassoDragStart = { x, y };
         state.lassoStartOffset = { ...state.lassoCurrentOffset };
         container.setPointerCapture(e.pointerId);
         return;
      }
    }

    if (e.ctrlKey) {
      // Move mode: drag the floating selection
      if (state.lassoActive) {
        state.isDrawing = true;
        state.lassoDragged = true;
        state.lassoDragAction = 'move';
        state.lassoDragStart = { x, y };
        state.lassoStartOffset = { ...state.lassoCurrentOffset };
        container.setPointerCapture(e.pointerId);
      }
    } else {
      // Selection mode: start drawing new path
      if (state.tool === 'magicwand') {
        magicWandSelect(x, y, e.shiftKey, e.altKey);
      } else {
        // Save modifier keys so pointerup can use them
        state.lassoShiftKey = e.shiftKey && state.lassoActive;
        state.lassoAltKey   = e.altKey  && state.lassoActive;
        // Only bake if starting a completely new selection (no modifier)
        if (!state.lassoShiftKey && !state.lassoAltKey && state.lassoActive) {
          bakeLassoSelection();
        }
        state.isDrawing = true;
        state.lassoDragged = false;
        state.lassoDragAction = null;
        state.lassoStartX = x;
        state.lassoStartY = y;
        state.lassoPath = [{ x, y }];
        if (!state.lassoShiftKey && !state.lassoAltKey) {
          state.lassoActive = false;
        }
        state.lassoTransformMode = false;
        const btn = document.getElementById('btn-lasso-transform');
        if (btn) btn.classList.remove('active');
        container.setPointerCapture(e.pointerId);
      }
    }
    return;
  }

  // ── Shift+click: draw straight line from last released point ─────
  // Works with pencil, brush, eraser — any freehand tool
  const isFreehand = !['line','rect','circle','fill','eyedropper','lasso','curve'].includes(state.tool);
  if (e.shiftKey && isFreehand && state.shiftAnchor) {
    const lctx = getLCtx(); if (!lctx) return;
    markActiveFrameAsKeyframe();
    lctx.save();
    applySelectionClip(lctx);
    configCtx(lctx, state.tool);
    if (isAliased1px()) {
      drawBresenhamLine(lctx, state.shiftAnchor.x, state.shiftAnchor.y, x, y);
    } else {
      lctx.beginPath();
      lctx.moveTo(state.shiftAnchor.x, state.shiftAnchor.y);
      lctx.lineTo(x, y);
      lctx.stroke();
      // Stamp solid dot at endpoint
      lctx.beginPath();
      lctx.arc(x, y, state.brushSize / 2, 0, Math.PI * 2);
      lctx.fill();
    }
    lctx.restore();
    // Move anchor to this new point for chaining
    state.shiftAnchor = { x, y };
    clearPreview();
    drawShiftPreview();
    compositeAll();
    saveHistory();
    container.setPointerCapture(e.pointerId);
    return;
  }

  // Normal freehand drawing — anchor will be set on pointerup
  state.isDrawing = true;
  state.lastX = x;
  state.lastY = y;
  brushPoints.length = 0;

  if (['line','rect','circle','curve'].includes(state.tool)) {
    if (state.tool === 'curve') {
      if (state.curveStep === 0) {
        state.curvePoints = [{x, y}, {x, y}];
      } else if (state.curveStep === 1) {
        state.curvePoints[2] = {x, y};
      } else if (state.curveStep === 2) {
        state.curvePoints[3] = {x, y};
      }
    } else {
      state.shapeStartX = x;
      state.shapeStartY = y;
    }
  } else {
    clearPreview(); // hide old anchor while drawing
    startStroke(x, y);
  }

  container.setPointerCapture(e.pointerId);
});

container.addEventListener('pointermove', e => {
  const {x, y} = clientToCanvas(e.clientX, e.clientY);
  if (state.isDrawing) {
    state.isAltDrawing = e.altKey;
  }

  // Update coordinate display
  document.getElementById('coords-display').textContent =
    `X: ${Math.round(x)}  Y: ${Math.round(y)}`;

  if (state.isPanning) {
    const dx = e.clientX - state.panStartMouseX;
    const dy = e.clientY - state.panStartMouseY;
    state.panX = state.panStartX + dx;
    state.panY = state.panStartY + dy;
    applyTransform();
    return;
  } else if (state.isMovingAllBitmaps) {
    state.moveAllCurrentDX = Math.round(x - state.moveAllStartX);
    state.moveAllCurrentDY = Math.round(y - state.moveAllStartY);
    compositeAll();
    return;
  }

  // Show live shift-line preview while Shift is held
  const isFreehand = !['line','rect','circle','fill','eyedropper','lasso','curve','magicwand'].includes(state.tool);
  if (e.shiftKey && isFreehand && state.shiftAnchor && !state.isDrawing) {
    drawShiftPreview(x, y);
    return;
  }

  // If Shift released mid-hover, redraw anchor dot only
  if (!e.shiftKey && isFreehand && state.shiftAnchor && !state.isDrawing) {
    drawShiftPreview();
    return;
  }

  if (!state.isDrawing) return;

  // ── Lasso and Magic Wand move/draw ───────────────────────────────
  if (state.tool === 'lasso' || state.tool === 'magicwand') {
    if (state.lassoDragged) {
      if (state.lassoTransformMode && state.lassoDragAction) {
        if (state.lassoDragAction === 'move') {
          const dx = x - state.lassoDragStart.x;
          const dy = y - state.lassoDragStart.y;
          state.lassoCurrentOffset = {
            x: state.lassoStartOffset.x + dx,
            y: state.lassoStartOffset.y + dy,
          };
        } else if (state.lassoDragAction === 'rotate') {
          const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
          const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
          const currentAngle = Math.atan2(y - cy, x - cx);
          state.lassoRotation = state.lassoBaseRotation + (currentAngle - state.lassoStartAngle);
        } else if (state.lassoDragAction === 'scale') {
          const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
          const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
          
          const dx = x - cx;
          const dy = y - cy;
          
          if (e.shiftKey) {
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (state.lassoStartDist > 0) {
              const s = state.lassoBaseScale * (dist / state.lassoStartDist);
              state.lassoScaleX = s;
              state.lassoScaleY = s;
            }
          } else {
            const rot = -(state.lassoRotation || 0);
            const localDx = dx * Math.cos(rot) - dy * Math.sin(rot);
            const localDy = dx * Math.sin(rot) + dy * Math.cos(rot);
            
            if (state.lassoStartDistX > 0) {
              state.lassoScaleX = state.lassoBaseScaleX * (Math.abs(localDx) / state.lassoStartDistX);
            }
            if (state.lassoStartDistY > 0) {
              state.lassoScaleY = state.lassoBaseScaleY * (Math.abs(localDy) / state.lassoStartDistY);
            }
          }
        }
      } else {
        const dx = x - state.lassoDragStart.x;
        const dy = y - state.lassoDragStart.y;
        state.lassoCurrentOffset = {
          x: state.lassoStartOffset.x + dx,
          y: state.lassoStartOffset.y + dy,
        };
      }
      compositeAll();
      drawLassoSelectionOutline();
    } else if (state.tool === 'lasso') {
      if (state.lassoType === 'rect') {
        const x0 = state.lassoStartX;
        const y0 = state.lassoStartY;
        state.lassoPath = [
          { x: x0, y: y0 },
          { x: x, y: y0 },
          { x: x, y: y },
          { x: x0, y: y },
          { x: x0, y: y0 }
        ];
      } else {
        state.lassoPath.push({ x, y });
      }
      drawLassoPreview();
    }
    return;
  }

  if (['line','rect','circle','curve'].includes(state.tool)) {
    if (state.tool === 'curve') {
      if (state.curveStep === 0) {
        state.curvePoints[1] = {x, y};
      } else if (state.curveStep === 1) {
        state.curvePoints[2] = {x, y};
      } else if (state.curveStep === 2) {
        state.curvePoints[3] = {x, y};
      }
      drawPreviewCurve();
    } else if (state.tool === 'line') {
      drawPreviewLine(state.shapeStartX, state.shapeStartY, x, y);
    } else if (state.tool === 'rect') {
      drawPreviewRect(state.shapeStartX, state.shapeStartY, x, y);
    } else if (state.tool === 'circle') {
      drawPreviewCircle(state.shapeStartX, state.shapeStartY, x, y);
    }
  } else {
    smoothStroke(state.tool, x, y);
    // Always track the latest drawn position for the shift anchor
    state.lastX = x;
    state.lastY = y;
  }
});

container.addEventListener('pointerup', e => {
  if (state.isPanning) {
    state.isPanning = false;
    container.classList.remove('panning-active');
    return;
  } else if (state.isMovingAllBitmaps) {
    state.isMovingAllBitmaps = false;
    container.releasePointerCapture(e.pointerId);
    const dx = state.moveAllCurrentDX;
    const dy = state.moveAllCurrentDY;
    state.moveAllCurrentDX = 0;
    state.moveAllCurrentDY = 0;
    if (dx !== 0 || dy !== 0) {
      const targets = state.moveAllLayers ? layers : [layers[activeLayerIdx]];
      targets.forEach(l => {
        if (!l || l.isVideo) return;
        l.frames.forEach(f => {
          if (f.canvas) {
            syncBackingCanvas(f);
            f.offsetX = (f.offsetX || 0) + dx;
            f.offsetY = (f.offsetY || 0) + dy;
            f.ctx.clearRect(0, 0, f.canvas.width, f.canvas.height);
            f.ctx.drawImage(f.backingCanvas, -canvasW + f.offsetX, -canvasH + f.offsetY);
          }
        });
      });
      saveHistory();
    }
    compositeAll();
    return;
  }

  const {x, y} = clientToCanvas(e.clientX, e.clientY);
  
  if (state.lassoActive) {
    const isQuickClick = (Date.now() - state.clickStartTime < 300) && 
                         Math.hypot(x - state.clickStartX, y - state.clickStartY) < 3;
    if (isQuickClick) {
      const pixelIdx = Math.floor(x) + Math.floor(y) * canvasW;
      const isInside = state.selectionMask && state.selectionMask[pixelIdx] === 1;
      
      if (x < 0 || x >= canvasW || y < 0 || y >= canvasH || !isInside) {
        discardLassoSelection(); // bakes floating pixels back first
        compositeAll();
        saveHistory();
        state.isDrawing = false;
        return;
      }
    }
  }

  if (!state.isDrawing) return;
  state.isDrawing = false;

  if (state.strokeLctx) {
    state.strokeLctx.restore();
    state.strokeLctx = null;
  }
  state.strokeSourceCanvas = null; // Free snapshot canvas

  // ── Lasso and Magic Wand pointerup ───────────────────────────────
  if (state.tool === 'lasso' || state.tool === 'magicwand') {
    if (state.lassoDragged) {
      // Finish drag — commit new offset
      state.lassoDragged = false;
      state.lassoPrevOffset = { ...state.lassoCurrentOffset };
    } else if (state.tool === 'lasso') {
      // Finish drawing lasso path
      if (state.lassoPath.length > 2) {
        state.lassoPath.push({ ...state.lassoPath[0] }); // close path
        if (state.lassoShiftKey || state.lassoAltKey) {
          // Boolean operation with existing selection
          lassoPathSelect(state.lassoPath, state.lassoShiftKey, state.lassoAltKey);
        } else {
          state.lassoPaths = [state.lassoPath];
          state.lassoActive = true;
          extractLassoSelection();
          drawLassoSelectionOutline();
        }
      } else {
        // Path too short — only discard if not in modifier mode
        if (!state.lassoShiftKey && !state.lassoAltKey) {
          discardLassoSelection(); // bakes floating pixels if any, then clears
        }
      }
      state.lassoShiftKey = false;
      state.lassoAltKey = false;
    }
    return;
  }

  if (['line','rect','circle','curve'].includes(state.tool)) {
    if (state.tool === 'curve') {
      if (state.curveStep === 0) {
        state.curveStep = 1;
      } else if (state.curveStep === 1) {
        state.curveStep = 2;
      } else if (state.curveStep === 2) {
        finalizeCurve();
        state.curveStep = 0;
        state.curvePoints = [];
      }
    } else {
      commitShape(state.shapeStartX, state.shapeStartY, x, y);
    }
  } else {
    saveHistory();
    // ── Set anchor at the point where the user RELEASED the mouse ──
    const isFreehand = !['line','rect','circle','fill','eyedropper','lasso','curve','magicwand'].includes(state.tool);
    if (isFreehand) {
      state.shiftAnchor = { x: state.lastX, y: state.lastY };
      drawShiftPreview(); // show the anchor dot
    }
  }
});

container.addEventListener('pointerleave', e => {
  if (state.isDrawing && !['line','rect','circle','curve'].includes(state.tool)) {
    state.isDrawing = false;
    if (state.strokeLctx) {
      state.strokeLctx.restore();
      state.strokeLctx = null;
    }

    // Lasso: if path has enough points, close and extract selection on canvas exit
    if (state.tool === 'lasso') {
      if (!state.lassoDragged && state.lassoPath.length > 2) {
        state.lassoPath.push({ ...state.lassoPath[0] }); // close path
        state.lassoPaths = [state.lassoPath];
        state.lassoActive = true;
        extractLassoSelection();
        drawLassoSelectionOutline();
      } else if (!state.lassoDragged) {
        state.lassoDragged = false;
        state.lassoPath = [];
        state.lassoPaths = [];
        pctx.clearRect(0, 0, canvasW, canvasH);
      }
      return;
    }

    saveHistory();
    const isFreehand = !['line','rect','circle','fill','eyedropper','lasso','curve','magicwand'].includes(state.tool);
    if (isFreehand) {
      state.shiftAnchor = { x: state.lastX, y: state.lastY };
    }
  }
});

// ─── Zoom (Mouse Wheel) ──────────────────────────────────────────
container.addEventListener('wheel', e => {
  e.preventDefault();

  // If scrolling with two fingers (trackpad pan) and no Ctrl/Cmd modifier, pan instead of zoom
  if (!e.ctrlKey && !e.metaKey && (Math.abs(e.deltaX) > 0 || Math.abs(e.deltaY) < 40)) {
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    applyTransform();
    return;
  }

  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // Smooth exponential zoom using deltaY intensity (perfect for both trackpad and mouse wheel)
  const factor = Math.exp(-e.deltaY * 0.002);
  const newZoom = Math.min(Math.max(state.zoom * factor, 0.05), 32);

  // Zoom toward cursor position
  state.panX = mouseX - (mouseX - state.panX) * (newZoom / state.zoom);
  state.panY = mouseY - (mouseY - state.panY) * (newZoom / state.zoom);
  state.zoom  = newZoom;

  applyTransform();
}, { passive: false });

function selectAllSelection() {
  if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive && state.lassoTransformMode) {
    return;
  }
  if (state.lassoActive) {
    if (state.tool === 'lasso' || state.tool === 'magicwand') {
      bakeLassoSelection();
    } else {
      bakeFloatingSelectionOnly();
      state.lassoActive = false;
    }
  }

  state.lassoPath = [
    { x: 0, y: 0 },
    { x: canvasW, y: 0 },
    { x: canvasW, y: canvasH },
    { x: 0, y: canvasH },
    { x: 0, y: 0 }
  ];
  state.lassoPaths = [state.lassoPath];
  state.lassoActive = true;
  extractLassoSelection();
  drawLassoSelectionOutline();
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────
let _toolBeforeCtrl = null; // stores the tool active before Ctrl held

document.addEventListener('keydown', e => {
  // Block single-key shortcuts when typing in an input,
  // but ALWAYS allow Ctrl/Meta combos (undo, redo, new canvas, etc.)
  if (e.target.tagName === 'INPUT' && !e.ctrlKey && !e.metaKey) return;

  // Alt+A — Auto Adjust Canvas size to active floating selection
  if (e.altKey && e.code === 'KeyA') {
    e.preventDefault();
    autoAdjustCanvasSize();
    return;
  }

  if (e.key === 'Alt') {
    if (state.tool === 'brush') {
      e.preventDefault();
      state.isAltDrawing = true;
      ensureCursor();
      if (cursorEl) {
        cursorEl.style.border = '1.5px dashed #3498db';
        cursorEl.style.background = 'rgba(52, 152, 219, 0.1)';
      }
    }
  }

  // Enter — apply lasso transform
  if (e.key === 'Enter' && (state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) {
    e.preventDefault();
    bakeLassoSelection();
    return;
  }

  // Space for pan
  if (e.code === 'Space') {
    e.preventDefault();
    if (!state.spaceDown) {
      state.spaceDown = true;
      container.classList.add('panning');
    }
  }

  // Ctrl held alone → temporary eraser (disabled when lasso/magicwand is active tool)
  if ((e.key === 'Control' || e.key === 'Meta') && !state.spaceDown) {
    if (state.tool !== 'eraser' && state.tool !== 'lasso' && state.tool !== 'magicwand') {
      _toolBeforeCtrl = state.tool;
      setTool('eraser');
    }
  }

  // Escape: cancel shift-line anchor OR bake lasso selection
  if (e.key === 'Escape') {
    if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) {
      bakeLassoSelection();
    } else {
      state.shiftAnchor = null;
      clearPreview();
    }
  }

  // Tool shortcuts (single keys, no modifiers)
  const shortcuts = { b: 'pencil', p: 'brush', e: 'eraser', g: 'fill', i: 'eyedropper', l: 'line', r: 'rect', c: 'circle', s: 'lasso', w: 'magicwand' };
  if (!e.ctrlKey && !e.metaKey && shortcuts[e.key.toLowerCase()]) {
    _toolBeforeCtrl = null; // manual switch clears temp eraser memory
    setTool(shortcuts[e.key.toLowerCase()]);
  }

  // Undo / Redo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }

  // Ctrl+A — select all canvas with lasso/magicwand tool
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAllSelection();
  }

  // Ctrl+I — invert selection
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    invertSelection();
  }

  // ── Lasso Copy / Cut / Paste ───────────────────────────────────────────
  // Ctrl+C — copy selection to internal clipboard (keeps selection active)
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && state.lassoActive) {
    e.preventDefault();
    const wasFloating = !!state.lassoSelectionCanvas;
    if (!wasFloating) {
      extractLassoSelection(null, true);
    }
    if (state.lassoSelectionCanvas) {
      const copy = document.createElement('canvas');
      copy.width  = state.lassoSelectionCanvas.width;
      copy.height = state.lassoSelectionCanvas.height;
      copy.getContext('2d').drawImage(state.lassoSelectionCanvas, 0, 0);
      
      const dx = state.lassoCurrentOffset.x;
      const dy = state.lassoCurrentOffset.y;
      const paths = state.lassoPaths && state.lassoPaths.length > 0 ? state.lassoPaths : [state.lassoPath];
      state.lassoClipboard = {
        canvas: copy,
        path: state.lassoPath.map(p => ({ x: p.x + dx, y: p.y + dy })),
        paths: paths.map(path => path.map(p => ({ x: p.x + dx, y: p.y + dy }))),
        boundingBox: {
          x: state.lassoBoundingBox.x + dx,
          y: state.lassoBoundingBox.y + dy,
          w: state.lassoBoundingBox.w,
          h: state.lassoBoundingBox.h
        },
        maskCanvas: state.lassoMaskCanvas
      };
      // Write to OS Clipboard as PNG
      copy.toBlob(blob => {
        if (navigator.clipboard && navigator.clipboard.write) {
          try { navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch(err) {}
        }
      });
    }
    if (!wasFloating) {
      bakeFloatingSelectionOnly();
    } else {
      drawLassoSelectionOutline();
    }
  }

  // Ctrl+X — cut: copy selection to clipboard, then immediately erase/remove the selection
  if ((e.ctrlKey || e.metaKey) && e.key === 'x' && state.lassoActive) {
    e.preventDefault();
    const wasFloating = !!state.lassoSelectionCanvas;
    if (!wasFloating) {
      extractLassoSelection(null, true);
    }
    if (state.lassoSelectionCanvas) {
      const copy = document.createElement('canvas');
      copy.width  = state.lassoSelectionCanvas.width;
      copy.height = state.lassoSelectionCanvas.height;
      copy.getContext('2d').drawImage(state.lassoSelectionCanvas, 0, 0);

      const dx = state.lassoCurrentOffset.x;
      const dy = state.lassoCurrentOffset.y;
      const paths = state.lassoPaths && state.lassoPaths.length > 0 ? state.lassoPaths : [state.lassoPath];
      state.lassoClipboard = {
        canvas: copy,
        path: state.lassoPath.map(p => ({ x: p.x + dx, y: p.y + dy })),
        paths: paths.map(path => path.map(p => ({ x: p.x + dx, y: p.y + dy }))),
        boundingBox: {
          x: state.lassoBoundingBox.x + dx,
          y: state.lassoBoundingBox.y + dy,
          w: state.lassoBoundingBox.w,
          h: state.lassoBoundingBox.h
        },
        maskCanvas: state.lassoMaskCanvas
      };

      // Write to OS Clipboard as PNG
      copy.toBlob(blob => {
        if (navigator.clipboard && navigator.clipboard.write) {
          try { navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch(err) {}
        }
      });
    }

    // Discard the selection immediately (hole remains permanent on the layer)
    // Note: at this point the floating canvas holds the cut pixels,
    // discardLassoSelection would bake them back — so we need to manually
    // clear the selection canvas BEFORE discarding to keep the hole.
    state.lassoSelectionCanvas = null;
    discardLassoSelection();
    compositeAll();
    saveHistory(); // Save so Ctrl+Z can restore the cut state
  }

  // Ctrl+V — paste: create a new floating lasso selection from clipboard
  if ((e.ctrlKey || e.metaKey) && e.key === 'v' && state.lassoClipboard) {
    e.preventDefault();
    if (state.lassoActive) {
      // Bake any current selection back before pasting the new one
      bakeLassoSelection();
    }
    // Switch to lasso tool if needed
    if (state.tool !== 'lasso' && state.tool !== 'magicwand') setTool('lasso');
    
    // Ensure active layer frame canvas exists
    getLCtx();

    // Clone the clipboard canvas
    const copy = document.createElement('canvas');
    copy.width  = state.lassoClipboard.canvas.width;
    copy.height = state.lassoClipboard.canvas.height;
    copy.getContext('2d').drawImage(state.lassoClipboard.canvas, 0, 0);
    
    // Restore as a fresh floating selection at the copied position
    state.lassoPaths           = state.lassoClipboard.paths ? state.lassoClipboard.paths.map(path => path.map(p => ({ ...p }))) : [state.lassoClipboard.path.map(p => ({ ...p }))];
    state.lassoPath            = state.lassoPaths[0] || state.lassoClipboard.path.map(p => ({ ...p }));
    state.lassoBoundingBox     = { ...state.lassoClipboard.boundingBox };
    state.lassoSelectionCanvas = copy;
    
    // Clone mask canvas if it exists, otherwise reconstruct
    if (state.lassoClipboard.maskCanvas) {
      const maskCopy = document.createElement('canvas');
      maskCopy.width = state.lassoClipboard.maskCanvas.width;
      maskCopy.height = state.lassoClipboard.maskCanvas.height;
      maskCopy.getContext('2d').drawImage(state.lassoClipboard.maskCanvas, 0, 0);
      state.lassoMaskCanvas = maskCopy;
    } else {
      const maskCopy = document.createElement('canvas');
      maskCopy.width = copy.width;
      maskCopy.height = copy.height;
      const mc = maskCopy.getContext('2d');
      mc.fillStyle = 'white';
      mc.fillRect(0, 0, copy.width, copy.height);
      state.lassoMaskCanvas = maskCopy;
    }

    state.lassoActive          = true;
    state.lassoCurrentOffset   = { x: 0, y: 0 };
    state.lassoPrevOffset      = { x: 0, y: 0 };
    state.lassoStartOffset     = { x: 0, y: 0 };
    state.lassoDragged         = false;
    
    updateSelectionMask();
    compositeAll();
    drawLassoSelectionOutline();
    saveHistory(); // Save so Ctrl+Z can undo the paste
  }

  // New canvas
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); showNewCanvasModal(); }

  // Save / Open project
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveProject(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); openProject(); }


  // Comma / Period: navigate frames
  if (e.key === ',' || e.key === '<') {
    e.preventDefault();
    setCurrentFrame(state.currentFrame - 1);
  }
  if (e.key === '.' || e.key === '>') {
    e.preventDefault();
    setCurrentFrame(state.currentFrame + 1);
  }
  // Arrow keys: navigate frames (only when not drawing on canvas)
  if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setCurrentFrame(state.currentFrame - 1);
  }
  if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setCurrentFrame(state.currentFrame + 1);
  }

  // [ / ] brush size
  if (e.key === '[') { setBrushSize(Math.max(1, state.brushSize - 2)); }
  if (e.key === ']') { setBrushSize(Math.min(200, state.brushSize + 2)); }

  // X = swap colors (only without Ctrl/Meta to avoid conflict with Ctrl+X cut)
  if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey) swapColors();
});

document.addEventListener('keyup', e => {
  if (e.key === 'Alt') {
    if (state.tool === 'brush') {
      e.preventDefault();
      state.isAltDrawing = false;
      ensureCursor();
      if (cursorEl) {
        cursorEl.style.border = '1.5px solid rgba(255,255,255,0.8)';
        cursorEl.style.background = 'rgba(255,255,255,0.08)';
      }
    }
  }
  if (e.code === 'Space') {
    state.spaceDown = false;
    container.classList.remove('panning');
    container.classList.remove('panning-active');
  }

  // Ctrl released → restore tool that was active before
  if (e.key === 'Control' || e.key === 'Meta') {
    if (_toolBeforeCtrl && state.tool === 'eraser') {
      setTool(_toolBeforeCtrl);
    }
    _toolBeforeCtrl = null;
  }
});

// Clear internal clipboard if user leaves the tab (so external copy takes precedence on Ctrl+V)
window.addEventListener('blur', () => {
  state.lassoClipboard = null;
});

// ─── Global Paste Event (External Images) ────────────────────────
document.addEventListener('paste', (e) => {
  if (!e.clipboardData || !e.clipboardData.items) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      
      const img = new Image();
      img.onload = () => {
        if (state.tool !== 'lasso' && state.tool !== 'magicwand') setTool('lasso');
        if (state.lassoActive) bakeLassoSelection();

        // Ensure active layer frame canvas exists
        getLCtx();

        const copy = document.createElement('canvas');
        copy.width = img.width;
        copy.height = img.height;
        copy.getContext('2d').drawImage(img, 0, 0);

        // Center on screen
        const cx = Math.floor(canvasW / 2 - img.width / 2);
        const cy = Math.floor(canvasH / 2 - img.height / 2);

        state.lassoPath = [
          {x: cx, y: cy},
          {x: cx + img.width, y: cy},
          {x: cx + img.width, y: cy + img.height},
          {x: cx, y: cy + img.height},
          {x: cx, y: cy}
        ];
        state.lassoPaths = [state.lassoPath];
        state.lassoBoundingBox = { x: cx, y: cy, w: img.width, h: img.height };
        state.lassoSelectionCanvas = copy;

        // Reconstruct rectangular mask canvas
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = img.width;
        maskCanvas.height = img.height;
        const mc = maskCanvas.getContext('2d');
        mc.fillStyle = 'white';
        mc.fillRect(0, 0, img.width, img.height);
        state.lassoMaskCanvas = maskCanvas;

        state.lassoActive = true;
        state.lassoCurrentOffset = { x: 0, y: 0 };
        state.lassoPrevOffset = { x: 0, y: 0 };
        state.lassoStartOffset = { x: 0, y: 0 };
        state.lassoDragged = false;
        state.lassoRotation = 0;
        state.lassoScaleX = 1;
        state.lassoScaleY = 1;
        state.lassoBaseScale = 1;
        state.lassoBaseScaleX = 1;
        state.lassoBaseScaleY = 1;
        state.lassoBaseRotation = 0;
        state.lassoTransformMode = false;
        
        updateSelectionMask();

        const transformBtn = document.getElementById('btn-lasso-transform');
        if (transformBtn) {
          transformBtn.classList.remove('hidden');
          transformBtn.classList.remove('active');
        }

        compositeAll();
        drawLassoSelectionOutline();
        saveHistory(); // Save so Ctrl+Z can undo the paste
      };
      
      const reader = new FileReader();
      reader.onload = (event) => { img.src = event.target.result; };
      reader.readAsDataURL(file);
      e.preventDefault();
      break;
    }
  }
});

// ─── Image Import and Canvas File Drop ─────────────────────────
const IMAGE_FILE_EXTENSIONS = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const VIDEO_FILE_EXTENSIONS = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;

function isImageFile(file) {
  return !!file && (file.type.startsWith('image/') || IMAGE_FILE_EXTENSIONS.test(file.name));
}

function isVideoFile(file) {
  return !!file && (file.type.startsWith('video/') || VIDEO_FILE_EXTENSIONS.test(file.name));
}

function importImageFile(file) {
  if (!isImageFile(file)) return Promise.resolve(false);

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      if (state.lassoActive) bakeLassoSelection();

      const imageWidth = img.naturalWidth || img.width;
      const imageHeight = img.naturalHeight || img.height;
      const scale = Math.min(1, canvasW / imageWidth, canvasH / imageHeight);
      const drawWidth = Math.max(1, Math.round(imageWidth * scale));
      const drawHeight = Math.max(1, Math.round(imageHeight * scale));
      const drawX = Math.floor((canvasW - drawWidth) / 2);
      const drawY = Math.floor((canvasH - drawHeight) / 2);
      const layerName = file.name.replace(/\.[^.]+$/, '').substring(0, 40) || 'Image';
      const imageLayer = createLayerData(layerName);
      const frame = imageLayer.frames[state.currentFrame];

      frame.canvas = document.createElement('canvas');
      frame.canvas.width = canvasW;
      frame.canvas.height = canvasH;
      frame.ctx = frame.canvas.getContext('2d');
      frame.ctx.imageSmoothingEnabled = true;
      frame.ctx.imageSmoothingQuality = 'high';
      frame.ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      frame.isKeyframe = true;
      syncBackingCanvas(frame);

      layers.splice(activeLayerIdx, 0, imageLayer);
      renderLayerPanel();
      renderTimeline();
      compositeAll();
      saveHistory();
      showToast(`🖼️ ${file.name} imported!`);
      URL.revokeObjectURL(objectUrl);
      resolve(true);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      showToast(`⚠️ Could not import ${file.name}`);
      resolve(false);
    };

    img.src = objectUrl;
  });
}

window.importImageFile = importImageFile;

const imageFileInput = document.getElementById('image-input');
document.getElementById('menu-import-image').addEventListener('click', () => {
  document.getElementById('menu-arquivo-dropdown').classList.remove('show');
  imageFileInput.value = '';
  imageFileInput.click();
});

imageFileInput.addEventListener('change', async () => {
  for (const file of imageFileInput.files) {
    await importImageFile(file);
  }
});

let canvasFileDragDepth = 0;

function eventContainsFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

container.addEventListener('dragenter', (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();
  canvasFileDragDepth++;
  container.classList.add('drag-import-active');
});

container.addEventListener('dragover', (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

container.addEventListener('dragleave', (event) => {
  if (!eventContainsFiles(event)) return;
  canvasFileDragDepth = Math.max(0, canvasFileDragDepth - 1);
  if (canvasFileDragDepth === 0) container.classList.remove('drag-import-active');
});

container.addEventListener('drop', async (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();
  canvasFileDragDepth = 0;
  container.classList.remove('drag-import-active');

  const files = Array.from(event.dataTransfer.files);
  const supportedFiles = files.filter(file => isImageFile(file) || isVideoFile(file));

  if (!supportedFiles.length) {
    showToast('⚠️ Drop an image or video file here');
    return;
  }

  for (const file of supportedFiles) {
    if (isImageFile(file)) {
      await importImageFile(file);
    } else if (typeof window.importVideoFile === 'function') {
      await window.importVideoFile(file);
    }
  }
});

// ─── Tool Selection ──────────────────────────────────────────────
const SIZED_TOOLS = ['pencil', 'brush', 'eraser', 'line', 'rect', 'circle', 'curve'];

function setTool(tool) {
  // Bake any floating lasso/magicwand selection before leaving selection tools
  if ((state.tool === 'lasso' || state.tool === 'magicwand') && (tool !== 'lasso' && tool !== 'magicwand')) {
    bakeFloatingSelectionOnly();
  }
  
  if (state.tool === 'curve' && tool !== 'curve') {
    state.curveStep = 0;
    state.curvePoints = [];
    pctx.clearRect(0, 0, canvasW, canvasH);
  }

  // Save current tool's size before leaving it
  if (SIZED_TOOLS.includes(state.tool)) {
    state.toolSizes[state.tool] = state.brushSize;
    // Synced tools: pencil, line, curve share the same size
    if (['pencil', 'line', 'curve'].includes(state.tool)) {
      state.toolSizes['pencil'] = state.brushSize;
      state.toolSizes['line'] = state.brushSize;
      state.toolSizes['curve'] = state.brushSize;
    }
  }

  state.tool = tool;
  state.shiftAnchor = null;
  clearPreview();

  // Restore the new tool's individual size
  if (SIZED_TOOLS.includes(tool)) {
    const sz = state.toolSizes[tool];
    state.brushSize = sz;
    const slider = document.getElementById('brush-size');
    const label  = document.getElementById('brush-size-val');
    if (slider) slider.value = sz;
    if (label)  label.textContent = sz + 'px';
  }

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  // Cursor
  const cursors = {
    pencil: 'cursor-pencil', brush: 'cursor-pencil',
    eraser: 'cursor-eraser', fill: 'cursor-fill',
    eyedropper: 'cursor-eyedropper', line: 'cursor-line',
    rect: 'cursor-rect', circle: 'cursor-circle',
    lasso: 'cursor-lasso', magicwand: 'cursor-lasso',
  };
  container.className = '';
  if (cursors[tool]) container.classList.add(cursors[tool]);

  document.getElementById('tool-status').textContent =
    { pencil:'Pencil active', brush:'Brush active', eraser:'Eraser active',
      fill:'Bucket active', eyedropper:'Eyedropper active',
      line:'Line active', rect:'Rectangle active', circle:'Ellipse active',
      lasso:'Lasso active', magicwand:'Magic Wand active' }[tool] || tool;

  const transformBtn = document.getElementById('btn-lasso-transform');
  if (tool !== 'lasso' && tool !== 'magicwand') {
    if (state.lassoActive) bakeLassoSelection();
    if (transformBtn) {
      transformBtn.classList.add('hidden');
      transformBtn.classList.remove('active');
    }
  } else if (state.lassoActive) {
    if (transformBtn) transformBtn.classList.remove('hidden');
  }

  // Toggle header options containers
  const sizeOpts = document.getElementById('size-option-container');
  const opacityOpts = document.getElementById('opacity-option-container');
  const thresholdOpts = document.getElementById('threshold-option-container');
  const lassoOpts = document.getElementById('lasso-options-container');
  const hardnessOpts = document.getElementById('hardness-option-container');
  const spacingOpts = document.getElementById('spacing-option-container');
  const blurRadiusOpts = document.getElementById('blur-radius-option-container');
  const blurStrengthOpts = document.getElementById('blur-strength-option-container');

  if (sizeOpts) sizeOpts.style.display = 'none';
  if (opacityOpts) opacityOpts.style.display = 'none';
  if (thresholdOpts) thresholdOpts.style.display = 'none';
  if (lassoOpts) lassoOpts.style.display = 'none';
  if (hardnessOpts) hardnessOpts.style.display = 'none';
  if (spacingOpts) spacingOpts.style.display = 'none';
  if (blurRadiusOpts) blurRadiusOpts.style.display = 'none';
  if (blurStrengthOpts) blurStrengthOpts.style.display = 'none';

  if (tool === 'lasso') {
    if (lassoOpts) lassoOpts.style.display = 'flex';
  } else if (tool === 'magicwand') {
    if (thresholdOpts) thresholdOpts.style.display = 'flex';
  } else if (tool === 'fill') {
    if (opacityOpts) opacityOpts.style.display = 'flex';
    if (thresholdOpts) thresholdOpts.style.display = 'flex';
  } else if (['pencil', 'brush', 'eraser', 'line', 'rect', 'circle', 'curve'].includes(tool)) {
    if (sizeOpts) sizeOpts.style.display = 'flex';
    if (opacityOpts) opacityOpts.style.display = 'flex';
    if (tool === 'brush') {
      if (hardnessOpts) hardnessOpts.style.display = 'flex';
      if (spacingOpts) spacingOpts.style.display = 'flex';
      if (blurRadiusOpts) blurRadiusOpts.style.display = 'flex';
      if (blurStrengthOpts) blurStrengthOpts.style.display = 'flex';
      updateBrushTip();
    }
  }
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// Lasso Type Selection Buttons
const btnLassoFree = document.getElementById('btn-lasso-free');
const btnLassoRect = document.getElementById('btn-lasso-rect');
if (btnLassoFree && btnLassoRect) {
  btnLassoFree.addEventListener('click', () => {
    state.lassoType = 'free';
    btnLassoFree.classList.add('active');
    btnLassoRect.classList.remove('active');
  });
  btnLassoRect.addEventListener('click', () => {
    state.lassoType = 'rect';
    btnLassoRect.classList.add('active');
    btnLassoFree.classList.remove('active');
  });
}

// ─── Brush Size ──────────────────────────────────────────────────
const brushSizeSlider = document.getElementById('brush-size');
const brushSizeVal    = document.getElementById('brush-size-val');

function setBrushSize(v) {
  state.brushSize = v;
  brushSizeSlider.value = v;
  brushSizeVal.textContent = v + 'px';
  // Persist the new size into the per-tool memory
  if (SIZED_TOOLS.includes(state.tool)) {
    state.toolSizes[state.tool] = v;
    // Synced tools: pencil, line, curve share the same size
    if (['pencil', 'line', 'curve'].includes(state.tool)) {
      state.toolSizes['pencil'] = v;
      state.toolSizes['line'] = v;
      state.toolSizes['curve'] = v;
    }
  }
  updateBrushTip();
}

brushSizeSlider.addEventListener('input', () => setBrushSize(parseInt(brushSizeSlider.value)));
// Return focus to document after slider use so keyboard shortcuts keep working
brushSizeSlider.addEventListener('pointerup', () => brushSizeSlider.blur());
brushSizeSlider.addEventListener('change',    () => brushSizeSlider.blur());

// ─── Opacity ─────────────────────────────────────────────────────
const opacitySlider = document.getElementById('brush-opacity');
const opacityVal    = document.getElementById('brush-opacity-val');

opacitySlider.addEventListener('input', () => {
  state.opacity = parseInt(opacitySlider.value) / 100;
  opacityVal.textContent = opacitySlider.value + '%';
});
opacitySlider.addEventListener('pointerup', () => opacitySlider.blur());
opacitySlider.addEventListener('change',    () => opacitySlider.blur());

// ─── Hardness ────────────────────────────────────────────────────
const hardnessSlider = document.getElementById('brush-hardness');
const hardnessVal    = document.getElementById('brush-hardness-val');

if (hardnessSlider && hardnessVal) {
  hardnessSlider.addEventListener('input', () => {
    state.brushHardness = parseInt(hardnessSlider.value);
    hardnessVal.textContent = hardnessSlider.value + '%';
    updateBrushTip();
  });
  hardnessSlider.addEventListener('pointerup', () => hardnessSlider.blur());
  hardnessSlider.addEventListener('change',    () => hardnessSlider.blur());
}

// ─── Spacing ─────────────────────────────────────────────────────
const spacingSlider = document.getElementById('brush-spacing');
const spacingVal    = document.getElementById('brush-spacing-val');

if (spacingSlider && spacingVal) {
  spacingSlider.addEventListener('input', () => {
    state.brushSpacing = parseInt(spacingSlider.value) / 100;
    spacingVal.textContent = spacingSlider.value + '%';
  });
  spacingSlider.addEventListener('pointerup', () => spacingSlider.blur());
  spacingSlider.addEventListener('change',    () => spacingSlider.blur());
}

// ─── Blur Radius ─────────────────────────────────────────────────
const blurRadiusSlider = document.getElementById('brush-blur-radius');
const blurRadiusVal    = document.getElementById('brush-blur-radius-val');

if (blurRadiusSlider && blurRadiusVal) {
  blurRadiusSlider.addEventListener('input', () => {
    state.brushBlurRadius = parseInt(blurRadiusSlider.value);
    blurRadiusVal.textContent = blurRadiusSlider.value + 'px';
  });
  blurRadiusSlider.addEventListener('pointerup', () => blurRadiusSlider.blur());
  blurRadiusSlider.addEventListener('change',    () => blurRadiusSlider.blur());
}

// ─── Blur Strength ───────────────────────────────────────────────
const blurStrengthSlider = document.getElementById('brush-blur-strength');
const blurStrengthVal    = document.getElementById('brush-blur-strength-val');

if (blurStrengthSlider && blurStrengthVal) {
  blurStrengthSlider.addEventListener('input', () => {
    state.brushBlurStrength = parseInt(blurStrengthSlider.value) / 100;
    blurStrengthVal.textContent = blurStrengthSlider.value + '%';
  });
  blurStrengthSlider.addEventListener('pointerup', () => blurStrengthSlider.blur());
  blurStrengthSlider.addEventListener('change',    () => blurStrengthSlider.blur());
}

// ─── Bucket Threshold ─────────────────────────────────────────────
const bucketThresholdSlider = document.getElementById('bucket-threshold');
const bucketThresholdVal    = document.getElementById('bucket-threshold-val');
const allLayersToggle       = document.getElementById('all-layers-toggle');

if (bucketThresholdSlider && bucketThresholdVal) {
  bucketThresholdSlider.addEventListener('input', () => {
    state.bucketThreshold = parseInt(bucketThresholdSlider.value);
    bucketThresholdVal.textContent = bucketThresholdSlider.value;
  });
  bucketThresholdSlider.addEventListener('pointerup', () => bucketThresholdSlider.blur());
  bucketThresholdSlider.addEventListener('change',    () => bucketThresholdSlider.blur());
}

if (allLayersToggle) {
  allLayersToggle.addEventListener('change', () => {
    state.allLayersActive = allLayersToggle.checked;
  });
}

const antiAliasToggle = document.getElementById('anti-alias-toggle');
if (antiAliasToggle) {
  antiAliasToggle.addEventListener('change', () => {
    updateBrushTip();
    antiAliasToggle.blur();
  });
}

// ─── Color Management ────────────────────────────────────────────
const colorPicker  = document.getElementById('color-picker');
const colorHexLabel = document.getElementById('color-hex-label');
const fgSwatch     = document.getElementById('color-fg-swatch');
const bgSwatch     = document.getElementById('color-bg-swatch');

function setFgColor(hex) {
  state.fgColor = hex;
  colorPicker.value = hex;
  fgSwatch.style.background = hex;
  colorHexLabel.textContent = hex.toUpperCase();
  updateBrushTip();
}

function setBgColor(hex) {
  state.bgColor = hex;
  bgSwatch.style.background = hex;
}

colorPicker.addEventListener('input', () => setFgColor(colorPicker.value));

fgSwatch.addEventListener('click', () => colorPicker.click());
bgSwatch.addEventListener('click', () => {
  const tmp = document.createElement('input');
  tmp.type = 'color';
  tmp.value = state.bgColor;
  tmp.style.display = 'none';
  document.body.appendChild(tmp);
  tmp.click();
  tmp.addEventListener('input', () => setBgColor(tmp.value));
  tmp.addEventListener('change', () => tmp.remove());
});

function swapColors() {
  const tmp = state.fgColor;
  setFgColor(state.bgColor);
  setBgColor(tmp);
}

document.getElementById('swap-colors').addEventListener('click', swapColors);

// ─── Palette ─────────────────────────────────────────────────────
const palette = [
  '#0d0d14','#ffffff','#ffc198','#1f3a93','#2f80ed',
  '#56ccf2','#27ae60','#6fcf97','#f2c94c','#f2994a',
  '#eb5757','#c0392b','#9b51e0','#bb6bd9','#e84393',
  '#8d5524','#c68642','#4f4f4f','#828282','#bdbdbd',
];

const paletteGrid = document.getElementById('palette-grid');
palette.forEach(color => {
  const sw = document.createElement('div');
  sw.className = 'palette-swatch';
  sw.style.background = color;
  sw.title = color;
  sw.addEventListener('click', () => {
    document.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('selected'));
    sw.classList.add('selected');
    setFgColor(color);
  });
  paletteGrid.appendChild(sw);
});
// ─── Action Buttons ──────────────────────────────────────────────
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

function clearActiveCanvas() {
  const lctx = getLCtx(); if (!lctx) return;
  lctx.clearRect(0, 0, canvasW, canvasH);
  const f = layers[activeLayerIdx]?.frames[state.currentFrame];
  if (f) {
    f.offsetX = 0;
    f.offsetY = 0;
    f.backingCanvas = null;
  }
  compositeAll();
  saveHistory();
}

document.getElementById('btn-clear-layer').addEventListener('click', clearActiveCanvas);

document.getElementById('btn-export').addEventListener('click', () => {
  state.isExporting = true;
  compositeAll();
  const link = document.createElement('a');
  link.download = 'ilustra_' + Date.now() + '.png';
  link.href = mainCanvas.toDataURL('image/png');
  link.click();
  state.isExporting = false;
  compositeAll();
});

// ─── New Canvas Modal ────────────────────────────────────────────
function showNewCanvasModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('menu-arquivo-dropdown').classList.remove('show');
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});
document.getElementById('modal-create').addEventListener('click', () => {
  const w  = parseInt(document.getElementById('new-width').value) || 1280;
  const h  = parseInt(document.getElementById('new-height').value) || 720;
  const bg = document.getElementById('new-bg').value;
  state.history = [];
  state.redoStack = [];
  window.currentProjectHandle = null; // new project — next save must ask for location
  window.currentProjectName = null;
  document.title = "Illustra — Software de Ilustração";
  initCanvas(w, h, bg);
  setBgColor(bg);
  document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.add('hidden');
});

// ─── Dropdown Menu Controls ─────────────────────────────────────
// Arquivo dropdown
const btnNew = document.getElementById('btn-new');
const menuArquivo = document.getElementById('menu-arquivo-dropdown');

btnNew.addEventListener('click', (e) => {
  e.stopPropagation();
  menuArquivo.classList.toggle('show');
  menuEditar.classList.remove('show');
  menuSelect.classList.remove('show');
});

document.getElementById('menu-new-canvas').addEventListener('click', () => {
  showNewCanvasModal();
});

// Editar dropdown
const btnEdit = document.getElementById('btn-edit');
const menuEditar = document.getElementById('menu-editar-dropdown');

btnEdit.addEventListener('click', (e) => {
  e.stopPropagation();
  const hasSelection = !!(state.lassoActive && state.lassoSelectionCanvas && state.lassoBoundingBox);
  const autoAdjustBtn = document.getElementById('menu-auto-adjust');
  if (autoAdjustBtn) {
    autoAdjustBtn.disabled = false;
  }
  menuEditar.classList.toggle('show');
  menuArquivo.classList.remove('show');
  menuSelect.classList.remove('show');
});

// ─── Background mode handlers ─────────────────────────────────────
// Clicking inside the bg submenu must not close the Editar dropdown
document.getElementById('bg-submenu').addEventListener('click', (e) => {
  e.stopPropagation();
});
document.getElementById('bg-submenu-wrapper').addEventListener('click', (e) => {
  e.stopPropagation();
});

// Radio change → apply bgMode immediately
document.querySelectorAll('input[name="bgMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    state.bgMode = radio.value;
    compositeAll();
  });
});

// Color picker for "Color" and "Transparency(Color)" modes
const bgColorPick = document.getElementById('bg-color-pick');
bgColorPick.addEventListener('input', () => {
  state.bgColor = bgColorPick.value;
  if (state.bgMode === 'color' || state.bgMode === 'trans-color') {
    compositeAll();
  }
});
bgColorPick.addEventListener('click', (e) => e.stopPropagation());



// Select dropdown
const btnSelect = document.getElementById('btn-select');
const menuSelect = document.getElementById('menu-select-dropdown');
const selectModifyOverlay = document.getElementById('select-modify-overlay');
const selectModifyTitle = document.getElementById('select-modify-title');
const selectModifyAmount = document.getElementById('select-modify-amount');

btnSelect.addEventListener('click', (e) => {
  e.stopPropagation();
  menuSelect.classList.toggle('show');
  menuArquivo.classList.remove('show');
  menuEditar.classList.remove('show');
  
  // Update enabled/disabled status of Select More & Select Less
  const selectMoreBtn = document.getElementById('menu-select-more');
  const selectLessBtn = document.getElementById('menu-select-less');
  if (state.lassoActive) {
    selectMoreBtn.style.opacity = '1';
    selectMoreBtn.style.pointerEvents = 'auto';
    selectLessBtn.style.opacity = '1';
    selectLessBtn.style.pointerEvents = 'auto';
  } else {
    selectMoreBtn.style.opacity = '0.4';
    selectMoreBtn.style.pointerEvents = 'none';
    selectLessBtn.style.opacity = '0.4';
    selectLessBtn.style.pointerEvents = 'none';
  }
});

document.getElementById('menu-select-more').addEventListener('click', () => {
  menuSelect.classList.remove('show');
  if (!state.lassoActive) return;
  selectModifyTitle.textContent = 'Expand Selection';
  selectModifyAmount.value = 1;
  state.selectModifyMode = 'expand';
  selectModifyOverlay.classList.remove('hidden');
  selectModifyAmount.focus();
  selectModifyAmount.select();
});

document.getElementById('menu-select-less').addEventListener('click', () => {
  menuSelect.classList.remove('show');
  if (!state.lassoActive) return;
  selectModifyTitle.textContent = 'Contract Selection';
  selectModifyAmount.value = 1;
  state.selectModifyMode = 'contract';
  selectModifyOverlay.classList.remove('hidden');
  selectModifyAmount.focus();
  selectModifyAmount.select();
});

document.getElementById('menu-select-invert').addEventListener('click', () => {
  menuSelect.classList.remove('show');
  invertSelection();
});

document.getElementById('menu-select-all').addEventListener('click', () => {
  menuSelect.classList.remove('show');
  selectAllSelection();
});

document.getElementById('select-modify-cancel').addEventListener('click', () => {
  selectModifyOverlay.classList.add('hidden');
});

selectModifyOverlay.addEventListener('click', e => {
  if (e.target === selectModifyOverlay) {
    selectModifyOverlay.classList.add('hidden');
  }
});

document.getElementById('select-modify-apply').addEventListener('click', () => {
  const val = parseInt(selectModifyAmount.value) || 1;
  modifySelection(val, state.selectModifyMode === 'expand');
  selectModifyOverlay.classList.add('hidden');
});

selectModifyAmount.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    document.getElementById('select-modify-apply').click();
  }
  if (e.key === 'Escape') {
    selectModifyOverlay.classList.add('hidden');
  }
});

document.addEventListener('click', () => {
  menuArquivo.classList.remove('show');
  menuEditar.classList.remove('show');
  menuSelect.classList.remove('show');
});

function modifySelection(amount, expand) {
  const lctx = getLCtx();
  if (!lctx || !state.lassoActive || !state.lassoSelectionCanvas || !state.lassoBoundingBox) return;

  const ox = state.lassoCurrentOffset.x;
  const oy = state.lassoCurrentOffset.y;
  const bx = Math.round(state.lassoBoundingBox.x + ox);
  const by = Math.round(state.lassoBoundingBox.y + oy);
  const bw = state.lassoBoundingBox.w;
  const bh = state.lassoBoundingBox.h;
  
  const cx = bx + bw / 2;
  const cy = by + bh / 2;

  // Restore the original pixels back onto the layer temporarily
  lctx.save();
  lctx.globalCompositeOperation = 'source-over';
  lctx.imageSmoothingEnabled = isAntiAliasingEnabled();
  lctx.translate(cx, cy);
  lctx.rotate(state.lassoRotation || 0);
  lctx.scale(state.lassoScaleX || 1, state.lassoScaleY || 1);
  lctx.translate(-cx, -cy);
  lctx.drawImage(state.lassoSelectionCanvas, bx, by);
  lctx.restore();

  const src = new Uint8Array(canvasW * canvasH);
  if (state.selectionMask) {
    const rx = Math.round(ox);
    const ry = Math.round(oy);
    for (let y = 0; y < canvasH; y++) {
      const ny = y + ry;
      if (ny < 0 || ny >= canvasH) continue;
      for (let x = 0; x < canvasW; x++) {
        const nx = x + rx;
        if (nx < 0 || nx >= canvasW) continue;
        if (state.selectionMask[x + y * canvasW] === 1) {
          src[nx + ny * canvasW] = 1;
        }
      }
    }
  } else {
    // Fallback to paths if selectionMask is not available
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasW;
    tempCanvas.height = canvasH;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.fillStyle = 'white';
    const paths = state.lassoPaths && state.lassoPaths.length > 0 ? state.lassoPaths : (state.lassoPath && state.lassoPath.length > 2 ? [state.lassoPath] : []);
    paths.forEach(path => {
      if (path.length < 2) return;
      tempCtx.beginPath();
      tempCtx.moveTo(path[0].x + ox, path[0].y + oy);
      for (let i = 1; i < path.length; i++) {
        tempCtx.lineTo(path[i].x + ox, path[i].y + oy);
      }
      tempCtx.closePath();
      tempCtx.fill();
      for (let i = 0; i < path.length; i++) {
        tempCtx.fillRect(path[i].x + ox, path[i].y + oy, 1, 1);
      }
    });
    const imgData = tempCtx.getImageData(0, 0, canvasW, canvasH);
    const data = imgData.data;
    for (let i = 0; i < src.length; i++) {
      src[i] = data[i * 4 + 3] > 0 ? 1 : 0;
    }
  }

  const dest = new Uint8Array(canvasW * canvasH);
  const N = amount;

  if (expand) {
    for (let y = 0; y < canvasH; y++) {
      for (let x = 0; x < canvasW; x++) {
        let found = false;
        for (let dy = -N; dy <= N; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= canvasH) continue;
          for (let dx = -N; dx <= N; dx++) {
            if (dx*dx + dy*dy > N*N) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= canvasW) continue;
            if (src[nx + ny * canvasW] === 1) {
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (found) {
          dest[x + y * canvasW] = 1;
        }
      }
    }
  } else {
    for (let y = 0; y < canvasH; y++) {
      for (let x = 0; x < canvasW; x++) {
        let allMatch = true;
        for (let dy = -N; dy <= N; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= canvasH) {
            allMatch = false;
            break;
          }
          for (let dx = -N; dx <= N; dx++) {
            if (dx*dx + dy*dy > N*N) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= canvasW) {
              allMatch = false;
              break;
            }
            if (src[nx + ny * canvasW] === 0) {
              allMatch = false;
              break;
            }
          }
          if (!allMatch) break;
        }
        if (allMatch) {
          dest[x + y * canvasW] = 1;
        }
      }
    }
  }

  // Trace all contours
  const newPaths = traceMaskContours(dest);

  if (newPaths.length > 0) {
    state.lassoPaths = newPaths;
    state.lassoPath = newPaths[0]; // fallback
    state.lassoActive = true;
    extractLassoSelection(dest);
    drawLassoSelectionOutline();
  } else {
    state.lassoActive = false;
    state.lassoPath = [];
    state.lassoPaths = [];
    state.lassoSelectionCanvas = null;
    state.lassoMaskCanvas = null;
    state.lassoBoundingBox = null;
    pctx.clearRect(0, 0, canvasW, canvasH);
    compositeAll();
  }
  saveHistory();
}



// ─── Toast Notification ───────────────────────────────────────────
function showToast(message) {
  let toast = document.getElementById('illustra-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'illustra-toast';
    toast.style.cssText = `
      position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
      background: var(--bg-elevated, #1e1e2e);
      border: 1px solid var(--border-light, rgba(255,255,255,0.12));
      color: var(--text-primary, #e2e2f0);
      font-family: var(--font, 'Inter', sans-serif);
      font-size: 13px; font-weight: 500;
      padding: 10px 22px; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      z-index: 99999; pointer-events: none;
      transition: opacity 0.3s; opacity: 0;
    `;
    document.body.appendChild(toast);
  }
  clearTimeout(toast._timer);
  toast.textContent = message;
  toast.style.opacity = '1';
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}




// ─── Save Image As ────────────────────────────────────────────────
document.getElementById('menu-save-image').addEventListener('click', () => {
  menuArquivo.classList.remove('show');
  state.isExporting = true;
  compositeAll();
  mainCanvas.toBlob(async (blob) => {
    state.isExporting = false;
    compositeAll();
    if (!blob) return;
    const defaultName = 'canvas_frame.png';
    const saved = await saveFileWithPicker(blob, defaultName, 'image/png');
    if (!saved) {
      // Fallback
      const link = document.createElement('a');
      link.download = defaultName;
      link.href = URL.createObjectURL(blob);
      link.click();
    }
  }, 'image/png');
});



// ─── Canvas Resize Operation ─────────────────────────────────────
function resizeCanvas(newW, newH, offsetX = 0, offsetY = 0, isAutoAdjust = false) {
  canvasW = newW;
  canvasH = newH;
  mainCanvas.width = newW;
  mainCanvas.height = newH;
  previewCanvas.width = newW;
  previewCanvas.height = newH;

  // Resize all frames in drawing layers only (video layers have no frame canvases)
  layers.forEach(l => {
    if (l.isVideo) return;
    l.frames.forEach(f => {
      if (!f.canvas) return;
      const temp = document.createElement('canvas');
      temp.width = f.canvas.width;
      temp.height = f.canvas.height;
      const tempCtx = temp.getContext('2d');
      tempCtx.drawImage(f.canvas, 0, 0);
      
      f.canvas.width = newW;
      f.canvas.height = newH;
      f.ctx = f.canvas.getContext('2d');
      f.ctx.clearRect(0, 0, newW, newH);

      const oldW = temp.width;
      const oldH = temp.height;

      // Recreate/adjust backing canvas
      if (f.backingCanvas) {
        // Copy the new viewport region from the old backing canvas
        let sx, sy;
        if (isAutoAdjust) {
          sx = oldW - offsetX; // since offsetX is -minX, this is oldW + minX
          sy = oldH - offsetY; // since offsetY is -minY, this is oldH + minY
        } else {
          sx = oldW - (f.offsetX || 0) - offsetX;
          sy = oldH - (f.offsetY || 0) - offsetY;
        }
        f.ctx.drawImage(f.backingCanvas, sx, sy, newW, newH, 0, 0, newW, newH);

        const oldBacking = f.backingCanvas;
        f.backingCanvas = document.createElement('canvas');
        f.backingCanvas.width = newW * 3;
        f.backingCanvas.height = newH * 3;
        const bctx = f.backingCanvas.getContext('2d');
        bctx.clearRect(0, 0, newW * 3, newH * 3);
        
        // Draw old backing canvas onto the new one aligned globally
        const bx = newW - oldW;
        const by = newH - oldH;
        bctx.drawImage(oldBacking, bx, by);

        if (isAutoAdjust) {
          f.backingCanvas = null;
          f.offsetX = 0;
          f.offsetY = 0;
        } else {
          f.offsetX = (f.offsetX || 0) + offsetX;
          f.offsetY = (f.offsetY || 0) + offsetY;
        }
      } else {
        // Compute frame shift
        let frameShiftX = offsetX;
        let frameShiftY = offsetY;
        if (isAutoAdjust) {
          frameShiftX = -(f.offsetX || 0) + offsetX;
          frameShiftY = -(f.offsetY || 0) + offsetY;
        }
        f.ctx.drawImage(temp, frameShiftX, frameShiftY);

        if (isAutoAdjust) {
          f.offsetX = 0;
          f.offsetY = 0;
        } else {
          f.offsetX = (f.offsetX || 0) + offsetX;
          f.offsetY = (f.offsetY || 0) + offsetY;
        }
      }
    });
  });

  compositeAll();
  centerCanvas();
  saveHistory();
  renderLayerPanel();
  renderTimeline();
  document.getElementById('canvas-size-display').textContent = `${newW} × ${newH} px`;
}

// ─── Canvas Size Modal ───────────────────────────────────────────
const menuCanvasSize = document.getElementById('menu-canvas-size');
const canvasSizeOverlay = document.getElementById('canvas-size-overlay');
const resizeWidthInput = document.getElementById('resize-width');
const resizeHeightInput = document.getElementById('resize-height');

menuCanvasSize.addEventListener('click', () => {
  document.getElementById('menu-editar-dropdown').classList.remove('show');
  resizeWidthInput.value = canvasW;
  resizeHeightInput.value = canvasH;
  canvasSizeOverlay.classList.remove('hidden');
});

document.getElementById('resize-cancel').addEventListener('click', () => {
  canvasSizeOverlay.classList.add('hidden');
});

canvasSizeOverlay.addEventListener('click', e => {
  if (e.target === canvasSizeOverlay) {
    canvasSizeOverlay.classList.add('hidden');
  }
});

document.getElementById('resize-apply').addEventListener('click', () => {
  const w = parseInt(resizeWidthInput.value) || canvasW;
  const h = parseInt(resizeHeightInput.value) || canvasH;
  resizeCanvas(w, h);
  canvasSizeOverlay.classList.add('hidden');
});

// ─── Flip Selection or Layer ──────────────────────────────────────
function flipSelectionOrLayer(horizontal) {
  const l = layers[activeLayerIdx];
  if (!l || l.isVideo) return;
  const lctx = getLCtx();
  if (!lctx) return;

  if (state.lassoActive) {
    if (!state.lassoSelectionCanvas) {
      extractLassoSelection();
    }
    const bbox = state.lassoBoundingBox;
    if (state.lassoSelectionCanvas && bbox) {
      // 1. Flip the selection canvas
      const flippedSelection = document.createElement('canvas');
      flippedSelection.width = bbox.w;
      flippedSelection.height = bbox.h;
      const fCtx = flippedSelection.getContext('2d');
      fCtx.imageSmoothingEnabled = false;
      if (horizontal) {
        fCtx.translate(bbox.w, 0);
        fCtx.scale(-1, 1);
      } else {
        fCtx.translate(0, bbox.h);
        fCtx.scale(1, -1);
      }
      fCtx.drawImage(state.lassoSelectionCanvas, 0, 0);
      state.lassoSelectionCanvas = flippedSelection;

      // 2. Flip the mask canvas
      if (state.lassoMaskCanvas) {
        const flippedMask = document.createElement('canvas');
        flippedMask.width = bbox.w;
        flippedMask.height = bbox.h;
        const fmCtx = flippedMask.getContext('2d');
        fmCtx.imageSmoothingEnabled = false;
        if (horizontal) {
          fmCtx.translate(bbox.w, 0);
          fmCtx.scale(-1, 1);
        } else {
          fmCtx.translate(0, bbox.h);
          fmCtx.scale(1, -1);
        }
        fmCtx.drawImage(state.lassoMaskCanvas, 0, 0);
        state.lassoMaskCanvas = flippedMask;
      }

      // 3. Flip paths
      if (state.lassoPaths && state.lassoPaths.length > 0) {
        state.lassoPaths = state.lassoPaths.map(path => {
          return path.map(p => {
            return {
              x: horizontal ? (2 * bbox.x + bbox.w - p.x) : p.x,
              y: horizontal ? p.y : (2 * bbox.y + bbox.h - p.y)
            };
          });
        });
      }
      if (state.lassoPath && state.lassoPath.length > 0) {
        state.lassoPath = state.lassoPath.map(p => {
          return {
            x: horizontal ? (2 * bbox.x + bbox.w - p.x) : p.x,
            y: horizontal ? p.y : (2 * bbox.y + bbox.h - p.y)
          };
        });
      }

      // 4. Update the selection mask array
      updateSelectionMask();

      // 5. Save history so undoing works
      saveHistory();

      // 6. Refresh visuals
      compositeAll();
      drawLassoSelectionOutline();
    }
  } else {
    // If nothing is selected, flip the active layer's current frame
    markActiveFrameAsKeyframe();
    
    // Backup the active frame's canvas content
    const temp = document.createElement('canvas');
    temp.width = canvasW;
    temp.height = canvasH;
    const tctx = temp.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(lctx.canvas, 0, 0);

    // Clear and draw flipped
    lctx.clearRect(0, 0, canvasW, canvasH);
    lctx.save();
    lctx.imageSmoothingEnabled = false;
    if (horizontal) {
      lctx.translate(canvasW, 0);
      lctx.scale(-1, 1);
    } else {
      lctx.translate(0, canvasH);
      lctx.scale(1, -1);
    }
    lctx.drawImage(temp, 0, 0);
    lctx.restore();

    // Flip the backing canvas content too
    const f = layers[activeLayerIdx]?.frames[state.currentFrame];
    if (f && f.backingCanvas) {
      const bTemp = document.createElement('canvas');
      bTemp.width = canvasW * 3;
      bTemp.height = canvasH * 3;
      const btctx = bTemp.getContext('2d');
      btctx.drawImage(f.backingCanvas, 0, 0);

      const bctx = f.backingCanvas.getContext('2d');
      bctx.clearRect(0, 0, canvasW * 3, canvasH * 3);
      bctx.save();
      if (horizontal) {
        bctx.translate(canvasW * 3, 0);
        bctx.scale(-1, 1);
        f.offsetX = -f.offsetX; // Invert horizontal offset
      } else {
        bctx.translate(0, canvasH * 3);
        bctx.scale(1, -1);
        f.offsetY = -f.offsetY; // Invert vertical offset
      }
      bctx.drawImage(bTemp, 0, 0);
      bctx.restore();
    }

    // Refresh visuals & Save history
    compositeAll();
    saveHistory();
  }
}

document.getElementById('menu-flip-horizontal').addEventListener('click', () => {
  document.getElementById('menu-select-dropdown').classList.remove('show');
  flipSelectionOrLayer(true);
});

document.getElementById('menu-flip-vertical').addEventListener('click', () => {
  document.getElementById('menu-select-dropdown').classList.remove('show');
  flipSelectionOrLayer(false);
});

// ─── Auto Adjust Canvas Size ──────────────────────────────────────
function autoAdjustCanvasSize() {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  let hasContent = false;

  layers.forEach(l => {
    if (l.isVideo) return;
    l.frames.forEach(f => {
      if (!f.canvas) return;
      
      if (f.backingCanvas) {
        syncBackingCanvas(f);
        const bw = canvasW * 3;
        const bh = canvasH * 3;
        const bctx = f.backingCanvas.getContext('2d');
        const imgData = bctx.getImageData(0, 0, bw, bh);
        const data = imgData.data;
        
        for (let by = 0; by < bh; by++) {
          for (let bx = 0; bx < bw; bx++) {
            const alpha = data[(by * bw + bx) * 4 + 3];
            if (alpha > 0) {
              const x = bx - canvasW;
              const y = by - canvasH;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              hasContent = true;
            }
          }
        }
      } else {
        const imgData = f.canvas.getContext('2d').getImageData(0, 0, canvasW, canvasH);
        const data = imgData.data;
        
        for (let y = 0; y < canvasH; y++) {
          for (let x = 0; x < canvasW; x++) {
            const alpha = data[(y * canvasW + x) * 4 + 3];
            if (alpha > 0) {
              const gx = x - (f.offsetX || 0);
              const gy = y - (f.offsetY || 0);
              if (gx < minX) minX = gx;
              if (gx > maxX) maxX = gx;
              if (gy < minY) minY = gy;
              if (gy > maxY) maxY = gy;
              hasContent = true;
            }
          }
        }
      }
    });
  });

  // Include floating selection if active
  if (state.lassoActive && state.lassoSelectionCanvas) {
    const sw = state.lassoSelectionCanvas.width;
    const sh = state.lassoSelectionCanvas.height;
    const sctx = state.lassoSelectionCanvas.getContext('2d');
    const imgData = sctx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    const activeFrame = layers[activeLayerIdx]?.frames[state.currentFrame];
    const fx = activeFrame ? (activeFrame.offsetX || 0) : 0;
    const fy = activeFrame ? (activeFrame.offsetY || 0) : 0;

    const cx = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + state.lassoBoundingBox.w / 2;
    const cy = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + state.lassoBoundingBox.h / 2;
    const cosVal = Math.cos(state.lassoRotation || 0);
    const sinVal = Math.sin(state.lassoRotation || 0);
    const scaleX = state.lassoScaleX || 1;
    const scaleY = state.lassoScaleY || 1;

    for (let sy = 0; sy < sh; sy++) {
      for (let sx = 0; sx < sw; sx++) {
        const alpha = data[(sy * sw + sx) * 4 + 3];
        if (alpha > 0) {
          const px = state.lassoBoundingBox.x + state.lassoCurrentOffset.x + sx;
          const py = state.lassoBoundingBox.y + state.lassoCurrentOffset.y + sy;

          const dx = px - cx;
          const dy = py - cy;
          const sdx = dx * scaleX;
          const sdy = dy * scaleY;
          const rx = sdx * cosVal - sdy * sinVal;
          const ry = sdx * sinVal + sdy * cosVal;
          const vx = rx + cx;
          const vy = ry + cy;

          const gx = vx - fx;
          const gy = vy - fy;

          if (gx < minX) minX = gx;
          if (gx > maxX) maxX = gx;
          if (gy < minY) minY = gy;
          if (gy > maxY) maxY = gy;
          hasContent = true;
        }
      }
    }
  } else if (state.lassoActive && state.lassoPaths && state.lassoPaths.length > 0) {
    const activeFrame = layers[activeLayerIdx]?.frames[state.currentFrame];
    const fx = activeFrame ? (activeFrame.offsetX || 0) : 0;
    const fy = activeFrame ? (activeFrame.offsetY || 0) : 0;

    state.lassoPaths.forEach(path => {
      path.forEach(pt => {
        const gx = pt.x - fx;
        const gy = pt.y - fy;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
        hasContent = true;
      });
    });
  }

  if (!hasContent) {
    showToast("⚠️ No content found to adjust canvas!");
    return;
  }

  const newW = maxX - minX + 1;
  const newH = maxY - minY + 1;

  if (newW < 4 || newH < 4) {
    showToast("⚠️ Content is too small to resize!");
    return;
  }

  const shiftX = -minX;
  const shiftY = -minY;

  const activeFrameForSelection = layers[activeLayerIdx]?.frames[state.currentFrame];
  const oldOffsetX = activeFrameForSelection ? (activeFrameForSelection.offsetX || 0) : 0;
  const oldOffsetY = activeFrameForSelection ? (activeFrameForSelection.offsetY || 0) : 0;

  resizeCanvas(newW, newH, shiftX, shiftY, true);

  if (state.lassoActive) {
    const selShiftX = shiftX - oldOffsetX;
    const selShiftY = shiftY - oldOffsetY;

    if (state.lassoBoundingBox) {
      state.lassoBoundingBox.x += selShiftX;
      state.lassoBoundingBox.y += selShiftY;
    }
    if (state.lassoPath) {
      state.lassoPath.forEach(pt => {
        pt.x += selShiftX;
        pt.y += selShiftY;
      });
    }
    if (state.lassoPaths) {
      state.lassoPaths.forEach(path => {
        path.forEach(pt => {
          pt.x += selShiftX;
          pt.y += selShiftY;
        });
      });
    }
    updateSelectionMask();
  }
  
  if (typeof centerCanvas === 'function') {
    centerCanvas();
  } else {
    state.panX = 0;
    state.panY = 0;
    applyTransform();
  }
  
  compositeAll();
  saveHistory();
  showToast("🖼️ Canvas adjusted!");
}

document.getElementById('menu-auto-adjust').addEventListener('click', () => {
  document.getElementById('menu-editar-dropdown').classList.remove('show');
  autoAdjustCanvasSize();
});

// ─── Color Adjustments Modal ──────────────────────────────────────
const colorAdjustModal = document.getElementById('color-adjust-modal');
const menuColorAdjust = document.getElementById('menu-color-adjust');

if (menuColorAdjust && colorAdjustModal) {
  let layersBackup = null;
  let lassoBackup = null;

  // Draggable window implementation
  const header = document.getElementById('color-adjust-header');
  if (header) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    header.onmousedown = (e) => {
      e = e || window.event;
      if (e.target.closest('button')) return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
      document.onmousemove = (ev) => {
        ev = ev || window.event;
        ev.preventDefault();
        pos1 = pos3 - ev.clientX;
        pos2 = pos4 - ev.clientY;
        pos3 = ev.clientX;
        pos4 = ev.clientY;
        
        let newTop = colorAdjustModal.offsetTop - pos2;
        let newLeft = colorAdjustModal.offsetLeft - pos1;
        
        if (newTop < 0) newTop = 0;
        if (newLeft < 0) newLeft = 0;
        if (newTop + colorAdjustModal.offsetHeight > window.innerHeight) newTop = window.innerHeight - colorAdjustModal.offsetHeight;
        if (newLeft + colorAdjustModal.offsetWidth > window.innerWidth) newLeft = window.innerWidth - colorAdjustModal.offsetWidth;
        
        colorAdjustModal.style.top = newTop + "px";
        colorAdjustModal.style.left = newLeft + "px";
      };
    };
  }

  // State initialization for filter preview
  state.colorAdjustPreview = null;

  function updateSVGFilter(luminance, posterizeVal) {
    const intercept = luminance / 100;
    const lumTransfer = document.getElementById('luminance-transfer');
    if (lumTransfer) {
      const funcs = lumTransfer.querySelectorAll('feFuncR, feFuncG, feFuncB');
      funcs.forEach(f => f.setAttribute('intercept', intercept));
    }

    const postTransfer = document.getElementById('posterize-transfer');
    if (postTransfer) {
      const funcs = postTransfer.querySelectorAll('feFuncR, feFuncG, feFuncB');
      if (posterizeVal >= 256) {
        funcs.forEach(f => f.setAttribute('type', 'identity'));
      } else {
        const tableValues = [];
        for (let i = 0; i < posterizeVal; i++) {
          tableValues.push((i / (posterizeVal - 1)).toFixed(4));
        }
        funcs.forEach(f => {
          f.setAttribute('type', 'discrete');
          f.setAttribute('tableValues', tableValues.join(' '));
        });
      }
    }
  }

  function getFilterString(hue, sat, bright, contrast, depth, invert) {
    return `url(#color-adjust-filter) hue-rotate(${hue}deg) saturate(${sat}%) brightness(${bright}%) contrast(${contrast}%) blur(${depth}px) invert(${invert ? 100 : 0}%)`;
  }

  function applyPreview() {
    const hue = parseInt(document.getElementById('adjust-hue').value);
    const sat = parseInt(document.getElementById('adjust-saturation').value);
    const lum = parseInt(document.getElementById('adjust-luminance').value);
    const bright = parseInt(document.getElementById('adjust-brightness').value);
    const contrast = parseInt(document.getElementById('adjust-contrast').value);
    const depth = parseFloat(document.getElementById('adjust-depth').value);
    const posterize = parseInt(document.getElementById('adjust-posterize').value);
    const mosaic = parseInt(document.getElementById('adjust-mosaic').value);
    const invert = document.getElementById('adjust-invert').checked;
    const allLayers = document.getElementById('adjust-all-layers').checked;

    // Update SVG properties (for luminance & posterization)
    updateSVGFilter(lum, posterize);

    // Update preview state
    state.colorAdjustPreview = {
      hue,
      saturation: sat,
      luminance: lum,
      brightness: bright,
      contrast,
      depth,
      posterize,
      mosaic,
      invert,
      allLayers,
      filterString: getFilterString(hue, sat, bright, contrast, depth, invert)
    };

    compositeAll();
  }

  function resetAdjustSliders() {
    document.getElementById('adjust-hue').value = 0;
    document.getElementById('adjust-hue-val').textContent = '0°';
    
    document.getElementById('adjust-saturation').value = 100;
    document.getElementById('adjust-saturation-val').textContent = '100%';
    
    document.getElementById('adjust-luminance').value = 0;
    document.getElementById('adjust-luminance-val').textContent = '0%';
    
    document.getElementById('adjust-brightness').value = 100;
    document.getElementById('adjust-brightness-val').textContent = '100%';
    
    document.getElementById('adjust-contrast').value = 100;
    document.getElementById('adjust-contrast-val').textContent = '100%';
    
    document.getElementById('adjust-depth').value = 0;
    document.getElementById('adjust-depth-val').textContent = '0px';
    
    document.getElementById('adjust-posterize').value = 256;
    document.getElementById('adjust-posterize-val').textContent = '256';

    document.getElementById('adjust-mosaic').value = 1;
    document.getElementById('adjust-mosaic-val').textContent = '1px';
    
    document.getElementById('adjust-invert').checked = false;
    document.getElementById('adjust-all-layers').checked = false;

    updateSVGFilter(0, 256);
  }

  // Slide controls event listeners
  const controls = [
    { id: 'adjust-hue', valId: 'adjust-hue-val', suffix: '°' },
    { id: 'adjust-saturation', valId: 'adjust-saturation-val', suffix: '%' },
    { id: 'adjust-luminance', valId: 'adjust-luminance-val', suffix: '%' },
    { id: 'adjust-brightness', valId: 'adjust-brightness-val', suffix: '%' },
    { id: 'adjust-contrast', valId: 'adjust-contrast-val', suffix: '%' },
    { id: 'adjust-depth', valId: 'adjust-depth-val', suffix: 'px' },
    { id: 'adjust-posterize', valId: 'adjust-posterize-val', suffix: '' },
    { id: 'adjust-mosaic', valId: 'adjust-mosaic-val', suffix: 'px' }
  ];

  controls.forEach(c => {
    const el = document.getElementById(c.id);
    const valEl = document.getElementById(c.valId);
    if (el && valEl) {
      el.addEventListener('input', () => {
        valEl.textContent = el.value + c.suffix;
        applyPreview();
      });
    }
  });

  document.getElementById('adjust-invert').addEventListener('change', applyPreview);
  document.getElementById('adjust-all-layers').addEventListener('change', applyPreview);

  // Show Modal
  menuColorAdjust.addEventListener('click', () => {
    document.getElementById('menu-editar-dropdown').classList.remove('show');
    
    // Backup current state before opening so we can cleanly revert on cancel
    layersBackup = snapshotLayers();
    lassoBackup = {
      active: state.lassoActive,
      selectionCanvas: state.lassoSelectionCanvas,
      maskCanvas: state.lassoMaskCanvas,
      boundingBox: state.lassoBoundingBox ? { ...state.lassoBoundingBox } : null,
      currentOffset: state.lassoCurrentOffset ? { ...state.lassoCurrentOffset } : null,
      prevOffset: state.lassoPrevOffset ? { ...state.lassoPrevOffset } : null,
      startOffset: state.lassoStartOffset ? { ...state.lassoStartOffset } : null,
      scaleX: state.lassoScaleX,
      scaleY: state.lassoScaleY,
      rotation: state.lassoRotation,
      transformMode: state.lassoTransformMode,
      paths: state.lassoPaths ? JSON.parse(JSON.stringify(state.lassoPaths)) : null,
      path: state.lassoPath ? JSON.parse(JSON.stringify(state.lassoPath)) : null
    };

    // If selection is active but not floating, extract it now to allow selective previewing
    if (state.lassoActive && !state.lassoSelectionCanvas) {
      extractLassoSelection();
    }

    resetAdjustSliders();
    
    // Disable "All Layers" check if there is an active selection
    const allLayersCheckbox = document.getElementById('adjust-all-layers');
    if (state.lassoActive) {
      allLayersCheckbox.checked = false;
      allLayersCheckbox.disabled = true;
    } else {
      allLayersCheckbox.disabled = false;
    }

    // Position the window near center-right
    colorAdjustModal.style.top = '120px';
    colorAdjustModal.style.left = (window.innerWidth - 420) + 'px';
    
    colorAdjustModal.classList.remove('hidden');
    applyPreview();
  });

  // Cancel action
  function cancelAdjustments() {
    colorAdjustModal.classList.add('hidden');
    state.colorAdjustPreview = null;
    
    // Restore backup snapshot
    if (layersBackup) {
      restoreSnapshot(layersBackup);
    }
    if (lassoBackup) {
      state.lassoActive = lassoBackup.active;
      state.lassoSelectionCanvas = lassoBackup.selectionCanvas;
      state.lassoMaskCanvas = lassoBackup.maskCanvas;
      state.lassoBoundingBox = lassoBackup.boundingBox;
      state.lassoCurrentOffset = lassoBackup.currentOffset;
      state.lassoPrevOffset = lassoBackup.prevOffset;
      state.lassoStartOffset = lassoBackup.startOffset;
      state.lassoScaleX = lassoBackup.scaleX;
      state.lassoScaleY = lassoBackup.scaleY;
      state.lassoRotation = lassoBackup.rotation;
      state.lassoTransformMode = lassoBackup.transformMode;
      state.lassoPaths = lassoBackup.paths;
      state.lassoPath = lassoBackup.path;
    }
    
    updateSVGFilter(0, 256); // reset filter
    compositeAll();
  }

  document.getElementById('adjust-cancel').addEventListener('click', cancelAdjustments);
  document.getElementById('color-adjust-close').addEventListener('click', cancelAdjustments);

  // Apply action
  document.getElementById('adjust-apply').addEventListener('click', () => {
    if (!state.colorAdjustPreview) return;

    // Apply the active SVG values to document
    const lum = state.colorAdjustPreview.luminance;
    const post = state.colorAdjustPreview.posterize;
    updateSVGFilter(lum, post);

    const filterString = state.colorAdjustPreview.filterString;

    // Save history checkpoint before mutating pixels so it supports Undo/Redo
    saveHistory();

    // If selection is active, bake the adjustment directly into the floating selection canvas
    if (state.lassoActive && state.lassoSelectionCanvas) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = state.lassoSelectionCanvas.width;
      tempCanvas.height = state.lassoSelectionCanvas.height;
      const tempCtx = tempCanvas.getContext('2d');
      
      tempCtx.filter = filterString;
      tempCtx.drawImage(state.lassoSelectionCanvas, 0, 0);
      
      const mosaic = state.colorAdjustPreview.mosaic || 1;
      if (mosaic > 1) {
        const tinyCanvas = document.createElement('canvas');
        tinyCanvas.width = Math.max(1, Math.floor(tempCanvas.width / mosaic));
        tinyCanvas.height = Math.max(1, Math.floor(tempCanvas.height / mosaic));
        const tinyCtx = tinyCanvas.getContext('2d');
        tinyCtx.imageSmoothingEnabled = false;
        tinyCtx.drawImage(tempCanvas, 0, 0, tinyCanvas.width, tinyCanvas.height);
        
        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.imageSmoothingEnabled = false;
        tempCtx.drawImage(tinyCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
      }

      if (state.lassoMaskCanvas) {
        tempCtx.filter = 'none';
        tempCtx.globalCompositeOperation = 'destination-in';
        tempCtx.drawImage(state.lassoMaskCanvas, 0, 0);
      }
      
      const selCtx = state.lassoSelectionCanvas.getContext('2d');
      selCtx.clearRect(0, 0, state.lassoSelectionCanvas.width, state.lassoSelectionCanvas.height);
      selCtx.drawImage(tempCanvas, 0, 0);
    } else {
      // No selection: bake adjustment directly into target layer frame canvases
      const isAllLayers = state.colorAdjustPreview.allLayers;
      const activeLayer = layers[activeLayerIdx];
      const targets = isAllLayers ? layers : (activeLayer ? [activeLayer] : []);
      const mosaic = state.colorAdjustPreview.mosaic || 1;

      targets.forEach(l => {
        if (l.isVideo) return; // skip video layers
        l.frames.forEach(f => {
          if (f.isKeyframe && f.canvas) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = canvasW;
            tempCanvas.height = canvasH;
            const tempCtx = tempCanvas.getContext('2d');
            
            tempCtx.filter = filterString;
            tempCtx.drawImage(f.canvas, 0, 0);

            if (mosaic > 1) {
              const tinyCanvas = document.createElement('canvas');
              tinyCanvas.width = Math.max(1, Math.floor(canvasW / mosaic));
              tinyCanvas.height = Math.max(1, Math.floor(canvasH / mosaic));
              const tinyCtx = tinyCanvas.getContext('2d');
              tinyCtx.imageSmoothingEnabled = false;
              tinyCtx.drawImage(tempCanvas, 0, 0, tinyCanvas.width, tinyCanvas.height);
              
              tempCtx.clearRect(0, 0, canvasW, canvasH);
              tempCtx.imageSmoothingEnabled = false;
              tempCtx.drawImage(tinyCanvas, 0, 0, canvasW, canvasH);
            }
            
            f.ctx.clearRect(0, 0, canvasW, canvasH);
            f.ctx.drawImage(tempCanvas, 0, 0);

            if (f.backingCanvas) {
              const bTemp = document.createElement('canvas');
              bTemp.width = canvasW * 3;
              bTemp.height = canvasH * 3;
              const btctx = bTemp.getContext('2d');
              btctx.filter = filterString;
              btctx.drawImage(f.backingCanvas, 0, 0);
              
              const bctx = f.backingCanvas.getContext('2d');
              bctx.clearRect(0, 0, canvasW * 3, canvasH * 3);
              if (mosaic > 1) {
                const tinyCanvas = document.createElement('canvas');
                tinyCanvas.width = Math.max(1, Math.floor(canvasW * 3 / mosaic));
                tinyCanvas.height = Math.max(1, Math.floor(canvasH * 3 / mosaic));
                const tinyCtx = tinyCanvas.getContext('2d');
                tinyCtx.imageSmoothingEnabled = false;
                tinyCtx.drawImage(bTemp, 0, 0, tinyCanvas.width, tinyCanvas.height);
                
                bctx.imageSmoothingEnabled = false;
                bctx.drawImage(tinyCanvas, 0, 0, canvasW * 3, canvasH * 3);
              } else {
                bctx.drawImage(bTemp, 0, 0);
              }
            }
          }
        });
      });
    }

    colorAdjustModal.classList.add('hidden');
    state.colorAdjustPreview = null;
    updateSVGFilter(0, 256); // reset active filter
    compositeAll();
  });
}

// ─── Cursor: Update custom circle ────────────────────────────────
// Dynamic crosshair cursor
let cursorEl = null;

function ensureCursor() {
  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.id = 'dynamic-cursor';
    Object.assign(cursorEl.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '9999',
      borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.8)',
      transform: 'translate(-50%,-50%)',
      transition: 'width 0.08s, height 0.08s',
      mixBlendMode: 'difference',
      background: 'rgba(255,255,255,0.08)',
    });
    document.body.appendChild(cursorEl);
  }
}

container.addEventListener('pointermove', e => {
  ensureCursor();
  cursorEl.style.display = 'block';
  cursorEl.style.left = e.clientX + 'px';
  cursorEl.style.top  = e.clientY + 'px';
  const size = Math.max(state.brushSize * state.zoom, 4);
  cursorEl.style.width  = size + 'px';
  cursorEl.style.height = size + 'px';

  if (state.tool === 'brush' && e.altKey) {
    cursorEl.style.border = '1.5px dashed #3498db';
    cursorEl.style.background = 'rgba(52, 152, 219, 0.1)';
  } else {
    cursorEl.style.border = '1.5px solid rgba(255,255,255,0.8)';
    cursorEl.style.background = 'rgba(255,255,255,0.08)';
  }

  if (['fill','eyedropper'].includes(state.tool)) {
    cursorEl.style.display = 'none';
  }
});

container.addEventListener('mouseleave', () => {
  if (cursorEl) cursorEl.style.display = 'none';
});

// ─── Right-click: instant eyedropper ────────────────────────────
container.addEventListener('contextmenu', e => {
  e.preventDefault();
  const { x, y } = clientToCanvas(e.clientX, e.clientY);
  pickColor(x, y);

  // Brief visual flash to confirm the pick
  const swatch = document.getElementById('color-fg-swatch');
  swatch.style.transition = 'none';
  swatch.style.boxShadow = '0 0 0 3px #fff';
  setTimeout(() => {
    swatch.style.boxShadow = '';
    swatch.style.transition = '';
  }, 200);
});

// ─── Init ────────────────────────────────────────────────────────
initCanvas(canvasW, canvasH, '#ffffff');
setFgColor('#000000');
setBgColor('#ffffff');
setTool('pencil');
setBrushSize(1);

// ─── Timeline Resizer (Height Splitter) ──────────────────────────
const timelineElement = document.getElementById('timeline');
const resizer = document.createElement('div');
resizer.id = 'timeline-resizer';
timelineElement.appendChild(resizer);

let isResizingTimeline = false;
resizer.addEventListener('pointerdown', e => {
  isResizingTimeline = true;
  document.body.style.cursor = 'ns-resize';
  resizer.setPointerCapture(e.pointerId);
});

resizer.addEventListener('pointermove', e => {
  if (!isResizingTimeline) return;
  const appHeight = window.innerHeight;
  const newHeight = appHeight - e.clientY;
  const constrainedHeight = Math.max(80, Math.min(newHeight, 500));
  timelineElement.style.height = constrainedHeight + 'px';
});

resizer.addEventListener('pointerup', e => {
  isResizingTimeline = false;
  document.body.style.cursor = '';
  resizer.releasePointerCapture(e.pointerId);
});

// Center canvas after fonts/layout settle
requestAnimationFrame(() => {
  requestAnimationFrame(() => centerCanvas());
});

// ─── Global Timeline Scrubbing & Scrolling Listeners ─────────────
const _gridOuter = document.getElementById('timeline-grid-outer');
const _gridRuler = document.getElementById('timeline-grid-ruler');
const _gridRows = document.getElementById('timeline-grid-rows');
const _layersList = document.getElementById('timeline-layers-list');
let _timelineScrubbing = false;

if (_gridOuter && _layersList) {
  _gridOuter.addEventListener('scroll', () => {
    _layersList.scrollTop = _gridOuter.scrollTop;
  });
}

function _calcFrameFromMouse(e) {
  if (!_gridRows) return 0;
  const rect = _gridRows.getBoundingClientRect();
  // rect.left already accounts for scrolling. Do not add scrollLeft.
  const x = e.clientX - rect.left; 
  return Math.max(0, Math.min(state.totalFrames - 1, Math.floor(x / 20)));
}

if (_gridRows) {
  _gridRows.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    _timelineScrubbing = true;
    const f = _calcFrameFromMouse(e);
    
    const track = e.target.closest('.timeline-track');
    if (track && track.dataset.layerIdx !== undefined) {
      const idx = parseInt(track.dataset.layerIdx);
      const l = layers[idx];
      if (l.isVideo) {
        const duration = l.videoOffline ? (l.videoDuration || 0) : (l.video ? l.video.duration : 0);
        const videoFramesCount = Math.ceil(duration * state.fps);
        if (f >= videoFramesCount) return;
      }
      changeActiveLayerPreservingSelection(idx, f);
    } else {
      setCurrentFrame(f);
    }
  });
}

if (_gridRuler) {
  _gridRuler.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    _timelineScrubbing = true;
    setCurrentFrame(_calcFrameFromMouse(e));
  });
}

document.addEventListener('mousemove', (e) => {
  if (!_timelineScrubbing) return;
  const f = _calcFrameFromMouse(e);
  if (f !== state.currentFrame) {
    setCurrentFrame(f);
  }
});

document.addEventListener('mouseup', () => { _timelineScrubbing = false; });

const btnLassoTransform = document.getElementById('btn-lasso-transform');
if (btnLassoTransform) {
  btnLassoTransform.addEventListener('click', () => {
    if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) {
      state.lassoTransformMode = !state.lassoTransformMode;
      if (state.lassoTransformMode) {
        btnLassoTransform.classList.add('active');
      } else {
        btnLassoTransform.classList.remove('active');
      }
      drawLassoSelectionOutline();
    }
  });
}

console.log('%c🎨 Illustra loaded', 'color:#a78bfa;font-weight:bold;font-size:14px;');

// ─── Timeline Context Menu (Copy/Paste Frames) ───────────────────
let ctxMenuLayerIdx = -1;
let ctxMenuFrameIdx = -1;
window.frameClipboard = null;

function showTimelineContextMenu(e, layerIdx, frameIdx) {
  ctxMenuLayerIdx = layerIdx;
  ctxMenuFrameIdx = frameIdx;
  
  const menu = document.getElementById('timeline-context-menu');
  
  // Adjust position so it doesn't clip off-screen
  let left = e.clientX;
  let top = e.clientY;
  if (left + 150 > window.innerWidth) left = window.innerWidth - 150;
  if (top + 100 > window.innerHeight) top = window.innerHeight - 100;
  
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.remove('hidden');

  // Disable paste if clipboard is empty
  const pasteBtn = document.getElementById('ctx-paste-frame');
  if (!window.frameClipboard) {
    pasteBtn.style.opacity = '0.5';
    pasteBtn.style.pointerEvents = 'none';
  } else {
    pasteBtn.style.opacity = '1';
    pasteBtn.style.pointerEvents = 'auto';
  }
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('timeline-context-menu');
  if (menu && !menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
  }
  const layerMenu = document.getElementById('layer-context-menu');
  if (layerMenu && !layerMenu.classList.contains('hidden')) {
    layerMenu.classList.add('hidden');
  }
});

document.getElementById('ctx-copy-frame').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('timeline-context-menu').classList.add('hidden');
  
  if (ctxMenuLayerIdx < 0 || ctxMenuFrameIdx < 0) return;
  const l = layers[ctxMenuLayerIdx];
  if (!l || l.isVideo) return;
  
  const frame = l.frames[ctxMenuFrameIdx];
  if (frame && frame.isKeyframe && frame.canvas) {
    syncBackingCanvas(frame);
    const backingCopy = document.createElement('canvas');
    backingCopy.width = canvasW * 3;
    backingCopy.height = canvasH * 3;
    backingCopy.getContext('2d').drawImage(frame.backingCanvas, 0, 0);

    const ctx = frame.canvas.getContext('2d');
    window.frameClipboard = {
      data: ctx.getImageData(0, 0, canvasW, canvasH),
      offsetX: frame.offsetX || 0,
      offsetY: frame.offsetY || 0,
      backingCanvas: backingCopy
    };
  } else {
    window.frameClipboard = null;
  }
});

document.getElementById('ctx-paste-frame').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('timeline-context-menu').classList.add('hidden');

  if (ctxMenuLayerIdx < 0 || ctxMenuFrameIdx < 0 || !window.frameClipboard) return;
  const l = layers[ctxMenuLayerIdx];
  if (!l || l.isVideo) return;

  const frame = l.frames[ctxMenuFrameIdx];
  if (!frame.isKeyframe || !frame.canvas) {
    frame.isKeyframe = true;
    frame.canvas = document.createElement('canvas');
    frame.canvas.width = canvasW;
    frame.canvas.height = canvasH;
  }
  
  frame.ctx = frame.canvas.getContext('2d');
  // Clear any existing content and paste
  frame.ctx.clearRect(0, 0, canvasW, canvasH);
  if (window.frameClipboard.data) {
    frame.ctx.putImageData(window.frameClipboard.data, 0, 0);
    frame.offsetX = window.frameClipboard.offsetX || 0;
    frame.offsetY = window.frameClipboard.offsetY || 0;
    if (window.frameClipboard.backingCanvas) {
      frame.backingCanvas = document.createElement('canvas');
      frame.backingCanvas.width = canvasW * 3;
      frame.backingCanvas.height = canvasH * 3;
      frame.backingCanvas.getContext('2d').drawImage(window.frameClipboard.backingCanvas, 0, 0);
    } else {
      frame.backingCanvas = null;
    }
  } else {
    frame.ctx.putImageData(window.frameClipboard, 0, 0);
    frame.offsetX = 0;
    frame.offsetY = 0;
    frame.backingCanvas = null;
  }
  
  compositeAll();
  renderTimeline();
  saveHistory();
});

document.getElementById('ctx-clear-frame').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('timeline-context-menu').classList.add('hidden');

  if (ctxMenuLayerIdx < 0 || ctxMenuFrameIdx < 0) return;
  const l = layers[ctxMenuLayerIdx];
  if (!l || l.isVideo) return;

  const frame = l.frames[ctxMenuFrameIdx];
  if (frame && frame.isKeyframe) {
    frame.isKeyframe = false;
    frame.canvas = null;
    
    compositeAll();
    renderTimeline();
    saveHistory();
  }
});

// Selection dashed line marching animation (every 400ms)
setInterval(() => {
  if (state.lassoActive) {
    state.lassoAnimState = !state.lassoAnimState;
    drawLassoSelectionOutline();
  }
}, 400);

// ─── Layer Context Menu (Blend Modes) ─────────────────────────────
let ctxMenuLayerTargetIdx = -1;

function showLayerContextMenu(e, layerIdx) {
  ctxMenuLayerTargetIdx = layerIdx;
  
  const menu = document.getElementById('layer-context-menu');
  const activeMode = layers[layerIdx].blendMode || 'source-over';
  
  // Mark current active blend mode
  menu.querySelectorAll('.menu-item').forEach(item => {
    if (item.dataset.mode === activeMode) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Adjust position so it doesn't clip off-screen
  let left = e.clientX;
  let top = e.clientY;
  if (left + 160 > window.innerWidth) left = window.innerWidth - 160;
  if (top + 70 > window.innerHeight) top = window.innerHeight - 70;
  if (top < 0) top = 10;
  
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  
  // Boundary detection for submenu positioning (opens left/up)
  if (left + 320 > window.innerWidth) {
    menu.classList.add('opens-left');
  } else {
    menu.classList.remove('opens-left');
  }
  
  if (top + 360 > window.innerHeight) {
    menu.classList.add('opens-up');
  } else {
    menu.classList.remove('opens-up');
  }
  
  menu.classList.remove('hidden');
}

document.querySelectorAll('#layer-context-menu .submenu-panel .menu-item').forEach(item => {
  item.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('layer-context-menu').classList.add('hidden');
    if (ctxMenuLayerTargetIdx < 0) return;
    const l = layers[ctxMenuLayerTargetIdx];
    if (l) {
      const oldMode = l.blendMode || 'source-over';
      const newMode = item.dataset.mode;
      if (oldMode !== newMode) {
        l.blendMode = newMode;
        renderLayerPanel();
        compositeAll();
        saveHistory();
      }
    }
  });
});

const renameBtn = document.getElementById('ctx-rename-layer');
if (renameBtn) {
  renameBtn.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('layer-context-menu').classList.add('hidden');
    if (ctxMenuLayerTargetIdx < 0) return;
    const l = layers[ctxMenuLayerTargetIdx];
    if (l) {
      // Try timeline item first, fall back to sidebar item
      const tlItem = document.querySelector(`#timeline-layers-list .timeline-layer-row[data-idx="${ctxMenuLayerTargetIdx}"]`);
      const sbItem = document.querySelector(`#layers-list .layer-item[data-idx="${ctxMenuLayerTargetIdx}"]`);
      
      if (tlItem) {
        const nameEl = tlItem.querySelector('.timeline-layer-name');
        if (nameEl) {
          startRename(l, nameEl, tlItem);
          return;
        }
      }
      
      if (sbItem) {
        const nameEl = sbItem.querySelector('.layer-name');
        if (nameEl) {
          startRename(l, nameEl, sbItem);
        }
      }
    }
  });
}

function getBlendModeLabel(mode) {
  const labels = {
    'source-over': 'Normal',
    'multiply': 'Multiply',
    'screen': 'Screen',
    'overlay': 'Overlay',
    'darken': 'Darken',
    'lighten': 'Lighten',
    'color-dodge': 'Color Dodge',
    'color-burn': 'Color Burn',
    'hard-light': 'Hard Light',
    'soft-light': 'Soft Light',
    'difference': 'Difference',
    'exclusion': 'Exclusion',
    'hue': 'Hue',
    'saturation': 'Saturation',
    'color': 'Color',
    'luminosity': 'Luminosity',
    'lighter': 'Add',
    'destination-in': 'Mask',
    'invert': 'Invert'
  };
  return labels[mode] || 'Normal';
}

// Prevent browser autoscroll on middle click globally to allow canvas panning
window.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
  }
}, { passive: false });


// ─── Color Ramp Filter ────────────────────────────────────────────
state.colorRampPreview = null;

(function() {
  const colorRampModal = document.getElementById('color-ramp-modal');
  const menuColorRamp = document.getElementById('menu-color-ramp');
  
  if (!colorRampModal || !menuColorRamp) return;

  let layersBackup = null;
  let lassoBackup = null;

  // Initial Stops (Default Black & White)
  let colorRampStops = [
    { position: 0.0, color: '#000000' },
    { position: 1.0, color: '#ffffff' }
  ];
  let selectedRampStop = colorRampStops[0];

  const gradientBar = document.getElementById('color-ramp-gradient-bar');
  const stopsContainer = document.getElementById('color-ramp-stops-container');
  const positionInput = document.getElementById('color-ramp-stop-position');
  const colorInput = document.getElementById('color-ramp-stop-color');
  const addStopBtn = document.getElementById('color-ramp-add-stop');
  const removeStopBtn = document.getElementById('color-ramp-remove-stop');
  const interpolationSelect = document.getElementById('color-ramp-interpolation');
  const allLayersCheckbox = document.getElementById('color-ramp-all-layers');
  const cancelBtn = document.getElementById('color-ramp-cancel');
  const applyBtn = document.getElementById('color-ramp-apply');
  const closeBtn = document.getElementById('color-ramp-close');
  const rampHeader = document.getElementById('color-ramp-header');

  // Draggable Window
  if (rampHeader) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    rampHeader.onmousedown = (e) => {
      e = e || window.event;
      if (e.target.closest('button')) return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
      document.onmousemove = (ev) => {
        ev = ev || window.event;
        ev.preventDefault();
        pos1 = pos3 - ev.clientX;
        pos2 = pos4 - ev.clientY;
        pos3 = ev.clientX;
        pos4 = ev.clientY;
        
        let newTop = colorRampModal.offsetTop - pos2;
        let newLeft = colorRampModal.offsetLeft - pos1;
        
        if (newTop < 0) newTop = 0;
        if (newLeft < 0) newLeft = 0;
        if (newTop + colorRampModal.offsetHeight > window.innerHeight) newTop = window.innerHeight - colorRampModal.offsetHeight;
        if (newLeft + colorRampModal.offsetWidth > window.innerWidth) newLeft = window.innerWidth - colorRampModal.offsetWidth;
        
        colorRampModal.style.top = newTop + "px";
        colorRampModal.style.left = newLeft + "px";
      };
    };
  }

  // Helper Functions
  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }

  function rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function getInterpolatedColor(v, stops, interpolationMode) {
    if (stops.length === 0) return { r: 0, g: 0, b: 0 };
    if (v <= stops[0].position) return hexToRgb(stops[0].color);
    if (v >= stops[stops.length - 1].position) return hexToRgb(stops[stops.length - 1].color);
    
    let i = 0;
    for (; i < stops.length - 1; i++) {
      if (v >= stops[i].position && v <= stops[i+1].position) {
        break;
      }
    }
    const s1 = stops[i];
    const s2 = stops[i+1];
    
    const c1 = hexToRgb(s1.color);
    const c2 = hexToRgb(s2.color);
    
    if (interpolationMode === 'constant') {
      return c1;
    }
    
    const t = (v - s1.position) / (s2.position - s1.position);
    return {
      r: Math.round(c1.r + (c2.r - c1.r) * t),
      g: Math.round(c1.g + (c2.g - c1.g) * t),
      b: Math.round(c1.b + (c2.b - c1.b) * t)
    };
  }

  function generateLUT() {
    const lut = new Uint8Array(256 * 3);
    const sorted = [...colorRampStops].sort((a, b) => a.position - b.position);
    const interpolation = interpolationSelect.value;
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      const c = getInterpolatedColor(v, sorted, interpolation);
      lut[i * 3] = c.r;
      lut[i * 3 + 1] = c.g;
      lut[i * 3 + 2] = c.b;
    }
    return lut;
  }

  window.applyLUTToCanvas = function(canvas, lut) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i+1];
      const b = data[i+2];
      const a = data[i+3];
      
      if (a > 0) {
        // ITU-R BT.601 Luminance formula
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        data[i]   = lut[gray * 3];
        data[i+1] = lut[gray * 3 + 1];
        data[i+2] = lut[gray * 3 + 2];
      }
    }
    ctx.putImageData(imgData, 0, 0);
  };

  // Rendering and Selection
  function selectStop(stop) {
    selectedRampStop = stop;
    positionInput.value = Math.round(stop.position * 100);
    colorInput.value = stop.color;
    colorRampStops.forEach(s => {
      if (s.el) {
        if (s === selectedRampStop) {
          s.el.classList.add('selected');
        } else {
          s.el.classList.remove('selected');
        }
      }
    });
  }

  function renderStops() {
    // 1. Update Gradient Bar Visuals
    const sorted = [...colorRampStops].sort((a, b) => a.position - b.position);
    gradientBar.style.background = 'linear-gradient(to right, ' + 
      sorted.map(s => `${s.color} ${s.position * 100}%`).join(', ') + ')';

    // 2. Clear & Draw Stop Pins
    stopsContainer.innerHTML = '';
    colorRampStops.forEach(stop => {
      const pin = document.createElement('div');
      pin.className = 'color-ramp-stop-pin';
      if (stop === selectedRampStop) {
        pin.classList.add('selected');
      }
      pin.style.left = (stop.position * 100) + '%';
      pin.style.backgroundColor = stop.color;
      stop.el = pin;

      // Handle Pin Drag
      pin.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectStop(stop);
        
        const onMouseMove = (ev) => {
          const rect = gradientBar.getBoundingClientRect();
          let pos = (ev.clientX - rect.left) / rect.width;
          pos = Math.max(0, Math.min(1, pos));
          stop.position = pos;
          
          positionInput.value = Math.round(pos * 100);
          pin.style.left = (pos * 100) + '%';

          // Update gradient bar background in real-time
          const sorted = [...colorRampStops].sort((a, b) => a.position - b.position);
          gradientBar.style.background = 'linear-gradient(to right, ' + 
            sorted.map(s => `${s.color} ${s.position * 100}%`).join(', ') + ')';

          applyPreview();
        };

        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          colorRampStops.sort((a, b) => a.position - b.position);
          renderStops();
          applyPreview();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      stopsContainer.appendChild(pin);
    });
  }

  // Click on gradient bar to add a stop
  gradientBar.addEventListener('mousedown', (e) => {
    if (e.target !== gradientBar) return;
    const rect = gradientBar.getBoundingClientRect();
    let pos = (e.clientX - rect.left) / rect.width;
    pos = Math.max(0, Math.min(1, pos));

    // Get color at clicked position
    const rgb = getInterpolatedColor(pos, [...colorRampStops].sort((a, b) => a.position - b.position), interpolationSelect.value);
    const newStop = { position: pos, color: rgbToHex(rgb.r, rgb.g, rgb.b) };
    
    colorRampStops.push(newStop);
    colorRampStops.sort((a, b) => a.position - b.position);
    renderStops();
    selectStop(newStop);
    applyPreview();
  });

  // Add Stop Button
  addStopBtn.addEventListener('click', () => {
    // Add stop in the middle
    let pos = 0.5;
    const rgb = getInterpolatedColor(pos, [...colorRampStops].sort((a, b) => a.position - b.position), interpolationSelect.value);
    const newStop = { position: pos, color: rgbToHex(rgb.r, rgb.g, rgb.b) };
    
    colorRampStops.push(newStop);
    colorRampStops.sort((a, b) => a.position - b.position);
    renderStops();
    selectStop(newStop);
    applyPreview();
  });

  // Remove Stop Button
  removeStopBtn.addEventListener('click', () => {
    if (colorRampStops.length <= 2) {
      showToast("⚠️ Color Ramp needs at least 2 stops!");
      return;
    }
    colorRampStops = colorRampStops.filter(s => s !== selectedRampStop);
    renderStops();
    selectStop(colorRampStops[0]);
    applyPreview();
  });

  // Position Input Change
  positionInput.addEventListener('input', () => {
    if (!selectedRampStop) return;
    let val = parseInt(positionInput.value) || 0;
    val = Math.max(0, Math.min(100, val));
    selectedRampStop.position = val / 100;
    applyPreview();
  });

  positionInput.addEventListener('change', () => {
    colorRampStops.sort((a, b) => a.position - b.position);
    renderStops();
    applyPreview();
  });

  // Color Input Change
  colorInput.addEventListener('input', () => {
    if (!selectedRampStop) return;
    selectedRampStop.color = colorInput.value;
    renderStops();
    applyPreview();
  });

  // Interpolation Dropdown Change
  interpolationSelect.addEventListener('change', () => {
    renderStops();
    applyPreview();
  });

  // All Layers Checkbox Change
  allLayersCheckbox.addEventListener('change', applyPreview);

  // Preview triggers
  function applyPreview() {
    state.colorRampPreview = {
      active: true,
      lut: generateLUT(),
      allLayers: allLayersCheckbox.checked
    };
    compositeAll();
  }

  // Open Dialog
  menuColorRamp.addEventListener('click', () => {
    document.getElementById('menu-editar-dropdown').classList.remove('show');
    
    // Snapshot state
    layersBackup = snapshotLayers();
    lassoBackup = {
      active: state.lassoActive,
      selectionCanvas: state.lassoSelectionCanvas,
      maskCanvas: state.lassoMaskCanvas,
      boundingBox: state.lassoBoundingBox ? { ...state.lassoBoundingBox } : null,
      currentOffset: state.lassoCurrentOffset ? { ...state.lassoCurrentOffset } : null,
      prevOffset: state.lassoPrevOffset ? { ...state.lassoPrevOffset } : null,
      startOffset: state.lassoStartOffset ? { ...state.lassoStartOffset } : null,
      scaleX: state.lassoScaleX,
      scaleY: state.lassoScaleY,
      rotation: state.lassoRotation,
      transformMode: state.lassoTransformMode,
      paths: state.lassoPaths ? JSON.parse(JSON.stringify(state.lassoPaths)) : null,
      path: state.lassoPath ? JSON.parse(JSON.stringify(state.lassoPath)) : null
    };

    if (state.lassoActive && !state.lassoSelectionCanvas) {
      extractLassoSelection();
    }

    // Disable All Layers checkbox if selection is active
    if (state.lassoActive) {
      allLayersCheckbox.checked = false;
      allLayersCheckbox.disabled = true;
    } else {
      allLayersCheckbox.disabled = false;
    }

    // Default Stops reset
    colorRampStops = [
      { position: 0.0, color: '#000000' },
      { position: 1.0, color: '#ffffff' }
    ];
    renderStops();
    selectStop(colorRampStops[0]);

    colorRampModal.style.top = '120px';
    colorRampModal.style.left = (window.innerWidth - 420) + 'px';
    colorRampModal.classList.remove('hidden');
    applyPreview();
  });

  // Cancel Action
  function cancel() {
    colorRampModal.classList.add('hidden');
    state.colorRampPreview = null;
    
    if (layersBackup) {
      restoreSnapshot(layersBackup);
    }
    if (lassoBackup) {
      state.lassoActive = lassoBackup.active;
      state.lassoSelectionCanvas = lassoBackup.selectionCanvas;
      state.lassoMaskCanvas = lassoBackup.maskCanvas;
      state.lassoBoundingBox = lassoBackup.boundingBox;
      state.lassoCurrentOffset = lassoBackup.currentOffset;
      state.lassoPrevOffset = lassoBackup.prevOffset;
      state.lassoStartOffset = lassoBackup.startOffset;
      state.lassoScaleX = lassoBackup.scaleX;
      state.lassoScaleY = lassoBackup.scaleY;
      state.lassoRotation = lassoBackup.rotation;
      state.lassoTransformMode = lassoBackup.transformMode;
      state.lassoPaths = lassoBackup.paths;
      state.lassoPath = lassoBackup.path;
    }
    compositeAll();
  }

  cancelBtn.addEventListener('click', cancel);
  closeBtn.addEventListener('click', cancel);

  // Apply Action
  applyBtn.addEventListener('click', () => {
    if (!state.colorRampPreview) return;

    const lut = state.colorRampPreview.lut;

    saveHistory();

    // Selection active: apply LUT directly to selection canvas
    if (state.lassoActive && state.lassoSelectionCanvas) {
      applyLUTToCanvas(state.lassoSelectionCanvas, lut);
    } else {
      // Apply LUT permanently to layer(s)
      const isAllLayers = state.colorRampPreview.allLayers;
      const activeLayer = layers[activeLayerIdx];
      const targets = isAllLayers ? layers : (activeLayer ? [activeLayer] : []);

      targets.forEach(l => {
        if (l.isVideo) return;
        l.frames.forEach(f => {
          if (f.isKeyframe && f.canvas) {
            applyLUTToCanvas(f.canvas, lut);
            if (f.backingCanvas) {
              applyLUTToCanvas(f.backingCanvas, lut);
            }
          }
        });
      });
    }

    colorRampModal.classList.add('hidden');
    state.colorRampPreview = null;
    compositeAll();
  });
})();
