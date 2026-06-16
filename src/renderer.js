'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const promptEl       = document.getElementById('prompt');
const countEl        = document.getElementById('count');
const btnGenerate    = document.getElementById('btn-generate');
const btnCancel      = document.getElementById('btn-cancel');
const btnArchive     = document.getElementById('btn-archive');
const btnArchiveDisplay = document.getElementById('btn-archive-display');
const btnSync        = document.getElementById('btn-sync');
const statusEl       = document.getElementById('status');
const tabCurrent     = document.getElementById('tab-current');
const tabGallery     = document.getElementById('tab-gallery');
const tabDisplayGallery = document.getElementById('tab-display-gallery');
const viewCurrent    = document.getElementById('view-current');
const viewGallery    = document.getElementById('view-gallery');
const viewDisplayGallery = document.getElementById('view-display-gallery');
const currentEmpty   = document.getElementById('current-empty');
const currentDisplay = document.getElementById('current-display');
const galleryEl      = document.getElementById('gallery');
const galleryEmpty   = document.getElementById('gallery-empty');
const galleryBadge   = document.getElementById('gallery-badge');
const displayGalleryEl = document.getElementById('display-gallery');
const displayGalleryEmpty = document.getElementById('display-gallery-empty');
const displayGalleryBadge = document.getElementById('display-gallery-badge');
const lightbox       = document.getElementById('lightbox');
const lightboxImg    = document.getElementById('lightbox-img');
const lightboxDisplaySave = document.getElementById('lightbox-display-save');
const lightboxSave   = document.getElementById('lightbox-save');
const lightboxCopy   = document.getElementById('lightbox-copy');
const lightboxFill   = document.getElementById('lightbox-fill');
const lightboxPrev   = document.getElementById('lightbox-prev');
const lightboxNext   = document.getElementById('lightbox-next');
const fillView       = document.getElementById('fill-view');
const fillImg        = document.getElementById('fill-img');
const fillClose      = document.getElementById('fill-close');
const viewerToggle   = document.getElementById('viewer-toggle');
const settingsBtn    = document.getElementById('settings-btn');
const settingsMenu   = document.getElementById('settings-menu');
const themeInputs    = Array.from(document.querySelectorAll('input[name="theme"]'));
const persistentHideUiInput = document.getElementById('persistent-hide-ui');
const autoOpenLastFillViewInput = document.getElementById('auto-open-last-fill-view');
const rememberWindowPositionInput = document.getElementById('remember-window-position');
const squareAppCornersInput = document.getElementById('square-app-corners');
const expandBorderlessEdgesInput = document.getElementById('expand-borderless-edges');
const apiWarning     = document.getElementById('api-warning');
const archiveConfirm = document.getElementById('archive-confirm');
const archiveCopy    = document.getElementById('archive-confirm-copy');
const archiveCancel  = document.getElementById('archive-cancel');
const archiveConfirmBtn = document.getElementById('archive-confirm-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let generating     = false;
let lightboxDataUrl = null;
let lightboxImages = [];
let lightboxIndex  = -1;
let galleryCount       = 0;
let galleryImages      = [];
let galleryLoaded      = false;
let galleryLoading     = null;
let galleryPageLoading = false;
let galleryObserver    = null;
let displayGalleryCount = 0;
let displayGalleryImages = [];
let displayGalleryLoaded = false;
let displayGalleryLoading = null;
let displayGalleryKeys = new Set();
let pendingDisplayGalleryRemovals = new Set();
let activeTab = 'current';
let syncingData = false;
let lastBatch      = null;  // { images: string[], files: string[], prompt: string }
let viewerMode     = false;
let persistentHideUi = false;
let fillViewAutoHidUi = false;
let appSettings = defaultAppSettings();
let saveWindowTimer = null;
const LAST_DISPLAYED_IMAGE_KEY = 'lastDisplayedFillImage';
const FILL_VIEW_OVERSCAN_PX = 2;
const GALLERY_PAGE_SIZE = 30;
const fillTransform = {
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startPanX: 0,
  startPanY: 0,
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  applyTheme(localStorage.getItem('theme') || 'dark-gray');
  applyPersistentHideUi(localStorage.getItem('persistentHideUi') === 'true');
  await loadAppSettings();
  if (appSettings.rememberWindowPosition) {
    await window.api.restoreWindowState().catch(() => {});
  }
  if (appSettings.expandBorderlessEdges && (!appSettings.rememberWindowPosition || !appSettings.window)) {
    await window.api.adjustWindowBorderlessEdges(true).catch(() => {});
    await saveWindowStateNow();
  }
  if (appSettings.autoOpenLastFillView) {
    openLastDisplayedImageOnStartup();
  }
  if (fillView.classList.contains('hidden')) promptEl.focus();

  if (window.api.isPrimaryInstance) {
    window.api.isPrimaryInstance()
      .then(isPrimary => {
        document.body.dataset.primaryInstance = String(isPrimary);
      })
      .catch(() => {});
  }

  refreshApiKeyStatus();

  window.api.loadGallerySummary()
    .then(summary => {
      galleryCount = summary?.count || 0;
      if (galleryCount > 0) updateGalleryBadge();
    })
    .catch(err => {
      setStatus(`Gallery check failed: ${err.message}`, 'error');
    });

  window.api.loadDisplayGallerySummary()
    .then(summary => {
      displayGalleryCount = summary?.count || 0;
      displayGalleryKeys = new Set(summary?.sourceKeys || []);
      if (displayGalleryCount > 0) updateDisplayGalleryBadge();
    })
    .catch(err => {
      setStatus(`Display gallery check failed: ${err.message}`, 'error');
    });
}

// ── Window controls ───────────────────────────────────────────────────────────
function toggleMaximizeAndRemember() {
  window.api.toggleMaximize();
  scheduleWindowStateSaveBurst();
}

document.getElementById('btn-minimize').addEventListener('click', async () => {
  await saveWindowStateNow();
  window.api.minimize();
});
document.getElementById('btn-maximize').addEventListener('click', toggleMaximizeAndRemember);
document.getElementById('btn-close').addEventListener('click', async () => {
  await saveWindowStateNow();
  window.api.close();
});
document.getElementById('titlebar').addEventListener('dblclick',  toggleMaximizeAndRemember);
document.getElementById('titlebar').addEventListener('mousedown', e => {
  if (e.button === 0) scheduleWindowStateSaveBurst();
});
document.querySelector('.viewer-drag-strip')?.addEventListener('mousedown', e => {
  if (e.button === 0) scheduleWindowStateSaveBurst();
});
window.addEventListener('resize', scheduleWindowStateSave);
window.addEventListener('blur', scheduleWindowStateSave);
window.addEventListener('beforeunload', () => {
  if (appSettings.rememberWindowPosition) {
    window.api.saveWindowState().catch(() => {});
  }
});

// ── Settings ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  const selected = theme === 'classic' ? 'classic' : 'dark-gray';
  document.body.classList.toggle('theme-classic', selected === 'classic');
  themeInputs.forEach(input => {
    input.checked = input.value === selected;
  });
  localStorage.setItem('theme', selected);
}

