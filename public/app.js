/**
 * ClearCut Cloud — Frontend Application Controller
 * ---------------------------------------------------------------------------
 * 1. Performs full-resolution client-side AI background removal using
 *    `@imgly/background-removal` (ONNX/WASM in browser).
 * 2. Provides interactive Before vs. After split-slider & side-by-side preview
 *    with checkerboard transparency and customizable solid backdrop colors.
 * 3. Sends processed high-res PNG to Express `/api/process-metadata` for
 *    Sharp validation, Object Storage upload (GCS / ephemeral fallback),
 *    and zero-BLOB SQL metadata logging (`attachments_metadata`).
 */

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_CLIENT_BYTES = 30 * 1024 * 1024;

// Lazy-loaded @imgly/background-removal reference
let removeBackgroundFn = null;

// App state
const state = {
  originalFile: null,
  originalObjectUrl: null,
  originalWidth: 0,
  originalHeight: 0,
  processedBlob: null,
  processedObjectUrl: null,
  processedFileName: '',
  viewMode: 'split', // 'split' | 'side'
  backdrop: 'checkerboard',
  isProcessing: false,
};

// DOM References
const dom = {
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  loadSampleBtn: document.getElementById('loadSampleBtn'),
  modelSelect: document.getElementById('modelSelect'),
  processBtn: document.getElementById('processBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  progressContainer: document.getElementById('progressContainer'),
  progressLabel: document.getElementById('progressLabel'),
  progressPercent: document.getElementById('progressPercent'),
  progressBar: document.getElementById('progressBar'),
  statusAlert: document.getElementById('statusAlert'),
  fileSpecsCard: document.getElementById('fileSpecsCard'),
  specFileName: document.getElementById('specFileName'),
  specOrigRes: document.getElementById('specOrigRes'),
  specOutRes: document.getElementById('specOutRes'),
  specOutSize: document.getElementById('specOutSize'),
  specAlpha: document.getElementById('specAlpha'),
  resolutionVerifiedPill: document.getElementById('resolutionVerifiedPill'),

  previewEmptyState: document.getElementById('previewEmptyState'),
  splitPreviewWrapper: document.getElementById('splitPreviewWrapper'),
  sidePreviewWrapper: document.getElementById('sidePreviewWrapper'),
  splitStage: document.getElementById('splitStage'),
  beforeImageSplit: document.getElementById('beforeImageSplit'),
  afterImageSplit: document.getElementById('afterImageSplit'),
  beforeClipLayer: document.getElementById('beforeClipLayer'),
  splitDivider: document.getElementById('splitDivider'),
  splitSliderInput: document.getElementById('splitSliderInput'),
  modeSplitBtn: document.getElementById('modeSplitBtn'),
  modeSideBtn: document.getElementById('modeSideBtn'),
  beforeImageSide: document.getElementById('beforeImageSide'),
  afterImageSide: document.getElementById('afterImageSide'),
  sideAfterBackdrop: document.getElementById('sideAfterBackdrop'),
  sideBeforeMeta: document.getElementById('sideBeforeMeta'),
  sideAfterMeta: document.getElementById('sideAfterMeta'),

  backdropButtons: Array.from(document.querySelectorAll('.backdrop-btn')),
  customColorPicker: document.getElementById('customColorPicker'),
  activeBackdropLabel: document.getElementById('activeBackdropLabel'),

  kpiBlobCount: document.getElementById('kpiBlobCount'),
  kpiTotalFiles: document.getElementById('kpiTotalFiles'),
  kpiObjectBytes: document.getElementById('kpiObjectBytes'),
  kpiStorageDriver: document.getElementById('kpiStorageDriver'),
  kpiStorageDetail: document.getElementById('kpiStorageDetail'),
  metadataTableBody: document.getElementById('metadataTableBody'),
  refreshLogBtn: document.getElementById('refreshLogBtn'),
};

function renderIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showAlert(type, message) {
  dom.statusAlert.classList.remove(
    'hidden',
    'bg-rose-950/60',
    'border-rose-500/40',
    'text-rose-200',
    'bg-emerald-950/60',
    'border-emerald-500/40',
    'text-emerald-200',
    'bg-amber-950/60',
    'border-amber-500/40',
    'text-amber-200'
  );

  if (type === 'error') {
    dom.statusAlert.classList.add('bg-rose-950/60', 'border-rose-500/40', 'text-rose-200');
  } else if (type === 'warn') {
    dom.statusAlert.classList.add('bg-amber-950/60', 'border-amber-500/40', 'text-amber-200');
  } else {
    dom.statusAlert.classList.add('bg-emerald-950/60', 'border-emerald-500/40', 'text-emerald-200');
  }
  dom.statusAlert.textContent = message;
}

function clearAlert() {
  dom.statusAlert.classList.add('hidden');
  dom.statusAlert.textContent = '';
}

function setProgress(percent, label) {
  dom.progressContainer.classList.remove('hidden');
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  dom.progressPercent.textContent = `${clamped}%`;
  dom.progressBar.style.width = `${clamped}%`;
  dom.progressLabel.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>${escapeHtml(label)}</span>`;
  renderIcons();
}

function hideProgress() {
  dom.progressContainer.classList.add('hidden');
}

function readImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not decode image dimensions.'));
    img.src = url;
  });
}

async function loadBackgroundRemovalEngine() {
  if (removeBackgroundFn) return removeBackgroundFn;

  const cdnCandidates = [
    'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
    'https://esm.sh/@imgly/background-removal@1.7.0',
  ];

  let lastError = null;
  for (const url of cdnCandidates) {
    try {
      const mod = await import(url);
      if (typeof mod.removeBackground === 'function') {
        removeBackgroundFn = mod.removeBackground;
        return removeBackgroundFn;
      }
      if (mod.default && typeof mod.default === 'function') {
        removeBackgroundFn = mod.default;
        return removeBackgroundFn;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[ClearCut] Failed to load AI engine from ${url}:`, err);
    }
  }
  throw new Error(
    `Unable to load @imgly/background-removal engine in browser (${lastError ? lastError.message : 'network error'}).`
  );
}

