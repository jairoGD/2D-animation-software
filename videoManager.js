// ═══════════════════════════════════════════════════════════════
// Illustra — Video Layer Manager Module
// ═══════════════════════════════════════════════════════════════

(function() {
  // ─── IndexedDB Video Cache ─────────────────────────────────────────
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('IllustraVideoCache', 1);
    request.onupgradeneeded = (e) => {
      e.target.result.createObjectStore('videos');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  window.saveVideoToCache = async function(id, file) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readwrite');
      tx.objectStore('videos').put(file, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  window.loadVideoFromCache = async function(id) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const req = tx.objectStore('videos').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(tx.error);
    });
  };

  function syncDOMVideos() {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    // Get all video elements currently in the container
    const domVideos = container.querySelectorAll('video');

    // Get list of videos that should exist
    const activeVideos = layers.filter(l => l.isVideo && l.video).map(l => l.video);

    // Remove any video that is not in the active layers
    domVideos.forEach(v => {
      if (!activeVideos.includes(v)) {
        v.pause();
        v.src = "";
        v.load();
        v.remove();
      }
    });

    // Add any active video that is not in the DOM
    const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.isVideo && l.video) {
        if (!l.video.parentNode) {
          l.video.style.position = 'absolute';
          l.video.style.top = '0';
          l.video.style.left = '0';
          l.video.style.width = canvasW + 'px';
          l.video.style.height = canvasH + 'px';
          l.video.style.pointerEvents = 'none';
          l.video.style.transformOrigin = '0 0';
          l.video.style.display = 'none';
          container.insertBefore(l.video, mainCanvas);
        }
        // Ensure correct transform, size and blend mode
        l.video.style.transform = t;
        l.video.style.width = canvasW + 'px';
        l.video.style.height = canvasH + 'px';
        
        let cssBlend = l.blendMode || 'normal';
        if (cssBlend === 'source-over') cssBlend = 'normal';
        if (cssBlend === 'lighter') cssBlend = 'plus-lighter';
        l.video.style.mixBlendMode = cssBlend;
      }
    }
  }

  function reconnectVideoLayer(layer) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) {
        input.remove();
        return;
      }

      const uniqueId = 'video_' + Date.now() + '_' + file.name;
      try {
        await window.saveVideoToCache(uniqueId, file);
      } catch (e) { console.warn("Failed to cache video", e); }

      const url = URL.createObjectURL(file);
      layer.video.src = url;
      layer.videoPath = file.path || file.name;
      layer.videoCacheId = uniqueId;
      layer.videoOffline = false;

      layer.video.addEventListener('loadedmetadata', () => {
        layer.videoDuration = layer.video.duration;
        // Sync DOM video placement
        syncDOMVideos();
        renderLayerPanel();
        renderTimeline();
        compositeAll();
        saveHistory();
        showToast('🎥 Video reconnected!');
      }, { once: true });

      layer.video.addEventListener('error', () => {
        layer.videoOffline = true;
        renderLayerPanel();
        renderTimeline();
        alert('Error loading the selected video.');
      }, { once: true });

      input.remove();
    });

    input.click();
  }

  // Wire up video import menu button & file input listener
  const videoFileInput = document.getElementById('video-input');
  
  document.getElementById('menu-import-video').addEventListener('click', () => {
    const menuArquivo = document.getElementById('menu-arquivo-dropdown');
    if (menuArquivo) menuArquivo.classList.remove('show');
    videoFileInput.value = '';
    videoFileInput.click();
  });

  async function importVideoFile(file) {
    if (!file) return false;

    const uniqueId = 'video_' + Date.now() + '_' + file.name;
    try {
      await window.saveVideoToCache(uniqueId, file);
    } catch (e) { console.warn("Failed to cache video", e); }

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    return new Promise((resolve) => {
      // Redraw whenever a seek completes (for scrubbing accuracy)
      video.addEventListener('seeked', () => {
        compositeAll();
      });

      video.addEventListener('loadedmetadata', () => {
        const videoFramesCount = Math.ceil(video.duration * state.fps);

        // Expand timeline if the video is longer than existing frames
        if (videoFramesCount > state.totalFrames) {
          const extra = videoFramesCount - state.totalFrames;
          for (let i = 0; i < extra; i++) {
            layers.forEach(l => {
              if (!l.isVideo) l.frames.push(createFrameData());
            });
          }
          state.totalFrames = videoFramesCount;
        }

        const shortName = file.name.replace(/\.[^.]+$/, '').substring(0, 20);
        const videoLayer = {
          id: layerIdCount++,
          name: shortName || 'Video',
          visible: true,
          opacity: 0.6,
          blendMode: 'source-over',
          isVideo: true,
          video: video,
          videoPath: file.path || file.name,
          videoCacheId: uniqueId,
          videoDuration: video.duration,
          videoOffline: false,
          frames: []
        };

        // Insert at bottom of stack (drawn first, under all drawings)
        layers.push(videoLayer);

        syncDOMVideos();
        renderLayerPanel();
        renderTimeline();
        compositeAll();
        saveHistory();
        showToast('🎥 Video imported!');
        resolve(true);
      }, { once: true });

      video.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        alert('Error loading the video. Make sure the format is supported by your browser.');
        resolve(false);
      }, { once: true });

      video.src = url;
      video.load();
    });
  }

  videoFileInput.addEventListener('change', async () => {
    const file = videoFileInput.files[0];
    if (file) await importVideoFile(file);
  });

  // Expose functions to global scope
  window.syncDOMVideos = syncDOMVideos;
  window.reconnectVideoLayer = reconnectVideoLayer;
  window.importVideoFile = importVideoFile;
})();