function applyPersistentHideUi(active) {
  persistentHideUi = active;
  persistentHideUiInput.checked = active;
  localStorage.setItem('persistentHideUi', String(active));
}

function defaultAppSettings() {
  return {
    rememberWindowPosition: true,
    autoOpenLastFillView: false,
    squareAppCorners: false,
    expandBorderlessEdges: false,
    window: null
  };
}

function normalizeAppSettings(settings) {
  const base = defaultAppSettings();
  return {
    ...base,
    ...(settings || {}),
    rememberWindowPosition: settings?.rememberWindowPosition !== false,
    autoOpenLastFillView: !!settings?.autoOpenLastFillView,
    squareAppCorners: !!settings?.squareAppCorners,
    expandBorderlessEdges: !!settings?.expandBorderlessEdges
  };
}

function applyAppSettingsInputs() {
  rememberWindowPositionInput.checked = appSettings.rememberWindowPosition;
  autoOpenLastFillViewInput.checked = appSettings.autoOpenLastFillView;
  squareAppCornersInput.checked = appSettings.squareAppCorners;
  expandBorderlessEdgesInput.checked = appSettings.expandBorderlessEdges;
  document.body.classList.toggle('square-corners', appSettings.squareAppCorners);
}

async function loadAppSettings() {
  try {
    appSettings = normalizeAppSettings(await window.api.loadSettings());
  } catch (err) {
    console.error('Failed to load app settings:', err);
    appSettings = defaultAppSettings();
  }
  applyAppSettingsInputs();
}

async function saveAppSettings() {
  appSettings = normalizeAppSettings(await window.api.saveSettings(appSettings));
  applyAppSettingsInputs();
  return appSettings;
}

async function saveWindowStateNow() {
  if (!appSettings.rememberWindowPosition) return;
  await window.api.saveWindowState().catch(() => {});
}

function scheduleWindowStateSave() {
  if (!appSettings.rememberWindowPosition) return;
  clearTimeout(saveWindowTimer);
  saveWindowTimer = setTimeout(() => {
    window.api.saveWindowState().catch(() => {});
  }, 450);
}

function scheduleWindowStateSaveBurst() {
  scheduleWindowStateSave();
  setTimeout(scheduleWindowStateSave, 350);
  setTimeout(scheduleWindowStateSave, 1000);
  setTimeout(scheduleWindowStateSave, 1800);
}

function closeSettingsMenu() {
  settingsMenu.classList.add('hidden');
}

settingsBtn.addEventListener('click', e => {
  e.stopPropagation();
  settingsMenu.classList.toggle('hidden');
  if (!settingsMenu.classList.contains('hidden')) refreshApiKeyStatus();
});
settingsBtn.addEventListener('dblclick', e => e.stopPropagation());

settingsMenu.addEventListener('click', e => e.stopPropagation());
themeInputs.forEach(input => {
  input.addEventListener('change', () => {
    if (input.checked) applyTheme(input.value);
  });
});
persistentHideUiInput.addEventListener('change', () => {
  applyPersistentHideUi(persistentHideUiInput.checked);
});
autoOpenLastFillViewInput.addEventListener('change', async () => {
  appSettings.autoOpenLastFillView = autoOpenLastFillViewInput.checked;
  await saveAppSettings().catch(err => {
    console.error('Failed to save app settings:', err);
  });
});
rememberWindowPositionInput.addEventListener('change', async () => {
  appSettings.rememberWindowPosition = rememberWindowPositionInput.checked;
  await saveAppSettings().catch(err => {
    console.error('Failed to save app settings:', err);
  });
  if (appSettings.rememberWindowPosition) await saveWindowStateNow();
});
squareAppCornersInput.addEventListener('change', async () => {
  appSettings.squareAppCorners = squareAppCornersInput.checked;
  applyAppSettingsInputs();
  await window.api.setWindowSquareCorners(appSettings.squareAppCorners).catch(err => {
    console.error('Failed to apply window corner setting:', err);
  });
  await saveAppSettings().catch(err => {
    console.error('Failed to save app settings:', err);
  });
});
expandBorderlessEdgesInput.addEventListener('change', async () => {
  appSettings.expandBorderlessEdges = expandBorderlessEdgesInput.checked;
  applyAppSettingsInputs();
  await saveAppSettings().catch(err => {
    console.error('Failed to save app settings:', err);
  });
  await window.api.adjustWindowBorderlessEdges(appSettings.expandBorderlessEdges).catch(err => {
    console.error('Failed to apply borderless edge setting:', err);
  });
  await saveWindowStateNow();
});

const apiKeyUi = {
  xai: {
    input: document.getElementById('xai-key-input'),
    status: document.getElementById('xai-key-status')
  }
};

function renderApiKeyStatus(statuses) {
  let hasKey = false;
  for (const status of statuses || []) {
    const ui = apiKeyUi[status.id];
    if (!ui) continue;
    hasKey = hasKey || !!status.configured;
    if (status.configured) {
      const suffix = status.last4 ? `...${status.last4}` : 'saved';
      ui.status.textContent = `${status.source} (${suffix})`;
      ui.status.classList.add('configured');
    } else {
      ui.status.textContent = 'Not set';
      ui.status.classList.remove('configured');
    }
  }
  apiWarning.classList.toggle('hidden', hasKey);
}

async function refreshApiKeyStatus() {
  try {
    renderApiKeyStatus(await window.api.apiKeyStatus());
  } catch (err) {
    console.error('Failed to load API key status:', err);
    try {
      apiWarning.classList.toggle('hidden', await window.api.checkApiKey());
    } catch {}
  }
}

async function saveApiKey(providerId) {
  const ui = apiKeyUi[providerId];
  const key = ui?.input?.value.trim();
  if (!ui || !key) {
    if (ui?.status) ui.status.textContent = 'Enter a key first';
    return;
  }

  ui.status.textContent = 'Saving...';
  try {
    renderApiKeyStatus(await window.api.saveApiKey(providerId, key));
    ui.input.value = '';
  } catch (err) {
    ui.status.textContent = err?.message || String(err);
  }
}

async function deleteApiKey(providerId) {
  const ui = apiKeyUi[providerId];
  if (ui?.status) ui.status.textContent = 'Removing...';
  try {
    renderApiKeyStatus(await window.api.deleteApiKey(providerId));
    if (ui?.input) ui.input.value = '';
  } catch (err) {
    if (ui?.status) ui.status.textContent = err?.message || String(err);
  }
}

document.querySelectorAll('.api-key-save').forEach(btn => {
  btn.addEventListener('click', () => saveApiKey(btn.dataset.provider));
});

document.querySelectorAll('.api-key-remove').forEach(btn => {
  btn.addEventListener('click', () => deleteApiKey(btn.dataset.provider));
});

document.querySelectorAll('.api-key-row input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    saveApiKey(input.closest('.api-key-row')?.dataset.provider);
  });
});

document.addEventListener('click', closeSettingsMenu);
btnSync.addEventListener('click', syncAppData);