/**
 * Guarantees the transparent PNG matches original high-resolution dimensions
 * without upscaling/downscaling loss if an engine build returns a slightly
 * rounded canvas size.
 */
async function ensureExactResolutionPng(blob, targetWidth, targetHeight) {
  const tempUrl = URL.createObjectURL(blob);
  try {
    const dims = await readImageDimensions(tempUrl);
    if (dims.width === targetWidth && dims.height === targetHeight) {
      return { blob, width: dims.width, height: dims.height };
    }

    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const resizedBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Failed to encode high-resolution PNG.'))),
        'image/png',
        1
      );
    });
    return { blob: resizedBlob, width: targetWidth, height: targetHeight };
  } finally {
    URL.revokeObjectURL(tempUrl);
  }
}

function buildOutputFileName(originalName) {
  const base = String(originalName || 'image').replace(/\.[^.]+$/, '');
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 72) || 'image';
  return `${sanitized}-clearcut.png`;
}

function applyBackdrop(value) {
  state.backdrop = value;

  dom.backdropButtons.forEach((btn) => {
    const active = btn.dataset.backdrop === value;
    btn.classList.toggle('ring-2', active);
    btn.classList.toggle('ring-emerald-400', active);
  });

  const targets = [dom.splitStage, dom.sideAfterBackdrop];
  if (value === 'checkerboard') {
    targets.forEach((el) => {
      el.classList.add('checkerboard');
      el.style.backgroundColor = '';
    });
    dom.activeBackdropLabel.textContent = 'Transparent PNG';
  } else {
    targets.forEach((el) => {
      el.classList.remove('checkerboard');
      el.style.backgroundColor = value;
    });
    dom.activeBackdropLabel.textContent = `Solid Backdrop (${value.toUpperCase()})`;
  }
}

