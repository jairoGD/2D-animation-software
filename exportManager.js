// ═══════════════════════════════════════════════════════════════
// Illustra — Export Manager Module
// ═══════════════════════════════════════════════════════════════

(function() {
  const exportOverlay = document.getElementById('export-overlay');
  const optZip = document.getElementById('opt-export-zip');
  const optVideo = document.getElementById('opt-export-video');
  const optGif = document.getElementById('opt-export-gif');
  const optSpriteSheet = document.getElementById('opt-export-spritesheet');
  const spriteSheetOptions = document.getElementById('export-spritesheet-options');
  const spriteSheetColumnsInput = document.getElementById('export-spritesheet-columns');
  const spriteSheetRowsInput = document.getElementById('export-spritesheet-rows');
  const exportStart = document.getElementById('export-start');
  const exportCancel = document.getElementById('export-cancel');
  const exportFilenameInput = document.getElementById('export-filename');
  const exportProgressContainer = document.getElementById('export-progress-container');
  const exportProgressBar = document.getElementById('export-progress-bar');
  const exportProgressText = document.getElementById('export-progress-text');

  let exportType = 'zip';

  function setExportType(type) {
    exportType = type;
    optZip.classList.toggle('active', type === 'zip');
    optVideo.classList.toggle('active', type === 'video');
    if (optGif) optGif.classList.toggle('active', type === 'gif');
    if (optSpriteSheet) optSpriteSheet.classList.toggle('active', type === 'spritesheet');
    if (spriteSheetOptions) spriteSheetOptions.classList.toggle('hidden', type !== 'spritesheet');
  }

  document.getElementById('menu-export-animation').addEventListener('click', () => {
    const menuArquivo = document.getElementById('menu-arquivo-dropdown');
    if (menuArquivo) menuArquivo.classList.remove('show');
    exportOverlay.classList.remove('hidden');
    exportProgressContainer.classList.add('hidden');
    exportProgressBar.style.width = '0%';
    exportProgressText.textContent = '0%';
    exportStart.disabled = false;
    exportCancel.disabled = false;
    setExportType(exportType);
  });

  exportCancel.addEventListener('click', () => {
    exportOverlay.classList.add('hidden');
  });

  exportOverlay.addEventListener('click', (e) => {
    if (e.target === exportOverlay) {
      exportOverlay.classList.add('hidden');
    }
  });

  optZip.addEventListener('click', () => {
    setExportType('zip');
  });

  optVideo.addEventListener('click', () => {
    setExportType('video');
  });

  if (optGif) {
    optGif.addEventListener('click', () => {
      setExportType('gif');
    });
  }

  if (optSpriteSheet) {
    optSpriteSheet.addEventListener('click', () => {
      setExportType('spritesheet');
    });
  }

  exportStart.addEventListener('click', async () => {
    exportStart.disabled = true;
    exportCancel.disabled = true;
    exportProgressContainer.classList.remove('hidden');
    
    const originalFrame = state.currentFrame;
    const isPlayingWas = state.isPlaying;
    if (state.isPlaying) pause();
    
    const folderName = exportFilenameInput.value.trim() || 'animation';
    
    if (exportType === 'spritesheet') {
      const columns = Number(spriteSheetColumnsInput.value);
      const rows = Number(spriteSheetRowsInput.value);

      if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
        alert('SpriteSheet dimensions must be positive whole numbers.');
        exportStart.disabled = false;
        exportCancel.disabled = false;
        exportProgressContainer.classList.add('hidden');
        if (isPlayingWas) play();
        return;
      }

      if (columns * rows < state.totalFrames) {
        alert('The SpriteSheet grid must have enough cells for every frame.');
        exportStart.disabled = false;
        exportCancel.disabled = false;
        exportProgressContainer.classList.add('hidden');
        if (isPlayingWas) play();
        return;
      }

      try {
        state.isExporting = true;
        const spriteSheetCanvas = document.createElement('canvas');
        spriteSheetCanvas.width = canvasW * columns;
        spriteSheetCanvas.height = canvasH * rows;
        const spriteSheetCtx = spriteSheetCanvas.getContext('2d');
        spriteSheetCtx.imageSmoothingEnabled = false;

        for (let f = 0; f < state.totalFrames; f++) {
          setCurrentFrame(f);
          compositeAll();

          const hasVideo = layers.some(l => l.visible && l.isVideo && l.video);
          if (hasVideo) {
            await new Promise(resolve => setTimeout(resolve, 80));
          } else {
            await new Promise(resolve => requestAnimationFrame(resolve));
          }

          compositeAll();

          const x = (f % columns) * canvasW;
          const y = Math.floor(f / columns) * canvasH;
          spriteSheetCtx.drawImage(mainCanvas, x, y);

          const pct = Math.round(((f + 1) / state.totalFrames) * 100);
          exportProgressBar.style.width = pct + '%';
          exportProgressText.textContent = `Processing frame ${f + 1} of ${state.totalFrames} (${pct}%)`;
        }

        const blob = await new Promise(resolve => spriteSheetCanvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Could not create SpriteSheet PNG.');

        const saved = await saveFileWithPicker(blob, `${folderName}.png`, 'image/png');
        if (!saved) {
          const link = document.createElement('a');
          link.download = `${folderName}.png`;
          link.href = URL.createObjectURL(blob);
          link.click();
        }

        exportProgressBar.style.width = '100%';
        exportProgressText.textContent = '100%';
      } catch (err) {
        console.error(err);
        alert('Error exporting as SpriteSheet.');
      } finally {
        state.isExporting = false;
        setCurrentFrame(originalFrame);
        if (isPlayingWas) play();
        exportOverlay.classList.add('hidden');
      }
    } else if (exportType === 'zip') {
      try {
        state.isExporting = true;
        const zip = new JSZip();
        const zipFolder = zip.folder(folderName);
        
        for (let f = 0; f < state.totalFrames; f++) {
          setCurrentFrame(f);
          
          // Wait for potential video layer seek/render
          const hasVideo = layers.some(l => l.visible && l.isVideo && l.video);
          if (hasVideo) {
            await new Promise(resolve => setTimeout(resolve, 80));
          } else {
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          
          const dataURL = mainCanvas.toDataURL('image/png');
          const base64Data = dataURL.replace(/^data:image\/(png|jpg);base64,/, "");
          const frameNum = String(f + 1).padStart(4, '0');
          zipFolder.file(`frame_${frameNum}.png`, base64Data, { base64: true });
          
          const pct = Math.round(((f + 1) / state.totalFrames) * 100);
          exportProgressBar.style.width = pct + '%';
          exportProgressText.textContent = pct + '%';
        }
        
        const content = await zip.generateAsync({ type: 'blob' });
        const saved = await saveFileWithPicker(content, `${folderName}.zip`, 'application/zip');
        if (!saved) {
          const link = document.createElement('a');
          link.download = `${folderName}.zip`;
          link.href = URL.createObjectURL(content);
          link.click();
        }
      } catch (err) {
        console.error(err);
        alert('Error exporting as ZIP image sequence.');
      } finally {
        state.isExporting = false;
        setCurrentFrame(originalFrame);
        if (isPlayingWas) play();
        exportOverlay.classList.add('hidden');
      }
    } else if (exportType === 'video') {
      // Export as Video (WebM)
      try {
        state.isExporting = true;
        const stream = mainCanvas.captureStream(state.fps);
        
        let options = { mimeType: 'video/webm;codecs=vp9' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options = { mimeType: 'video/webm' };
        }
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options = { mimeType: 'video/mp4' };
        }
        
        const chunks = [];
        const recorder = new MediaRecorder(stream, options);
        
        recorder.ondataavailable = e => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data);
          }
        };
        
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: chunks[0].type });
          const extension = chunks[0].type.includes('mp4') ? 'mp4' : 'webm';
          const typeStr = chunks[0].type.includes('mp4') ? 'video/mp4' : 'video/webm';
          
          const saved = await saveFileWithPicker(blob, `${folderName}.${extension}`, typeStr);
          if (!saved) {
            const link = document.createElement('a');
            link.download = `${folderName}.${extension}`;
            link.href = URL.createObjectURL(blob);
            link.click();
          }
          
          state.isExporting = false;
          setCurrentFrame(originalFrame);
          if (isPlayingWas) play();
          exportOverlay.classList.add('hidden');
        };
        
        recorder.start();
        
        let currentExportFrame = 0;
        setCurrentFrame(0);
        
        const hasVideo = layers.some(l => l.visible && l.isVideo && l.video);
        const delay = hasVideo ? 120 : 50;
        const intervalTime = 1000 / state.fps + delay;
        
        const exportTimer = setInterval(async () => {
          currentExportFrame++;
          if (currentExportFrame >= state.totalFrames) {
            clearInterval(exportTimer);
            setTimeout(() => {
              recorder.stop();
            }, 150);
          } else {
            setCurrentFrame(currentExportFrame);
            
            if (hasVideo) {
              await new Promise(resolve => setTimeout(resolve, 80));
            }
            
            const pct = Math.round((currentExportFrame / state.totalFrames) * 100);
            exportProgressBar.style.width = pct + '%';
            exportProgressText.textContent = pct + '%';
          }
        }, intervalTime);
      } catch (err) {
        console.error(err);
        alert('Error exporting as video.');
        state.isExporting = false;
        setCurrentFrame(originalFrame);
        if (isPlayingWas) play();
        exportOverlay.classList.add('hidden');
      }
    } else if (exportType === 'gif') {
      // Export as Animated GIF using gifenc
      try {
        state.isExporting = true;
        const { GIFEncoder, quantize, applyPalette } = window.exports;
        const encoder = GIFEncoder();
        
        const delay = Math.round(1000 / state.fps); // delay in ms
        const format = 'rgb565';
        
        for (let f = 0; f < state.totalFrames; f++) {
          setCurrentFrame(f);
          
          const hasVideo = layers.some(l => l.visible && l.isVideo && l.video);
          if (hasVideo) {
            await new Promise(resolve => setTimeout(resolve, 80));
          } else {
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          
          const ctx = mainCanvas.getContext('2d');
          const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
          
          // Quantize and map palette
          const palette = quantize(imgData.data, 256, { format });
          const index = applyPalette(imgData.data, palette, format);
          
          // Write the frame
          encoder.writeFrame(index, canvasW, canvasH, {
            palette,
            delay: delay,
            repeat: f === 0 ? 0 : -1 // repeat 0 only on the first frame (loop infinitely)
          });
          
          const pct = Math.round(((f + 1) / state.totalFrames) * 100);
          exportProgressBar.style.width = pct + '%';
          exportProgressText.textContent = `Processing frame ${f + 1} of ${state.totalFrames} (${pct}%)`;
          
          // Yield control to prevent UI freezing
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        exportProgressText.textContent = 'Finalizing GIF...';
        encoder.finish();
        const buffer = encoder.bytes();
        const blob = new Blob([buffer], { type: 'image/gif' });
        
        const saved = await saveFileWithPicker(blob, `${folderName}.gif`, 'image/gif');
        if (!saved) {
          const link = document.createElement('a');
          link.download = `${folderName}.gif`;
          link.href = URL.createObjectURL(blob);
          link.click();
        }
        
        exportProgressBar.style.width = '100%';
        exportProgressText.textContent = '100%';
      } catch (err) {
        console.error(err);
        alert('Error exporting as Animated GIF.');
      } finally {
        state.isExporting = false;
        setCurrentFrame(originalFrame);
        if (isPlayingWas) play();
        exportOverlay.classList.add('hidden');
      }
    }
  });
})();