// ── Tab switching ─────────────────────────────────────────────────────────────
function showTab(name) {
  const previousTab = activeTab;
  activeTab = name;
  const isCurrent = name === 'current';
  const isGallery = name === 'gallery';
  const isDisplayGallery = name === 'display-gallery';
  // classList.toggle avoids fighting display:none !important from .hidden
  viewCurrent.classList.toggle('hidden', !isCurrent);
  viewGallery.classList.toggle('hidden', !isGallery);
  viewDisplayGallery.classList.toggle('hidden', !isDisplayGallery);
  tabCurrent.classList.toggle('active', isCurrent);
  tabGallery.classList.toggle('active', isGallery);
  tabDisplayGallery.classList.toggle('active', isDisplayGallery);
  if (isGallery) loadGalleryOnce();
  if (isDisplayGallery) loadDisplayGalleryOnce();
  if (previousTab === 'display-gallery' && !isDisplayGallery) commitPendingDisplayGalleryRemovals();
}

tabCurrent.addEventListener('click', () => showTab('current'));
tabGallery.addEventListener('click', () => showTab('gallery'));
tabDisplayGallery.addEventListener('click', () => showTab('display-gallery'));

// ── Viewer mode ───────────────────────────────────────────────────────────────
function setViewerMode(active) {
  viewerMode = active;
  if (active) closeSettingsMenu();
  document.body.classList.toggle('viewer-mode', active);
  viewerToggle.setAttribute('aria-pressed', String(active));
}

function toggleViewerMode() {
  setViewerMode(!viewerMode);
}

viewerToggle.addEventListener('click', toggleViewerMode);

// ── Generate ──────────────────────────────────────────────────────────────────
btnGenerate.addEventListener('click', generate);
promptEl.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate();
});

async function generate() {
  const prompt = promptEl.value.trim();
  if (!prompt || generating) return;

  const n = parseInt(countEl.value, 10);

  setGenerating(true);
  setStatus('Generating…', 'running');
  showTab('current');
  showSkeletons(n);

  const result = await window.api.generateImage({ prompt, n });

  setGenerating(false);

  if (result.error === 'cancelled') {
    setStatus('Cancelled', '');
    restoreBatch();
    return;
  }

  if (result.error) {
    setStatus(`Error: ${result.error}`, 'error');
    restoreBatch();
    return;
  }

  const count = result.images.length;
  setStatus(`Generated ${count} image${count !== 1 ? 's' : ''}`, 'ok');

  lastBatch = { images: result.images, files: result.files || [], sourceKeys: result.sourceKeys || [], prompt };
  showBatch(lastBatch);

  if (galleryLoaded) {
    result.images.forEach((dataUrl, index) => {
      prependGalleryCard({
        src: dataUrl,
        dataUrl,
        filePath: result.files?.[index],
        sourceKey: result.sourceKeys?.[index]
      }, prompt);
    });
  }
  galleryCount += count;
  updateGalleryBadge();
}

function setGenerating(active) {
  generating = active;
  btnGenerate.disabled = active;
  btnCancel.classList.toggle('hidden', !active);
  promptEl.disabled = active;
  countEl.disabled  = active;
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

function imageIdentity(image) {
  const imageRef = normalizeImageRef(image);
  return imageRef.sourceKey || imageRef.filePath || imageRef.src;
}

async function syncAppData() {
  if (syncingData) return;
  syncingData = true;
  btnSync.disabled = true;
  btnSync.classList.add('syncing');
  setStatus('Syncing gallery data...', 'running');

  try {
    await Promise.all([
      syncGalleryData(),
      syncDisplayGalleryData()
    ]);
    setStatus('Gallery data synced', 'ok');
  } catch (err) {
    setStatus(`Sync failed: ${err.message}`, 'error');
  } finally {
    syncingData = false;
    btnSync.disabled = false;
    btnSync.classList.remove('syncing');
  }
}

async function syncGalleryData() {
  if (galleryLoading) await galleryLoading;

  if (!galleryLoaded) {
    const summary = await window.api.loadGallerySummary();
    galleryCount = summary?.count || 0;
    updateGalleryBadge();
    return;
  }

  const [saved, summary] = await Promise.all([
    window.api.loadGalleryPage(0, galleryImages.length + GALLERY_PAGE_SIZE),
    window.api.loadGallerySummary(),
  ]);
  const knownKeys = new Set(galleryImages.map(imageIdentity).filter(Boolean));
  const missing = saved.filter(image => {
    const key = imageIdentity(image);
    return key && !knownKeys.has(key);
  });

  for (const image of missing.reverse()) {
    prependGalleryCard(image, image.prompt);
  }
  galleryCount = Math.max(galleryImages.length, summary?.count || 0);
  updateGalleryBadge();
}

async function syncDisplayGalleryData() {
  if (displayGalleryLoading) await displayGalleryLoading;

  if (!displayGalleryLoaded) {
    const summary = await window.api.loadDisplayGallerySummary();
    const savedKeys = new Set(summary?.sourceKeys || []);
    pendingDisplayGalleryRemovals.forEach(sourceKey => savedKeys.delete(sourceKey));
    displayGalleryKeys = savedKeys;
    displayGalleryCount = savedKeys.size || Math.max(0, (summary?.count || 0) - pendingDisplayGalleryRemovals.size);
    updateDisplayGalleryBadge();
    updateAllFavoriteButtons();
    return;
  }

  const saved = await window.api.loadDisplayGallery();
  const knownKeys = new Set(displayGalleryImages.map(imageIdentity).filter(Boolean));
  const missing = saved.filter(image => {
    const key = imageIdentity(image);
    return key && !knownKeys.has(key);
  });

  for (const image of missing.reverse()) {
    prependDisplayGalleryCard(image, image.prompt);
  }

  displayGalleryKeys = new Set(saved.map(image => image.sourceKey).filter(Boolean));
  pendingDisplayGalleryRemovals.forEach(sourceKey => displayGalleryKeys.delete(sourceKey));
  displayGalleryCount = saved.filter(image => !pendingDisplayGalleryRemovals.has(image.sourceKey)).length;
  updateDisplayGalleryBadge();
  updateDisplayGalleryPendingCards();
  updateAllFavoriteButtons();
}

// ── Cancel ────────────────────────────────────────────────────────────────────
btnCancel.addEventListener('click', async () => {
  setStatus('Cancelling…', 'running');
  await window.api.cancelGeneration();
});

// ── Current display helpers ───────────────────────────────────────────────────
function showSkeletons(n) {
  currentEmpty.style.display   = 'none';
  currentDisplay.className     = `current-display count-${n}`;
  currentDisplay.style.display = 'grid';
  currentDisplay.innerHTML     = '';
  for (let i = 0; i < n; i++) {
    const item = document.createElement('div');
    item.className = 'display-item skeleton-item';
    item.innerHTML = '<div class="skeleton-inner"></div>';
    currentDisplay.append(item);
  }
}

function showBatch(batch) {
  currentEmpty.style.display   = 'none';
  currentDisplay.className     = `current-display count-${batch.images.length}`;
  currentDisplay.style.display = 'grid';
  currentDisplay.innerHTML     = '';
  batch.images.forEach((dataUrl, index) => {
    currentDisplay.append(makeDisplayItem(
      { src: dataUrl, dataUrl, filePath: batch.files?.[index], sourceKey: batch.sourceKeys?.[index] },
      batch.prompt,
      batch.images.map((src, imageIndex) => ({
        src,
        dataUrl: src,
        filePath: batch.files?.[imageIndex],
        sourceKey: batch.sourceKeys?.[imageIndex]
      })),
      batch.files?.[index]
    ));
  });
}

function currentBatchImageRefs() {
  if (activeTab !== 'current' || !lastBatch?.images?.length) return [];
  return lastBatch.images.map((src, index) => normalizeImageRef({
    src,
    dataUrl: src,
    filePath: lastBatch.files?.[index],
    sourceKey: lastBatch.sourceKeys?.[index],
    prompt: lastBatch.prompt
  }));
}

function fillToggleImageRefs() {
  if (lightboxDataUrl && !lightbox.classList.contains('hidden')) return lightboxImages.length ? lightboxImages : [lightboxDataUrl];
  const currentImages = currentBatchImageRefs();
  if (currentImages.length > 0) return currentImages;
  return lightboxDataUrl ? [lightboxDataUrl] : [];
}

function restoreBatch() {
  if (lastBatch) {
    showBatch(lastBatch);
  } else {
    currentDisplay.style.display = 'none';
    currentEmpty.style.display   = 'flex';
  }
}

function normalizeImageRef(image, filePath) {
  if (typeof image === 'string') return { src: image, dataUrl: image, filePath, prompt: '', sourceKey: '' };
  return {
    src: image?.src || image?.dataUrl || '',
    dataUrl: image?.dataUrl,
    filePath: image?.filePath || filePath,
    prompt: typeof image?.prompt === 'string' ? image.prompt : '',
    sourceKey: typeof image?.sourceKey === 'string' ? image.sourceKey : ''
  };
}

function rememberLastDisplayedImage(image) {
  const imageRef = normalizeImageRef(image);
  const dataUrl = imageRef.dataUrl || (imageRef.src?.startsWith('data:') ? imageRef.src : '');
  const stored = {
    filePath: imageRef.filePath || '',
    dataUrl: imageRef.filePath ? '' : dataUrl,
    src: imageRef.filePath ? '' : (dataUrl || imageRef.src || ''),
    prompt: imageRef.prompt || '',
    sourceKey: imageRef.sourceKey || ''
  };
  if (!stored.filePath && !stored.src && !stored.dataUrl) return;
  localStorage.setItem(LAST_DISPLAYED_IMAGE_KEY, JSON.stringify(stored));

  // Save a copy to a fixed temp file so startup can load it via IPC (data URL),
  // independent of gallery state and without needing the asset protocol.
  if (dataUrl) {
    window.api.saveLastViewedTemp({ dataUrl }).catch(() => {});
  }
}

function loadLastDisplayedImage() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(LAST_DISPLAYED_IMAGE_KEY) || 'null');
  } catch {
    return null;
  }
  if (!stored) return null;

  const filePath = typeof stored.filePath === 'string' ? stored.filePath : '';
  const dataUrl = typeof stored.dataUrl === 'string' ? stored.dataUrl : '';
  const storedSrc = typeof stored.src === 'string' ? stored.src : '';
  const src = filePath ? window.api.assetUrl(filePath) : (dataUrl || storedSrc);
  if (!src) return null;

  return normalizeImageRef({
    src,
    dataUrl: dataUrl || undefined,
    filePath,
    prompt: typeof stored.prompt === 'string' ? stored.prompt : '',
    sourceKey: typeof stored.sourceKey === 'string' ? stored.sourceKey : ''
  });
}