function updateViewMode(mode) {
  state.viewMode = mode;

  if (mode === 'split') {
    dom.modeSplitBtn.className =
      'px-3 py-1.5 rounded-lg font-semibold bg-emerald-500 text-slate-950 transition cursor-pointer';
    dom.modeSideBtn.className =
      'px-3 py-1.5 rounded-lg font-medium text-slate-300 hover:text-white transition cursor-pointer';
  } else {
    dom.modeSideBtn.className =
      'px-3 py-1.5 rounded-lg font-semibold bg-emerald-500 text-slate-950 transition cursor-pointer';
    dom.modeSplitBtn.className =
      'px-3 py-1.5 rounded-lg font-medium text-slate-300 hover:text-white transition cursor-pointer';
  }

  if (!state.originalObjectUrl) return;
  dom.previewEmptyState.classList.add('hidden');
  dom.splitPreviewWrapper.classList.toggle('hidden', mode !== 'split');
  dom.sidePreviewWrapper.classList.toggle('hidden', mode !== 'side');
}

function updateSplitPosition(percent) {
  const p = Math.max(0, Math.min(100, Number(percent)));
  dom.beforeClipLayer.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
  dom.splitDivider.style.left = `${p}%`;
}

async function handleFileSelection(file) {
  clearAlert();
  if (!file) return;

  if (!ALLOWED_MIMES.has(file.type)) {
    showAlert('error', 'Unsupported file type. Please choose a JPG, PNG, or WEBP image.');
    return;
  }

  if (file.size > MAX_CLIENT_BYTES) {
    showAlert('error', 'File exceeds the 30 MB limit. Please upload a smaller image.');
    return;
  }

  if (state.originalObjectUrl) URL.revokeObjectURL(state.originalObjectUrl);
  if (state.processedObjectUrl) URL.revokeObjectURL(state.processedObjectUrl);

  const objectUrl = URL.createObjectURL(file);
  try {
    const dims = await readImageDimensions(objectUrl);

    state.originalFile = file;
    state.originalObjectUrl = objectUrl;
    state.originalWidth = dims.width;
    state.originalHeight = dims.height;
    state.processedBlob = null;
    state.processedObjectUrl = null;
    state.processedFileName = buildOutputFileName(file.name);

    // Show original preview immediately (before processing)
    dom.beforeImageSplit.src = objectUrl;
    dom.afterImageSplit.src = objectUrl;
    dom.beforeImageSide.src = objectUrl;
    dom.afterImageSide.src = objectUrl;

    dom.sideBeforeMeta.textContent = `${dims.width}×${dims.height} • ${formatBytes(file.size)}`;
    dom.sideAfterMeta.textContent = 'Awaiting AI cutout...';

    dom.fileSpecsCard.classList.remove('hidden');
    dom.specFileName.textContent = file.name;
    dom.specOrigRes.textContent = `${dims.width} × ${dims.height} px`;
    dom.specOutRes.textContent = 'Ready to process';
    dom.specOutSize.textContent = '—';
    dom.specAlpha.textContent = '—';
    dom.resolutionVerifiedPill.classList.add('hidden');

    dom.processBtn.disabled = false;
    dom.downloadBtn.disabled = true;

    updateViewMode(state.viewMode);
    updateSplitPosition(50);
    dom.splitSliderInput.value = '50';

    showAlert(
      'success',
      `Loaded "${file.name}" (${dims.width}×${dims.height} px, ${formatBytes(file.size)}). Click "Remove Background (Full-Res)" to process.`
    );
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    showAlert('error', err.message || 'Unable to read the selected image.');
  }
}

