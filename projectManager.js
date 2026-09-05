// ═══════════════════════════════════════════════════════════════
// Illustra — Project Manager Module (Saving & Loading)
// ═══════════════════════════════════════════════════════════════

(function() {
  // Global error diagnostic listener
  window.addEventListener('error', (e) => {
    console.error('Diagnostic Error:', e);
    const msg = `Error: ${e.message} in ${e.filename ? e.filename.split('/').pop() : 'script'}:${e.lineno}`;
    if (window.showToast) window.showToast('❌ ' + msg);
    else alert(msg);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Diagnostic Unhandled Promise Rejection:', e);
    const msg = `Async Error: ${e.reason ? (e.reason.message || e.reason) : 'Unknown'}`;
    if (window.showToast) window.showToast('❌ ' + msg);
    else alert(msg);
  });

  // Persisted file handle — reused on subsequent saves
  window.currentProjectHandle = null;

  // Helper function to save a file using the Windows File System Access API
  // If available, it opens the native Windows Explorer "Save As" file dialog.
  // If unsupported or cancelled/aborted, it falls back to standard download link behavior.
  async function saveFileWithPicker(blob, defaultName, suggestedType) {
    const options = {
      suggestedName: defaultName,
      types: []
    };
    
    if (suggestedType === 'image/png') {
      options.types.push({
        description: 'PNG Image',
        accept: { 'image/png': ['.png'] }
      });
    } else if (suggestedType === 'application/zip') {
      options.types.push({
        description: 'ZIP File',
        accept: { 'application/zip': ['.zip'] }
      });
    } else if (suggestedType === 'video/webm') {
      options.types.push({
        description: 'WebM Video',
        accept: { 'video/webm': ['.webm'] }
      });
    } else if (suggestedType === 'video/mp4') {
      options.types.push({
        description: 'MP4 Video',
        accept: { 'video/mp4': ['.mp4'] }
      });
    }

    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker(options);
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      }
    } catch (err) {
      console.warn("showSaveFilePicker failed or was cancelled:", err);
      if (err.name === 'AbortError') {
        return true;
      }
    }
    return false;
  }

  // ─── Save Project (.tjl) ─────────────────────────────────────────
  async function saveProject() {
    const menuArquivo = document.getElementById('menu-arquivo-dropdown');
    if (menuArquivo) menuArquivo.classList.remove('show');

    // If we already have a handle, write directly without opening picker
    if (window.currentProjectHandle) {
      // Check/request permission before writing to prevent background timeouts or permission loss
      try {
        const status = await window.currentProjectHandle.queryPermission({ mode: 'readwrite' });
        if (status !== 'granted') {
          const newStatus = await window.currentProjectHandle.requestPermission({ mode: 'readwrite' });
          if (newStatus !== 'granted') {
            await saveProjectAs();
            return;
          }
        }
      } catch (err) {
        console.warn('Failed to query/request file handle permission:', err);
      }

      const blob = await buildProjectBlob();
      try {
        const writable = await window.currentProjectHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        showToast('💾 Project saved!');
        await addRecentProject(window.currentProjectName, window.currentProjectHandle);
        updateRecentProjectsList();
      } catch (err) {
        console.warn('Direct write failed, falling back to picker:', err);
        window.currentProjectHandle = null;
        await saveProjectAs();
      }
      return;
    }

    // No handle yet — first save, open the picker
    await saveProjectAs();
  }

  // "Salvar Como" — always opens the picker and updates the stored handle
  async function saveProjectAs() {
    const menuArquivo = document.getElementById('menu-arquivo-dropdown');
    if (menuArquivo) menuArquivo.classList.remove('show');

    const blob = await buildProjectBlob();

    const name = window.currentProjectName ? `${window.currentProjectName}.tjl` : 'project.tjl';
    const options = {
      suggestedName: name,
      types: [{
        description: 'Illustra Project (.tjl)',
        accept: { 'application/json': ['.tjl'] }
      }]
    };

    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker(options);
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        window.currentProjectHandle = handle; // remember for future saves
        
        // Update project name and title bar
        const projectName = handle.name.replace(/\.tjl$/i, '');
        window.currentProjectName = projectName;
        document.title = `Illustra (${projectName})`;
        
        showToast('💾 Project saved!');
        await addRecentProject(projectName, handle);
        updateRecentProjectsList();
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // user cancelled
      console.warn('showSaveFilePicker failed:', err);
    }

    // Fallback: trigger browser download (no handle persisted)
    const link = document.createElement('a');
    const defaultName = window.currentProjectName ? `${window.currentProjectName}.tjl` : 'project.tjl';
    link.download = defaultName;
    link.href = URL.createObjectURL(blob);
    link.click();

    if (!window.currentProjectName) {
      window.currentProjectName = 'project';
      document.title = 'Illustra (project)';
    }

    showToast('💾 Project downloaded!');
    await addRecentProject(window.currentProjectName, window.currentProjectHandle);
    updateRecentProjectsList();
  }

  // Serializes the full project state to a Blob — shared by save & save-as
  async function buildProjectBlob() {
    if ((state.tool === 'lasso' || state.tool === 'magicwand') && state.lassoActive) bakeLassoSelection();

    const layerData = await Promise.all(layers.map(async (l) => {
      if (l.isVideo) {
        return {
          id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
          blendMode: l.blendMode || 'source-over',
          isVideo: true,
          videoPath: l.videoPath || '',
          videoCacheId: l.videoCacheId || '',
          videoDuration: l.videoOffline ? (l.videoDuration || 0) : (l.video ? l.video.duration : 0)
        };
      }

      const framesData = await Promise.all(l.frames.map(async (f) => {
        if (!f.isKeyframe) return { isKeyframe: false, data: null };
        if (!f.canvas) return { isKeyframe: true, data: null };
        
        if (typeof window.syncBackingCanvas === 'function') {
          window.syncBackingCanvas(f);
        }

        const dataUrl = await new Promise(resolve => {
          f.canvas.toBlob(blob => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          }, 'image/png');
        });

        let backingDataUrl = null;
        if (f.backingCanvas) {
          backingDataUrl = await new Promise(resolve => {
            f.backingCanvas.toBlob(blob => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            }, 'image/png');
          });
        }

        return {
          isKeyframe: true,
          data: dataUrl,
          offsetX: f.offsetX || 0,
          offsetY: f.offsetY || 0,
          backingData: backingDataUrl
        };
      }));

      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
        blendMode: l.blendMode || 'source-over',
        isVideo: false, frames: framesData
      };
    }));

    const project = {
      _format: 'TJL', version: 1,
      canvasW, canvasH,
      fps: state.fps, totalFrames: state.totalFrames,
      currentFrame: state.currentFrame,
      fgColor: state.fgColor, bgColor: state.bgColor,
      layers: layerData
    };

    return new Blob([JSON.stringify(project)], { type: 'application/json' });
  }

  // ─── Open Project (.tjl) ─────────────────────────────────────────
  async function openProject() {
    const menuArquivo = document.getElementById('menu-arquivo-dropdown');
    if (menuArquivo) menuArquivo.classList.remove('show');

    // Prefer the native File Open picker
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'Illustra Project (.tjl)',
            accept: { 'application/json': ['.tjl'] }
          }],
          multiple: false
        });

        // Request write permission IMMEDIATELY while user gesture is active
        try {
          const perm = await handle.requestPermission({ mode: 'readwrite' });
          window.currentProjectHandle = (perm === 'granted') ? handle : null;
        } catch (err) {
          console.warn('Failed to request readwrite permission immediately:', err);
          window.currentProjectHandle = handle;
        }

        const file = await handle.getFile();
        await loadProjectFile(file);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled
        console.warn('showOpenFilePicker failed, using input fallback:', err);
      }
    }

    // Fallback: hidden <input type="file"> — no write handle available
    window.currentProjectHandle = null;
    document.getElementById('project-open-input').click();
  }

  async function loadProjectFile(file, name) {
    let project;
    try {
      const text = await file.text();
      project = JSON.parse(text);
    } catch (parseErr) {
      console.error('TJL parse error:', parseErr);
      alert('Invalid or corrupted file.');
      return;
    }

    if (project._format !== 'TJL') {
      alert('This file is not a valid Illustra project (.tjl).');
      return;
    }

    // Update project name and title bar
    if (file && file.name) {
      const projectName = file.name.replace(/\.tjl$/i, '');
      window.currentProjectName = projectName;
      document.title = `Illustra (${projectName})`;
    } else if (name) {
      window.currentProjectName = name;
      document.title = `Illustra (${name})`;
    }

    // Stop playback
    if (state.isPlaying) pause();

    // Reinitialise canvas dimensions
    const w = project.canvasW || 1280;
    const h = project.canvasH || 720;
    canvasW = w;
    canvasH = h;
    mainCanvas.width  = w;
    mainCanvas.height = h;
    previewCanvas.width  = w;
    previewCanvas.height = h;
    document.getElementById('canvas-size-display').textContent = `${w} × ${h} px`;

    // Timeline settings
    state.totalFrames  = project.totalFrames || 24;
    state.fps          = project.fps || 12;
    state.currentFrame = Math.min(project.currentFrame || 0, state.totalFrames - 1);
    state.loop         = true;
    document.getElementById('timeline-fps').value = state.fps;

    // Colors
    if (project.fgColor) setFgColor(project.fgColor);
    if (project.bgColor) setBgColor(project.bgColor);

    // Rebuild layers
    layers = [];
    layerIdCount = 1;
    activeLayerIdx = 0;

    for (const ld of (project.layers || [])) {
      if (ld.isVideo) {
        const vid = document.createElement('video');
        const path = ld.videoPath || ld.videoSrc || '';
        
        const videoLayer = {
          id: ld.id,
          name: ld.name,
          visible: ld.visible,
          opacity: ld.opacity,
          blendMode: ld.blendMode || 'source-over',
          isVideo: true,
          video: vid,
          videoPath: path,
          videoCacheId: ld.videoCacheId || '',
          videoDuration: ld.videoDuration || 0,
          videoOffline: false,
          frames: []
        };
        for (let f = 0; f < state.totalFrames; f++) videoLayer.frames.push(createFrameData());

        // Setup base events
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        vid.addEventListener('seeked', () => compositeAll());
        vid.addEventListener('error', () => {
          videoLayer.videoOffline = true;
          renderLayerPanel();
          renderTimeline();
        }, { once: true });

        // Attempt to load
        const tryLoad = async () => {
          // 1. Try IndexedDB cache first
          if (ld.videoCacheId && window.loadVideoFromCache) {
            try {
              const file = await window.loadVideoFromCache(ld.videoCacheId);
              if (file) {
                vid.src = URL.createObjectURL(file);
                return;
              }
            } catch (e) { console.warn('Failed to load video from IndexedDB cache', e); }
          }

          // 2. Fallback to relative filename parsing
          let safeSrc = path;
          if (/^[a-zA-Z]:\\/.test(path) || path.startsWith('/Users/')) {
              safeSrc = path.split(/[\\/]/).pop();
          }
          vid.src = safeSrc;
        };

        tryLoad();

        layers.push(videoLayer);
        layerIdCount = Math.max(layerIdCount, ld.id + 1);
        continue;
      }

      const newLayer = {
        id: ld.id,
        name: ld.name,
        visible: ld.visible,
        opacity: ld.opacity,
        blendMode: ld.blendMode || 'source-over',
        isVideo: false,
        frames: []
      };
      layerIdCount = Math.max(layerIdCount, ld.id + 1);

      for (let fi = 0; fi < state.totalFrames; fi++) {
        const fd = (ld.frames || [])[fi];
        const frameObj = createFrameData();

        if (fd && fd.isKeyframe && fd.data) {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          frameObj.canvas = c;
          frameObj.ctx = c.getContext('2d');
          frameObj.offsetX = fd.offsetX || 0;
          frameObj.offsetY = fd.offsetY || 0;
          await new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
              frameObj.ctx.clearRect(0, 0, w, h);
              frameObj.ctx.drawImage(img, 0, 0);
              frameObj.isKeyframe = true;
              resolve();
            };
            img.onerror = resolve;
            img.src = fd.data;
          });
          if (fd.backingData) {
            const bc = document.createElement('canvas');
            bc.width = w * 3; bc.height = h * 3;
            const bctx = bc.getContext('2d');
            await new Promise(resolve => {
              const img = new Image();
              img.onload = () => {
                bctx.clearRect(0, 0, w * 3, h * 3);
                bctx.drawImage(img, 0, 0);
                frameObj.backingCanvas = bc;
                resolve();
              };
              img.onerror = resolve;
              img.src = fd.backingData;
            });
          }
        } else {
          frameObj.isKeyframe = !!(fd && fd.isKeyframe);
        }
        newLayer.frames.push(frameObj);
      }
      layers.push(newLayer);
    }

    if (layers.length === 0) {
      layers.push(createLayerData('Layer 1'));
    }

    // Reset history & transient state
    state.history   = [];
    state.redoStack = [];
    state.lassoActive = false;
    state.lassoPath   = [];
    pctx.clearRect(0, 0, w, h);

    // Rebuild UI
    try {
      if (typeof syncDOMVideos === 'function') syncDOMVideos();
      renderLayerPanel();
      renderTimeline();
      compositeAll();
      applyTransform();
      if (typeof saveHistory === 'function') saveHistory();
      showToast('📂 Project loaded!');
      await addRecentProject(window.currentProjectName, window.currentProjectHandle);
      updateRecentProjectsList();
    } catch (uiErr) {
      console.error('TJL UI rebuild error:', uiErr);
      alert('Error rebuilding interface: ' + uiErr.message);
    }
  }

  // Hook the hidden file input fallback
  document.getElementById('project-open-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await loadProjectFile(file);
    e.target.value = ''; // reset
  });

  // Wire up Save / Open menu buttons
  document.getElementById('menu-save-project').addEventListener('click', saveProject);
  document.getElementById('menu-open-project').addEventListener('click', openProject);

  // ─── IndexedDB Recent Projects Lógica ──────────────────────────────────
  function openRecentDB() {
    return new Promise((resolve, reject) => {
      // Use a new database name IllustraRecentProjectsDB_v3 (version 1)
      // to completely avoid block upgrade issues from earlier configurations
      const request = indexedDB.open('IllustraRecentProjectsDB_v3', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('recent_projects')) {
          db.createObjectStore('recent_projects', { keyPath: 'name' });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
      request.onblocked = (e) => {
        console.warn('Database open is blocked:', e);
        reject(new Error('IndexedDB open is blocked by another tab or connection'));
      };
    });
  }

  async function addRecentProject(name, handle) {
    if (!name) return;
    try {
      // 1. Build the blob BEFORE opening the transaction to prevent TransactionInactiveError
      const blob = await buildProjectBlob();
      
      // 2. Open DB and create write transaction
      const db = await openRecentDB();
      const tx = db.transaction('recent_projects', 'readwrite');
      const store = tx.objectStore('recent_projects');
      
      const entry = {
        name: name,
        lastOpened: Date.now(),
        fileHandle: handle || null,
        projectBlob: blob
      };
      
      // Perform put and limit within the SAME active transaction scope
      await new Promise((resolve, reject) => {
        const req = store.put(entry);
        req.onsuccess = () => {
          // Transaction is still active here; query and prune oldest items
          const getAllReq = store.getAll();
          getAllReq.onerror = () => reject(getAllReq.error);
          getAllReq.onsuccess = () => {
            const items = getAllReq.result;
            if (items.length <= 10) {
              resolve();
              return;
            }
            items.sort((a, b) => a.lastOpened - b.lastOpened);
            const toDelete = items.length - 10;
            let deleted = 0;
            for (let i = 0; i < toDelete; i++) {
              const delReq = store.delete(items[i].name);
              delReq.onerror = () => reject(delReq.error);
              delReq.onsuccess = () => {
                deleted++;
                if (deleted === toDelete) resolve();
              };
            }
          };
        };
        req.onerror = () => {
          // If storing the FileHandle failed due to structured clone limitations,
          // retry without it.
          if (entry.fileHandle) {
            console.warn('Retrying saving recent project without fileHandle...');
            entry.fileHandle = null;
            const retryReq = store.put(entry);
            retryReq.onsuccess = () => resolve();
            retryReq.onerror = () => reject(retryReq.error);
          } else {
            reject(req.error);
          }
        };
      });
    } catch (err) {
      console.warn('Failed to add recent project to IndexedDB:', err);
      if (window.showToast) {
        window.showToast('⚠️ Error saving recent: ' + err.message);
      }
    }
  }

  async function getRecentProjects() {
    try {
      const db = await openRecentDB();
      const tx = db.transaction('recent_projects', 'readonly');
      const store = tx.objectStore('recent_projects');
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const items = req.result;
          items.sort((a, b) => b.lastOpened - a.lastOpened);
          resolve(items);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('Failed to get recent projects:', err);
      return [];
    }
  }

  async function loadRecentProject(name) {
    try {
      const db = await openRecentDB();
      const tx = db.transaction('recent_projects', 'readonly');
      const store = tx.objectStore('recent_projects');
      const entry = await new Promise((resolve, reject) => {
        const req = store.get(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      
      if (!entry) {
        alert('Project not found in recents.');
        return;
      }

      if (entry.fileHandle && window.showOpenFilePicker) {
        try {
          const handle = entry.fileHandle;
          const status = await handle.queryPermission({ mode: 'readwrite' });
          if (status !== 'granted') {
            const newStatus = await handle.requestPermission({ mode: 'readwrite' });
            if (newStatus !== 'granted') {
              throw new Error('Permission denied');
            }
          }
          window.currentProjectHandle = handle;
          const file = await handle.getFile();
          await loadProjectFile(file, name);
          await addRecentProject(name, handle);
          updateRecentProjectsList();
          return;
        } catch (err) {
          console.warn('Could not open file handle, falling back to cached blob:', err);
        }
      }

      if (entry.projectBlob) {
        window.currentProjectHandle = entry.fileHandle || null;
        await loadProjectFile(entry.projectBlob, name);
        await addRecentProject(name, window.currentProjectHandle);
        updateRecentProjectsList();
      } else {
        alert('Project data unavailable.');
      }
    } catch (err) {
      console.error('Failed to load recent project:', err);
      alert('Error opening recent project: ' + err.message);
    }
  }

  async function updateRecentProjectsList() {
    const container = document.getElementById('menu-recent-submenu');
    if (!container) return;
    
    const recents = await getRecentProjects();
    if (recents.length === 0) {
      container.innerHTML = `<div style="padding: 8px 12px; font-size: 12px; color: var(--text-muted); font-style: italic; text-align: center;">No recent projects</div>`;
      return;
    }
    
    container.innerHTML = '';
    recents.forEach(entry => {
      const btn = document.createElement('button');
      btn.className = 'dropdown-item';
      btn.style.justifyContent = 'space-between';
      
      const nameSpan = document.createElement('span');
      nameSpan.textContent = entry.name;
      nameSpan.style.whiteSpace = 'nowrap';
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.maxWidth = '180px';
      
      btn.appendChild(nameSpan);
      
      const dateObj = new Date(entry.lastOpened);
      const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      btn.title = `${entry.name}\nLast access: ${dateStr}`;
      
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const menu = document.getElementById('menu-arquivo-dropdown');
        if (menu) menu.classList.remove('show');
        await loadRecentProject(entry.name);
      });
      
      container.appendChild(btn);
    });
  }

  // Setup menu trigger and mouseenter events
  const recentWrapper = document.getElementById('recent-submenu-wrapper');
  if (recentWrapper) {
    recentWrapper.addEventListener('mouseenter', updateRecentProjectsList);
    recentWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }
  
  // Initial population of the list
  updateRecentProjectsList();

  // Expose public functions to window
  window.saveFileWithPicker = saveFileWithPicker;
  window.saveProject = saveProject;
  window.openProject = openProject;
  window.loadProjectFile = loadProjectFile;
})();
