'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const {
  insertMetadata,
  getRecentMetadata,
  deleteMetadataById,
  getSchemaAudit,
} = require('./database');
const {
  uploadObject,
  getEphemeralObject,
  deleteEphemeralObjectByUrl,
  getStorageStatus,
  sanitizeFileName,
} = require('./storageService');

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB for full-res transparent PNGs

const FORMAT_TO_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const ALLOWED_UPLOAD_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Use in-memory buffer upload so files are inspected by Sharp and routed
// straight to Object Storage (never written to SQL as BLOBs).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
      const err = new Error('Unsupported file type. Only PNG, JPG/JPEG, and WEBP images are accepted.');
      err.statusCode = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});

/**
 * GET /api/health
 * Google Cloud Run readiness/liveness probe and architectural compliance summary.
 */
app.get('/api/health', (_req, res) => {
  const schemaAudit = getSchemaAudit();
  const storageStatus = getStorageStatus();

  res.status(200).json({
    status: 'ok',
    service: 'ClearCut Cloud — High-Resolution AI Image Background Remover',
    course: 'CSEB5233 Designing Applications on Cloud (2627S1)',
    port: Number(PORT),
    uptimeSeconds: Math.round(process.uptime()),
    storage: storageStatus,
    database: schemaAudit,
    gcpBestPracticeBadge:
      'GCP Best Practice Active: Files -> Object Storage (GCS) | Metadata -> SQL (0 BLOBs stored)',
  });
});

/**
 * POST /api/process-metadata
 * Validates uploaded high-resolution image via Sharp (actual binary headers,
 * dimensions, MIME type, byte size), stores binary file in Object Storage
 * (GCS or ephemeral fallback), and logs ONLY lightweight metadata to SQLite.
 */
app.post('/api/process-metadata', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided. Send a multipart/form-data request with field name "image".',
      });
    }

    // 1. Validate binary image integrity, dimensions, and real format via Sharp
    let imgMeta;
    try {
      imgMeta = await sharp(req.file.buffer).metadata();
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid or corrupted image file. Sharp could not decode the binary payload.',
      });
    }

    const detectedFormat = String(imgMeta.format || '').toLowerCase();
    const canonicalMime = FORMAT_TO_MIME[detectedFormat];

    if (!canonicalMime) {
      return res.status(400).json({
        success: false,
        error: `Unsupported decoded image format "${detectedFormat || 'unknown'}". Allowed formats: PNG, JPEG, WEBP.`,
      });
    }

    const width = Number(imgMeta.width || 0);
    const height = Number(imgMeta.height || 0);
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
      return res.status(400).json({
        success: false,
        error: `Invalid image dimensions (${width}x${height}). Width and height must be between 1 and 16384 pixels.`,
      });
    }

    const resolution = `${width}x${height}`;
    const fileSize = req.file.buffer.length;
    const requestedName = (req.body && req.body.fileName) || req.file.originalname || `clearcut-${Date.now()}.png`;
    const safeFileName = sanitizeFileName(requestedName);

    // 2. Upload binary object to Object Storage Layer (GCS or Ephemeral Fallback)
    const storageResult = await uploadObject({
      buffer: req.file.buffer,
      originalName: safeFileName,
      contentType: canonicalMime,
    });

    // 3. Persist ONLY lightweight metadata in SQL (`attachments_metadata` — 0 BLOBs)
    const metadataRow = insertMetadata({
      file_name: safeFileName,
      file_url: storageResult.fileUrl,
      file_size: fileSize,
      content_type: canonicalMime,
      resolution,
    });

    return res.status(201).json({
      success: true,
      metadata: metadataRow,
      validation: {
        width,
        height,
        resolution,
        format: detectedFormat,
        contentType: canonicalMime,
        fileSize,
        hasAlpha: Boolean(imgMeta.hasAlpha),
        channels: imgMeta.channels || null,
      },
      storage: {
        mode: storageResult.mode,
        bucket: storageResult.bucket,
        fallbackReason: storageResult.fallbackReason,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/metadata
 * Lists the latest processed image metadata rows from `attachments_metadata`
 * along with schema compliance stats and active object storage status.
 */
app.get('/api/metadata', (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 25;
    const items = getRecentMetadata(limit);
    const schemaAudit = getSchemaAudit();
    const storageStatus = getStorageStatus();

    return res.status(200).json({
      success: true,
      items,
      stats: schemaAudit,
      storage: storageStatus,
      architectureBadge:
        'GCP Best Practice Active: Files -> Object Storage (GCS) | Metadata -> SQL (0 BLOBs stored)',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/metadata/:id
 * Removes a metadata record from SQL and evicts its ephemeral object (if any).
 */
app.delete('/api/metadata/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid metadata ID.' });
    }

    const removed = deleteMetadataById(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Metadata record not found.' });
    }

    deleteEphemeralObjectByUrl(removed.file_url);
    return res.status(200).json({ success: true, deleted: removed });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/objects/:objectId
 * Serves processed binary files stored in the ephemeral fallback object layer.
 */
app.get('/api/objects/:objectId', (req, res) => {
  const objectId = path.basename(req.params.objectId || '');
  const obj = getEphemeralObject(objectId);

  if (!obj) {
    return res.status(404).json({
      success: false,
      error: 'Ephemeral object not found or evicted. Configure GCS_BUCKET_NAME for durable object persistence.',
    });
  }

  res.setHeader('Content-Type', obj.contentType);
  res.setHeader('Content-Length', obj.size);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${obj.fileName}"`);
  res.setHeader('X-Storage-Layer', 'ephemeral-object-fallback');
  return res.status(200).send(obj.buffer);
});

/**
 * Fallback route to serve the SPA frontend for unknown non-API GET routes.
 */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'API endpoint not found.' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) next(err);
  });
});

/**
 * Global JSON error handler (handles Multer upload errors & validation failures).
 */
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds maximum allowed size (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`
        : err.message;
    return res.status(status).json({ success: false, error: message });
  }

  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) {
    console.error('[Server Error]', err);
  }
  return res.status(statusCode).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

// CRITICAL FOR GOOGLE CLOUD RUN: bind to 0.0.0.0 and process.env.PORT || 8080
app.listen(PORT, '0.0.0.0', () => {
  const storageStatus = getStorageStatus();
  const audit = getSchemaAudit();
  console.log('======================================================================');
  console.log(`ClearCut Cloud running on http://0.0.0.0:${PORT}`);
  console.log('Course  : CSEB5233 Designing Applications on Cloud (2627S1)');
  console.log('Students: 1. Abdullah Mujaddid Adli Bin Abdul Halim (BSW01084329)');
  console.log('          2. SHAH SIRAJUDDIN BIN KAMARUDIN (BSW01085924)');
  console.log(`Storage : ${storageStatus.driver}${storageStatus.bucketName ? ` (${storageStatus.bucketName})` : ''}`);
  console.log(`SQL DB  : ${audit.table} (${audit.blobColumnsCount} BLOB columns — Zero-BLOB Compliant)`);
  console.log('======================================================================');
});