async function runBackgroundRemovalPipeline() {
  if (!state.originalFile || state.isProcessing) return;

  state.isProcessing = true;
  dom.processBtn.disabled = true;
  dom.downloadBtn.disabled = true;
  clearAlert();

  try {
    setProgress(8, 'Loading @imgly/background-removal AI engine...');
    const removeBackground = await loadBackgroundRemovalEngine();

    const selectedModel = dom.modelSelect.value || 'isnet_fp16';
    setProgress(15, `Preparing ${selectedModel} neural model...`);

    const rawPngBlob = await removeBackground(state.originalFile, {
      model: selectedModel,
      output: {
        format: 'image/png',
        quality: 1,
      },
      progress: (key, current, total) => {
        if (!total || total <= 0) return;
        const ratio = Math.min(1, current / total);
        if (String(key).includes('fetch')) {
          setProgress(15 + ratio * 45, `Downloading AI model assets (${Math.round(ratio * 100)}%)...`);
        } else if (String(key).includes('compute')) {
          setProgress(60 + ratio * 22, `Removing background at full resolution (${Math.round(ratio * 100)}%)...`);
        }
      },
    });

    setProgress(85, 'Verifying original high-resolution pixel dimensions...');
    const exactResult = await ensureExactResolutionPng(
      rawPngBlob,
      state.originalWidth,
      state.originalHeight
    );

    state.processedBlob = exactResult.blob;
    if (state.processedObjectUrl) URL.revokeObjectURL(state.processedObjectUrl);
    state.processedObjectUrl = URL.createObjectURL(exactResult.blob);

    // Update Before vs. After preview immediately
    dom.afterImageSplit.src = state.processedObjectUrl;
    dom.afterImageSide.src = state.processedObjectUrl;
    dom.sideAfterMeta.textContent = `${exactResult.width}×${exactResult.height} • ${formatBytes(exactResult.blob.size)}`;
    dom.specOutRes.textContent = `${exactResult.width} × ${exactResult.height} px`;
    dom.specOutSize.textContent = formatBytes(exactResult.blob.size);
    dom.downloadBtn.disabled = false;

    dom.resolutionVerifiedPill.textContent = `Full-Res Preserved (${exactResult.width}×${exactResult.height})`;
    dom.resolutionVerifiedPill.classList.remove('hidden');

    // Send processed PNG to Express + Sharp backend for validation, Object Storage upload, and SQL metadata logging
    setProgress(92, 'Validating via Sharp & logging metadata to SQL (0 BLOBs)...');
    const formData = new FormData();
    const processedFile = new File([exactResult.blob], state.processedFileName, {
      type: 'image/png',
    });
    formData.append('image', processedFile);
    formData.append('fileName', state.processedFileName);

    const response = await fetch('/api/process-metadata', {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `Backend metadata validation failed (HTTP ${response.status}).`);
    }

    dom.specAlpha.textContent = payload.validation.hasAlpha ? 'RGBA Transparent ✓' : 'RGB';
    setProgress(100, 'Complete! Object stored & SQL metadata logged.');

    const storageBadgeText =
      payload.storage.mode === 'gcs'
        ? `Google Cloud Storage (${payload.storage.bucket})`
        : 'Ephemeral Object Store Fallback';

    showAlert(
      'success',
      `High-resolution background removed (${payload.validation.resolution} px, ${formatBytes(payload.validation.fileSize)}). Stored in ${storageBadgeText} and logged as SQL Row #${payload.metadata.id} (0 BLOBs).`
    );

    await refreshMetadataLog();
    setTimeout(hideProgress, 1200);
  } catch (err) {
    console.error('[ClearCut Pipeline Error]', err);
    hideProgress();
    showAlert('error', err.message || 'Background removal failed. Please try again with another image.');
  } finally {
    state.isProcessing = false;
    dom.processBtn.disabled = !state.originalFile;
  }
}