function loadLastDisplayedImageMeta() {
  try {
    return JSON.parse(localStorage.getItem(LAST_DISPLAYED_IMAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

async function openLastDisplayedImageOnStartup() {
  // Load the image via IPC as a data URL (avoids asset-protocol and file-path issues).
  // Falls back to the localStorage src (data URL or asset URL) if no temp file exists.
  let dataUrl = null;
  try {
    dataUrl = await window.api.loadLastViewedTemp();
  } catch {}

  const meta = loadLastDisplayedImageMeta();
  const fallbackImage = dataUrl ? null : loadLastDisplayedImage();
  if (!dataUrl && !fallbackImage?.src) return;

  const image = normalizeImageRef({
    src: dataUrl || fallbackImage.src,
    dataUrl: dataUrl || fallbackImage.dataUrl,
    filePath: meta?.filePath || fallbackImage?.filePath || '',
    prompt: typeof meta?.prompt === 'string' ? meta.prompt : (fallbackImage?.prompt || ''),
    sourceKey: typeof meta?.sourceKey === 'string' ? meta.sourceKey : (fallbackImage?.sourceKey || '')
  });

  lightboxImages = [image];
  lightboxIndex = 0;
  lightboxDataUrl = image;
  // Pre-load the image so resetFillViewTransform() has correct naturalWidth/Height on first call.
  const preloader = new Image();
  preloader.onload = () => openFillView(image);
  preloader.src = image.src;
}

function isInDisplayGallery(image) {
  const imageRef = normalizeImageRef(image);
  return !!imageRef.sourceKey && displayGalleryKeys.has(imageRef.sourceKey);
}

function isPendingDisplayGalleryRemoval(image) {
  const imageRef = normalizeImageRef(image);
  return !!imageRef.sourceKey && pendingDisplayGalleryRemovals.has(imageRef.sourceKey);
}

function updateFavoriteButton(btn, image) {
  const imageRef = normalizeImageRef(image);
  const active = isInDisplayGallery(imageRef);
  const pendingRemoval = isPendingDisplayGalleryRemoval(imageRef);
  btn.dataset.sourceKey = imageRef.sourceKey || '';
  btn.classList.toggle('active', active);
  btn.classList.toggle('pending-removal', pendingRemoval);
  btn.setAttribute('aria-pressed', String(active));
  btn.title = pendingRemoval ? 'Keep in display gallery' : active ? 'Remove from display gallery' : 'Save to display gallery';
}

function makeDisplayItem(image, prompt, images, filePath) {
  const imageRef = normalizeImageRef(image, filePath);
  imageRef.prompt = imageRef.prompt || prompt || '';
  const item = document.createElement('div');
  item.className = 'display-item';
  item.draggable = !!imageRef.filePath;
  item.dataset.sourceKey = imageRef.sourceKey || '';

  const img = document.createElement('img');
  img.src = imageRef.src;
  img.alt = prompt || '';
  img.loading = 'lazy';
  img.decoding = 'async';

  const favoriteBtn = document.createElement('button');
  favoriteBtn.className = 'favorite-btn';
  favoriteBtn.type = 'button';
  favoriteBtn.textContent = '★';
  favoriteBtn.setAttribute('aria-label', 'Toggle display gallery');
  updateFavoriteButton(favoriteBtn, imageRef);

  const overlay = document.createElement('div');
  overlay.className = 'display-item-overlay';

  const copyBtn = makeButton('Copy', 'btn-secondary');
  const saveBtn = makeButton('Save', 'btn-secondary');
  overlay.append(favoriteBtn, copyBtn, saveBtn);
  item.append(img, overlay);

  item.addEventListener('click', e => {
    if (!e.target.closest('.btn-secondary') && !e.target.closest('.favorite-btn')) openLightbox(imageRef, images);
  });
  item.addEventListener('dragstart', e => {
    if (!imageRef.filePath || e.target.closest('.btn-secondary') || e.target.closest('.favorite-btn')) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    window.api.startImageDrag({ filePath: imageRef.filePath });
  });
  saveBtn.addEventListener('click', e => { e.stopPropagation(); saveImage(imageRef); });
  copyBtn.addEventListener('click', async e => {
    e.stopPropagation();
    await copyImage(imageRef);
    flash(copyBtn, 'Copied!', 'Copy');
  });
  favoriteBtn.addEventListener('click', async e => {
    e.stopPropagation();
    favoriteBtn.disabled = true;
    try {
      await toggleDisplayGallery(imageRef);
      item.dataset.sourceKey = imageRef.sourceKey || '';
      updateFavoriteButton(favoriteBtn, imageRef);
    } catch (err) {
      setStatus(`Display gallery update failed: ${err.message}`, 'error');
    } finally {
      favoriteBtn.disabled = false;
    }
  });

  return item;
}

// ── Gallery ───────────────────────────────────────────────────────────────────
async function loadGalleryOnce() {
  if (galleryLoaded) return;
  if (galleryLoading) return galleryLoading;

  galleryLoading = (async () => {
    const [saved, summary] = await Promise.all([
      window.api.loadGalleryPage(0, GALLERY_PAGE_SIZE),
      window.api.loadGallerySummary(),
    ]);
    galleryEl.querySelectorAll('.gallery-item').forEach(card => card.remove());
    galleryImages = [];
    for (const image of saved) {
      appendGalleryCard(image, image.prompt);
    }
    galleryCount = Math.max(galleryCount, summary?.count || 0, galleryImages.length);
    galleryLoaded = true;
    updateGalleryBadge();
    setupGalleryObserver();
  })();

  try {
    await galleryLoading;
  } catch (err) {
    setStatus(`Gallery load failed: ${err.message}`, 'error');
  } finally {
    galleryLoading = null;
  }
}

function setupGalleryObserver() {
  if (galleryObserver) galleryObserver.disconnect();
  const sentinel = document.getElementById('gallery-sentinel');
  if (!sentinel) return;
  galleryObserver = new IntersectionObserver(
    entries => { if (entries[0].isIntersecting) loadNextGalleryPage(); },
    { root: viewGallery, rootMargin: '400px' }
  );
  galleryObserver.observe(sentinel);
}

async function loadNextGalleryPage() {
  if (galleryPageLoading || galleryImages.length >= galleryCount) return;
  galleryPageLoading = true;
  try {
    const saved = await window.api.loadGalleryPage(galleryImages.length, GALLERY_PAGE_SIZE);
    for (const image of saved) {
      appendGalleryCard(image, image.prompt);
    }
  } catch (err) {
    setStatus(`Gallery load failed: ${err.message}`, 'error');
  } finally {
    galleryPageLoading = false;
  }
}

async function loadDisplayGalleryOnce() {
  if (displayGalleryLoaded) return;
  if (displayGalleryLoading) return displayGalleryLoading;

  displayGalleryLoading = (async () => {
    const saved = await window.api.loadDisplayGallery();
    displayGalleryEl.querySelectorAll('.gallery-item').forEach(card => card.remove());
    displayGalleryImages = [];
    displayGalleryCount = 0;
    displayGalleryKeys = new Set();
    pendingDisplayGalleryRemovals = new Set();
    for (const image of saved) {
      appendDisplayGalleryCard(image, image.prompt);
      displayGalleryCount++;
    }
    displayGalleryLoaded = true;
    updateDisplayGalleryBadge();
  })();

  try {
    await displayGalleryLoading;
  } catch (err) {
    setStatus(`Display gallery load failed: ${err.message}`, 'error');
  } finally {
    displayGalleryLoading = null;
  }
}

function makeGalleryCard(image, prompt) {
  const item = makeDisplayItem(image, prompt, () => galleryImages);
  item.classList.add('gallery-item');
  item.draggable = false;
  return item;
}

function makeDisplayGalleryCard(image, prompt) {
  const item = makeDisplayItem(image, prompt, () => displayGalleryImages);
  item.classList.add('gallery-item');
  item.draggable = false;
  return item;
}

function resolveGallerySrc(imageRef) {
  if (!imageRef.src && imageRef.filePath) imageRef.src = window.api.assetUrl(imageRef.filePath);
}

function prependGalleryCard(image, prompt) {
  galleryEmpty.classList.add('hidden');
  btnArchive.classList.remove('hidden');
  const imageRef = normalizeImageRef(image);
  imageRef.prompt = imageRef.prompt || prompt || '';
  resolveGallerySrc(imageRef);
  galleryImages.unshift(imageRef);
  galleryEl.insertBefore(makeGalleryCard(imageRef, imageRef.prompt), galleryEl.firstChild);
}

function appendGalleryCard(image, prompt) {
  galleryEmpty.classList.add('hidden');
  btnArchive.classList.remove('hidden');
  const imageRef = normalizeImageRef(image);
  imageRef.prompt = imageRef.prompt || prompt || '';
  resolveGallerySrc(imageRef);
  galleryImages.push(imageRef);
  galleryEl.appendChild(makeGalleryCard(imageRef, imageRef.prompt));
}

function prependDisplayGalleryCard(image, prompt) {
  displayGalleryEmpty.classList.add('hidden');
  btnArchiveDisplay.classList.remove('hidden');
  const imageRef = normalizeImageRef(image);
  imageRef.prompt = imageRef.prompt || prompt || '';
  resolveGallerySrc(imageRef);
  if (imageRef.sourceKey) displayGalleryKeys.add(imageRef.sourceKey);
  displayGalleryImages.unshift(imageRef);
  displayGalleryEl.insertBefore(makeDisplayGalleryCard(imageRef, imageRef.prompt), displayGalleryEl.firstChild);
}

function appendDisplayGalleryCard(image, prompt) {
  displayGalleryEmpty.classList.add('hidden');
  btnArchiveDisplay.classList.remove('hidden');
  const imageRef = normalizeImageRef(image);
  imageRef.prompt = imageRef.prompt || prompt || '';
  resolveGallerySrc(imageRef);
  if (imageRef.sourceKey) displayGalleryKeys.add(imageRef.sourceKey);
  displayGalleryImages.push(imageRef);
  displayGalleryEl.appendChild(makeDisplayGalleryCard(imageRef, imageRef.prompt));
}

function updateGalleryBadge() {
  if (galleryCount > 0) {
    galleryBadge.textContent = galleryCount;
    galleryBadge.classList.remove('hidden');
  } else {
    galleryBadge.classList.add('hidden');
  }
}

function updateDisplayGalleryBadge() {
  if (displayGalleryCount > 0) {
    displayGalleryBadge.textContent = displayGalleryCount;
    displayGalleryBadge.classList.remove('hidden');
  } else {
    displayGalleryBadge.classList.add('hidden');
  }
}

btnArchive.addEventListener('click', async () => {
  if (galleryCount === 0) return;
  btnArchive.disabled = true;
  try {
    const confirmed = await confirmArchive(galleryCount, 'gallery', btnArchive);
    if (!confirmed) return;

    const result = await window.api.archiveGallery();
    galleryEl.querySelectorAll('.gallery-item').forEach(c => c.remove());
    galleryEmpty.classList.remove('hidden');
    btnArchive.classList.add('hidden');
    galleryCount = 0;
    galleryImages = [];
    galleryLoaded = true;
    galleryPageLoading = false;
    if (galleryObserver) { galleryObserver.disconnect(); galleryObserver = null; }
    updateGalleryBadge();
    if (result?.archived) {
      setStatus(`Archived ${result.count} image${result.count !== 1 ? 's' : ''}`, 'ok');
    }
  } catch (err) {
    setStatus(`Archive failed: ${err.message}`, 'error');
  } finally {
    btnArchive.disabled = false;
  }
});

btnArchiveDisplay.addEventListener('click', async () => {
  if (displayGalleryCount === 0) return;
  btnArchiveDisplay.disabled = true;
  try {
    const confirmed = await confirmArchive(displayGalleryCount, 'display gallery', btnArchiveDisplay);
    if (!confirmed) return;

    const result = await window.api.archiveDisplayGallery();
    displayGalleryEl.querySelectorAll('.gallery-item').forEach(c => c.remove());
    displayGalleryEmpty.classList.remove('hidden');
    btnArchiveDisplay.classList.add('hidden');
    displayGalleryCount = 0;
    displayGalleryImages = [];
    displayGalleryKeys = new Set();
    pendingDisplayGalleryRemovals = new Set();
    displayGalleryLoaded = true;
    updateDisplayGalleryBadge();
    if (result?.archived) {
      setStatus(`Archived ${result.count} display image${result.count !== 1 ? 's' : ''}`, 'ok');
    }
  } catch (err) {
    setStatus(`Display archive failed: ${err.message}`, 'error');
  } finally {
    btnArchiveDisplay.disabled = false;
  }
});

function confirmArchive(count, galleryName = 'gallery', focusTarget = btnArchive) {
  const imageText = `${count} image${count === 1 ? '' : 's'}`;
  archiveCopy.textContent = `Move ${imageText} into a timestamped archive folder and clear the ${galleryName} view.`;
  archiveConfirm.classList.remove('hidden');
  archiveConfirmBtn.focus();

  return new Promise(resolve => {
    const finish = confirmed => {
      archiveConfirm.classList.add('hidden');
      archiveCancel.removeEventListener('click', cancel);
      archiveConfirmBtn.removeEventListener('click', accept);
      archiveConfirm.removeEventListener('click', backdropCancel);
      document.removeEventListener('keydown', keyCancel);
      focusTarget.focus();
      resolve(confirmed);
    };
    const cancel = () => finish(false);
    const accept = () => finish(true);
    const backdropCancel = e => {
      if (e.target === archiveConfirm) finish(false);
    };
    const keyCancel = e => {
      if (e.key === 'Escape') finish(false);
    };

    archiveCancel.addEventListener('click', cancel);
    archiveConfirmBtn.addEventListener('click', accept);
    archiveConfirm.addEventListener('click', backdropCancel);
    document.addEventListener('keydown', keyCancel);
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function makeButton(text, cls) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = text;
  return btn;
}

function flash(btn, temp, original, ms = 1500) {
  btn.textContent = temp;
  setTimeout(() => { btn.textContent = original; }, ms);
}

async function saveImage(image) {
  const imageRef = normalizeImageRef(image);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await window.api.saveImage({
    dataUrl: imageRef.dataUrl,
    filePath: imageRef.filePath,
    defaultName: `grok-imagine-${ts}.png`
  });
}

async function copyImage(image) {
  const imageRef = normalizeImageRef(image);
  await window.api.copyImage({ dataUrl: imageRef.dataUrl, filePath: imageRef.filePath });
}

async function saveToDisplayGallery(image) {
  const imageRef = normalizeImageRef(image);
  const result = await window.api.saveToDisplayGallery({
    dataUrl: imageRef.dataUrl,
    filePath: imageRef.filePath,
    prompt: imageRef.prompt,
    sourceKey: imageRef.sourceKey
  });
  const savedImage = result?.image;
  if (!savedImage) return;
  imageRef.sourceKey = imageRef.sourceKey || savedImage.sourceKey;
  if (image && typeof image === 'object' && !image.sourceKey) image.sourceKey = savedImage.sourceKey;
  if (savedImage.sourceKey) displayGalleryKeys.add(savedImage.sourceKey);
  if (savedImage.sourceKey) pendingDisplayGalleryRemovals.delete(savedImage.sourceKey);

  if (savedImage.saved !== false) displayGalleryCount++;
  updateDisplayGalleryBadge();
  if (displayGalleryLoaded && savedImage.saved !== false) {
    prependDisplayGalleryCard(savedImage, savedImage.prompt);
  }
  updateAllFavoriteButtons();
  return savedImage;
}

async function removeFromDisplayGallery(image) {
  const imageRef = normalizeImageRef(image);
  if (activeTab === 'display-gallery') {
    return stageDisplayGalleryRemoval(imageRef);
  }

  const result = await window.api.removeFromDisplayGallery({
    filePath: imageRef.filePath,
    sourceKey: imageRef.sourceKey
  });
  if (!result?.removed) return result;

  if (imageRef.sourceKey) displayGalleryKeys.delete(imageRef.sourceKey);
  displayGalleryCount = Math.max(0, displayGalleryCount - (result.count || 1));
  displayGalleryImages = displayGalleryImages.filter(entry => entry.sourceKey !== imageRef.sourceKey);
  if (displayGalleryLoaded) {
    displayGalleryEl.querySelectorAll('.gallery-item').forEach(card => {
      if (card.dataset.sourceKey === imageRef.sourceKey) card.remove();
    });
    if (displayGalleryImages.length === 0) {
      displayGalleryEmpty.classList.remove('hidden');
      btnArchiveDisplay.classList.add('hidden');
    }
  }
  updateDisplayGalleryBadge();
  updateAllFavoriteButtons();
  return result;
}

function stageDisplayGalleryRemoval(image) {
  const imageRef = normalizeImageRef(image);
  if (!imageRef.sourceKey || pendingDisplayGalleryRemovals.has(imageRef.sourceKey)) {
    return { removed: false, count: 0, sourceKey: imageRef.sourceKey };
  }

  pendingDisplayGalleryRemovals.add(imageRef.sourceKey);
  displayGalleryKeys.delete(imageRef.sourceKey);
  displayGalleryCount = Math.max(0, displayGalleryCount - 1);
  updateDisplayGalleryBadge();
  updateDisplayGalleryPendingCards();
  updateAllFavoriteButtons();
  return { removed: true, staged: true, count: 1, sourceKey: imageRef.sourceKey };
}

function cancelDisplayGalleryRemoval(image) {
  const imageRef = normalizeImageRef(image);
  if (!imageRef.sourceKey || !pendingDisplayGalleryRemovals.has(imageRef.sourceKey)) {
    return { saved: false, count: 0, sourceKey: imageRef.sourceKey };
  }

  pendingDisplayGalleryRemovals.delete(imageRef.sourceKey);
  displayGalleryKeys.add(imageRef.sourceKey);
  displayGalleryCount++;
  updateDisplayGalleryBadge();
  updateDisplayGalleryPendingCards();
  updateAllFavoriteButtons();
  return { saved: true, unstaged: true, count: 1, sourceKey: imageRef.sourceKey };
}

async function toggleDisplayGallery(image) {
  if (isPendingDisplayGalleryRemoval(image)) return cancelDisplayGalleryRemoval(image);
  if (isInDisplayGallery(image)) return removeFromDisplayGallery(image);
  return saveToDisplayGallery(image);
}

function updateAllFavoriteButtons() {
  document.querySelectorAll('.favorite-btn').forEach(btn => {
    updateFavoriteButton(btn, { sourceKey: btn.dataset.sourceKey || '' });
  });
}

function updateDisplayGalleryPendingCards() {
  displayGalleryEl.querySelectorAll('.gallery-item').forEach(card => {
    card.classList.toggle('pending-removal', pendingDisplayGalleryRemovals.has(card.dataset.sourceKey));
  });
}

async function commitPendingDisplayGalleryRemovals() {
  const sourceKeys = Array.from(pendingDisplayGalleryRemovals);
  if (sourceKeys.length === 0) return;

  pendingDisplayGalleryRemovals = new Set();
  const failed = [];
  for (const sourceKey of sourceKeys) {
    try {
      const result = await window.api.removeFromDisplayGallery({ sourceKey });
      if (!result?.removed) failed.push(sourceKey);
    } catch {
      failed.push(sourceKey);
    }
  }

  const failedKeys = new Set(failed);
  displayGalleryImages = displayGalleryImages.filter(entry => {
    if (!sourceKeys.includes(entry.sourceKey)) return true;
    return failedKeys.has(entry.sourceKey);
  });
  displayGalleryEl.querySelectorAll('.gallery-item').forEach(card => {
    const sourceKey = card.dataset.sourceKey;
    if (sourceKeys.includes(sourceKey) && !failedKeys.has(sourceKey)) card.remove();
  });
  if (displayGalleryLoaded && displayGalleryImages.length === 0) {
    displayGalleryEmpty.classList.remove('hidden');
    btnArchiveDisplay.classList.add('hidden');
  }

  if (failed.length > 0) {
    failed.forEach(sourceKey => displayGalleryKeys.add(sourceKey));
    displayGalleryCount += failed.length;
    setStatus('Some display gallery removals could not be saved.', 'error');
  }
  updateDisplayGalleryBadge();
  updateDisplayGalleryPendingCards();
  updateAllFavoriteButtons();
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(image, images = [image]) {
  const imageRef = normalizeImageRef(image);
  const imageSource = typeof images === 'function' ? images() : images;
  lightboxImages = imageSource && imageSource.length ? imageSource.map(imageEntry => normalizeImageRef(imageEntry)) : [imageRef];
  lightboxIndex = lightboxImages.findIndex(entry =>
    entry.src === imageRef.src && entry.filePath === imageRef.filePath
  );
  if (lightboxIndex < 0) lightboxIndex = 0;
  lightboxDataUrl = imageRef;
  lightboxImg.src = imageRef.src;
  rememberLastDisplayedImage(imageRef);
  document.body.classList.add('lightbox-open');
  lightbox.classList.remove('hidden');
  updateLightboxNav();
  requestAnimationFrame(updateLightboxNavPosition);
}

function closeLightbox() {
  closeFillView();
  lightbox.classList.add('hidden');
  lightboxImg.src = '';
  lightboxDataUrl = null;
  lightboxImages = [];
  lightboxIndex = -1;
  updateLightboxNav();
  document.body.classList.remove('lightbox-open');
}

function stepLightbox(direction) {
  if (lightbox.classList.contains('hidden') || lightboxImages.length < 2) return;

  lightboxIndex = (lightboxIndex + direction + lightboxImages.length) % lightboxImages.length;
  lightboxDataUrl = lightboxImages[lightboxIndex];
  lightboxImg.src = lightboxDataUrl.src;
  rememberLastDisplayedImage(lightboxDataUrl);
  lightboxImg.addEventListener('load', updateLightboxNavPosition, { once: true });
  if (!fillView.classList.contains('hidden')) {
    fillImg.src = lightboxDataUrl.src;
    resetFillViewTransform();
  }
}

function updateLightboxNav() {
  const canNavigate = lightboxImages.length > 1;
  lightboxPrev.classList.toggle('hidden', !canNavigate);
  lightboxNext.classList.toggle('hidden', !canNavigate);
  updateLightboxNavPosition();
}

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
lightboxImg.addEventListener('load', updateLightboxNavPosition);
window.addEventListener('resize', updateLightboxNavPosition);
window.addEventListener('resize', () => {
  if (!fillView.classList.contains('hidden')) applyFillViewTransform();
});

function updateLightboxNavPosition() {
  if (lightbox.classList.contains('hidden') || lightboxImages.length < 2) return;

  const imageRect = lightboxImg.getBoundingClientRect();
  const minNavWidth = document.body.classList.contains('viewer-mode') ? 0 : 44;
  const leftSpace = Math.max(minNavWidth, imageRect.left);
  const rightSpace = Math.max(minNavWidth, window.innerWidth - imageRect.right);

  lightboxPrev.style.left = '0';
  lightboxPrev.style.width = `${leftSpace}px`;
  lightboxNext.style.right = '0';
  lightboxNext.style.width = `${rightSpace}px`;
}

function getFillScales() {
  const naturalWidth = fillImg.naturalWidth || window.innerWidth;
  const naturalHeight = fillImg.naturalHeight || window.innerHeight;
  const coverScale = Math.max(
    (window.innerWidth + FILL_VIEW_OVERSCAN_PX) / naturalWidth,
    (window.innerHeight + FILL_VIEW_OVERSCAN_PX) / naturalHeight
  );
  const containScale = Math.min(window.innerWidth / naturalWidth, window.innerHeight / naturalHeight);
  return {
    coverScale,
    minZoom: Math.min(1, containScale / coverScale)
  };
}

function clampFillPan() {
  const naturalWidth = fillImg.naturalWidth || window.innerWidth;
  const naturalHeight = fillImg.naturalHeight || window.innerHeight;
  const { coverScale, minZoom } = getFillScales();
  fillTransform.zoom = Math.max(minZoom, Math.min(8, fillTransform.zoom));
  const displayWidth = naturalWidth * coverScale * fillTransform.zoom;
  const displayHeight = naturalHeight * coverScale * fillTransform.zoom;
  const maxX = Math.max(0, (displayWidth - window.innerWidth) / 2);
  const maxY = Math.max(0, (displayHeight - window.innerHeight) / 2);
  fillTransform.panX = Math.max(-maxX, Math.min(maxX, fillTransform.panX));
  fillTransform.panY = Math.max(-maxY, Math.min(maxY, fillTransform.panY));
  return coverScale;
}

function applyFillViewTransform(animate = false) {
  const coverScale = clampFillPan();
  if (animate) {
    fillImg.style.transition = 'transform 0.3s ease-out';
    fillImg.addEventListener('transitionend', () => {
      fillImg.style.transition = '';
    }, { once: true });
  } else {
    fillImg.style.transition = '';
  }
  fillImg.style.setProperty('--scale', (coverScale * fillTransform.zoom).toFixed(4));
  fillImg.style.setProperty('--pan-x', `${fillTransform.panX.toFixed(1)}px`);
  fillImg.style.setProperty('--pan-y', `${fillTransform.panY.toFixed(1)}px`);
}

function resetFillViewTransform(animate = false) {
  fillTransform.zoom = 1;
  fillTransform.panX = 0;
  fillTransform.panY = 0;
  applyFillViewTransform(animate);
}

function zoomFillViewAt(clientX, clientY, deltaY, mode = 'normal') {
  const oldZoom = fillTransform.zoom;
  const { minZoom } = getFillScales();
  const zoomStep = mode === 'fine' ? 0.0001875 : mode === 'quick' ? 0.003 : 0.00075;
  const nextZoom = Math.max(minZoom, Math.min(8, oldZoom * Math.exp(-deltaY * zoomStep)));
  if (Math.abs(nextZoom - oldZoom) < 0.0001) return;

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const imageX = (clientX - centerX - fillTransform.panX) / oldZoom;
  const imageY = (clientY - centerY - fillTransform.panY) / oldZoom;

  fillTransform.zoom = nextZoom;
  fillTransform.panX = clientX - centerX - imageX * nextZoom;
  fillTransform.panY = clientY - centerY - imageY * nextZoom;
  applyFillViewTransform();
}

function openFillView(image = lightboxDataUrl) {
  const imageRef = normalizeImageRef(image);
  if (!imageRef.src) return;
  fillViewAutoHidUi = !viewerMode;
  setViewerMode(true);
  lightboxDataUrl = imageRef;
  rememberLastDisplayedImage(imageRef);
  fillImg.src = imageRef.src;
  resetFillViewTransform();
  fillView.classList.remove('hidden');
  document.body.classList.add('fill-view-open');
}

function closeFillView() {
  if (fillView.classList.contains('hidden')) return;
  fillView.classList.add('hidden');
  fillView.classList.remove('is-dragging');
  fillTransform.dragging = false;
  fillImg.src = '';
  resetFillViewTransform();
  document.body.classList.remove('fill-view-open');
}

function closeFillViewAndRestoreUi() {
  closeFillView();
  if (fillViewAutoHidUi) setViewerMode(false);
  fillViewAutoHidUi = false;
}

function toggleFillView() {
  if (!fillView.classList.contains('hidden')) {
    closeFillViewAndRestoreUi();
    return;
  }

  const images = fillToggleImageRefs();
  if (images.length === 0) return;
  if (lightbox.classList.contains('hidden')) {
    lightboxImages = images;
    lightboxIndex = 0;
    lightboxDataUrl = images[0];
  }
  openFillView(lightboxDataUrl);
}

lightboxDisplaySave.addEventListener('click', async () => {
  if (!lightboxDataUrl) return;
  await saveToDisplayGallery(lightboxDataUrl);
  flash(lightboxDisplaySave, 'Saved!', 'Save to display gallery');
});
lightboxSave.addEventListener('click', () => { if (lightboxDataUrl) saveImage(lightboxDataUrl); });
lightboxCopy.addEventListener('click', async () => {
  if (!lightboxDataUrl) return;
  await copyImage(lightboxDataUrl);
  flash(lightboxCopy, 'Copied!', 'Copy to clipboard');
});
lightboxFill.addEventListener('click', () => openFillView());
lightboxImg.addEventListener('dblclick', e => {
  e.stopPropagation();
  toggleFillView();
});
fillImg.addEventListener('dblclick', e => {
  e.stopPropagation();
  toggleFillView();
});
fillImg.addEventListener('load', () => {
  if (!fillView.classList.contains('hidden')) resetFillViewTransform();
});
fillView.addEventListener('dblclick', e => {
  if (e.target === fillClose) return;
  e.stopPropagation();
  toggleFillView();
});
fillView.addEventListener('wheel', e => {
  if (fillView.classList.contains('hidden')) return;
  e.preventDefault();
  const zoomMode = e.ctrlKey ? 'fine' : e.shiftKey ? 'quick' : 'normal';
  zoomFillViewAt(e.clientX, e.clientY, e.deltaY, zoomMode);
}, { passive: false });
fillView.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target === fillClose) return;
  e.preventDefault();
  fillTransform.dragging = true;
  fillTransform.dragStartX = e.clientX;
  fillTransform.dragStartY = e.clientY;
  fillTransform.startPanX = fillTransform.panX;
  fillTransform.startPanY = fillTransform.panY;
  fillView.classList.add('is-dragging');
  fillView.setPointerCapture(e.pointerId);
});
fillView.addEventListener('pointermove', e => {
  if (!fillTransform.dragging) return;
  fillTransform.panX = fillTransform.startPanX + e.clientX - fillTransform.dragStartX;
  fillTransform.panY = fillTransform.startPanY + e.clientY - fillTransform.dragStartY;
  applyFillViewTransform();
});
fillView.addEventListener('pointerup', e => {
  if (!fillTransform.dragging) return;
  fillTransform.dragging = false;
  fillView.classList.remove('is-dragging');
  if (fillView.hasPointerCapture(e.pointerId)) fillView.releasePointerCapture(e.pointerId);
});
fillView.addEventListener('pointercancel', e => {
  fillTransform.dragging = false;
  fillView.classList.remove('is-dragging');
  if (fillView.hasPointerCapture(e.pointerId)) fillView.releasePointerCapture(e.pointerId);
});
lightboxPrev.addEventListener('click', e => {
  e.stopPropagation();
  stepLightbox(-1);
});
lightboxNext.addEventListener('click', e => {
  e.stopPropagation();
  stepLightbox(1);
});
fillClose.addEventListener('click', closeFillView);

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const target = e.target;
  const isTextEntry = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'q' && (viewerMode || !isTextEntry)) {
    e.preventDefault();
    toggleViewerMode();
    return;
  }

  if (e.key === 'Escape' && viewerMode && (!persistentHideUi || !fillView.classList.contains('hidden'))) {
    e.preventDefault();
    closeFillView();
    setViewerMode(false);
    fillViewAutoHidUi = false;
    return;
  }

  const fillTogglePressed =
    ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '1') ||
    (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (e.key === '§' || e.key.toLowerCase() === 'z') && (viewerMode || !isTextEntry));
  if (fillTogglePressed) {
    const hasFillTarget = fillToggleImageRefs().length > 0 || !fillView.classList.contains('hidden');
    if (hasFillTarget) {
      e.preventDefault();
      toggleFillView();
    }
    return;
  }

  if (e.key === 'Escape' && !fillView.classList.contains('hidden')) {
    e.preventDefault();
    closeFillView();
    return;
  }

  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && !fillView.classList.contains('hidden')) {
    e.preventDefault();
    resetFillViewTransform(true);
    return;
  }

  if (!lightbox.classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepLightbox(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepLightbox(1);
      return;
    }
  }

  if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) closeLightbox();
});

// ── Start ─────────────────────────────────────────────────────────────────────
init();