function downloadHighResPng() {
  if (!state.processedBlob || !state.processedObjectUrl) return;
  const link = document.createElement('a');
  link.href = state.processedObjectUrl;
  link.download = state.processedFileName || 'clearcut-highres.png';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function deleteMetadataRow(id) {
  try {
    const res = await fetch(`/api/metadata/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to delete metadata row.');
    }
    await refreshMetadataLog();
  } catch (err) {
    showAlert('error', err.message);
  }
}

async function refreshMetadataLog() {
  try {
    const res = await fetch('/api/metadata?limit=25');
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to fetch metadata log.');
    }

    const { items, stats, storage } = data;

    // Update KPI cards
    dom.kpiBlobCount.textContent = String(stats.blobColumnsCount ?? 0);
    dom.kpiTotalFiles.textContent = String(stats.totalFiles ?? items.length);
    dom.kpiObjectBytes.textContent = formatBytes(stats.totalObjectBytes ?? 0);

    if (storage.gcsConfigured) {
      dom.kpiStorageDriver.textContent = 'Google Cloud Storage';
      dom.kpiStorageDetail.textContent = `Bucket: ${storage.bucketName}`;
    } else {
      dom.kpiStorageDriver.textContent = 'Ephemeral Fallback';
      dom.kpiStorageDetail.textContent = `${storage.ephemeralCachedObjects}/${storage.ephemeralMaxObjects} objects cached (GCS-ready)`;
    }

    // Populate table rows
    if (!items || items.length === 0) {
      dom.metadataTableBody.innerHTML = `
        <tr>
          <td colspan="8" class="px-4 py-10 text-center text-slate-500 font-sans">
            No processed images logged yet. Upload an image above to see live zero-BLOB metadata records appear here.
          </td>
        </tr>
      `;
      return;
    }

    dom.metadataTableBody.innerHTML = items
      .map(
        (row) => `
        <tr class="hover:bg-slate-900/60 transition">
          <td class="px-4 py-3 text-emerald-400 font-semibold">#${escapeHtml(row.id)}</td>
          <td class="px-4 py-3 text-slate-100 max-w-[200px] truncate" title="${escapeHtml(row.file_name)}">
            ${escapeHtml(row.file_name)}
          </td>
          <td class="px-4 py-3 max-w-[240px] truncate">
            <a
              href="${escapeHtml(row.file_url)}"
              target="_blank"
              rel="noopener noreferrer"
              class="text-teal-300 hover:text-emerald-300 underline underline-offset-2"
              title="${escapeHtml(row.file_url)}"
            >
              ${escapeHtml(row.file_url)}
            </a>
          </td>
          <td class="px-4 py-3 text-slate-300 whitespace-nowrap">${escapeHtml(formatBytes(row.file_size))}</td>
          <td class="px-4 py-3">
            <span class="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/25 text-emerald-300">
              ${escapeHtml(row.content_type)}
            </span>
          </td>
          <td class="px-4 py-3 text-slate-300 whitespace-nowrap">${escapeHtml(row.resolution)}</td>
          <td class="px-4 py-3 text-slate-400 whitespace-nowrap">${escapeHtml(row.created_at)}</td>
          <td class="px-4 py-3 text-right">
            <button
              type="button"
              data-delete-id="${escapeHtml(row.id)}"
              class="delete-row-btn inline-flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 transition cursor-pointer"
              title="Delete metadata row"
            >
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </td>
        </tr>
      `
      )
      .join('');

    dom.metadataTableBody.querySelectorAll('.delete-row-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteMetadataRow(btn.dataset.deleteId));
    });
    renderIcons();
  } catch (err) {
    console.error('[Metadata Log Error]', err);
    dom.metadataTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="px-4 py-6 text-center text-rose-300 font-sans">
          Unable to load SQL metadata log: ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

function bindEvents() {
  // Click / Keyboard to open file picker
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFileSelection(file);
    e.target.value = '';
  });

  // Drag & Drop handlers
  ['dragenter', 'dragover'].forEach((evt) => {
    dom.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropZone.classList.add('dropzone-active');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    dom.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropZone.classList.remove('dropzone-active');
    });
  });

  dom.dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFileSelection(file);
  });

  // Process & Download
  dom.loadSampleBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/sample-studio-mug.jpg');
      if (!res.ok) throw new Error('Could not load sample studio image.');
      const blob = await res.blob();
      const sampleFile = new File([blob], 'sample-studio-mug.jpg', { type: 'image/jpeg' });
      await handleFileSelection(sampleFile);
    } catch (err) {
      showAlert('error', err.message || 'Failed to load sample image.');
    }
  });
  dom.processBtn.addEventListener('click', runBackgroundRemovalPipeline);
  dom.downloadBtn.addEventListener('click', downloadHighResPng);

  // Before vs After controls
  dom.splitSliderInput.addEventListener('input', (e) => updateSplitPosition(e.target.value));
  dom.modeSplitBtn.addEventListener('click', () => updateViewMode('split'));
  dom.modeSideBtn.addEventListener('click', () => updateViewMode('side'));

  // Backdrop controls
  dom.backdropButtons.forEach((btn) => {
    btn.addEventListener('click', () => applyBackdrop(btn.dataset.backdrop));
  });
  dom.customColorPicker.addEventListener('input', (e) => applyBackdrop(e.target.value));

  // Refresh log
  dom.refreshLogBtn.addEventListener('click', refreshMetadataLog);
}

// Bootstrap
renderIcons();
bindEvents();
applyBackdrop('checkerboard');
refreshMetadataLog();
