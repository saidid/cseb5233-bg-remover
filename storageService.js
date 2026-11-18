'use strict';

const crypto = require('crypto');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

/**
 * Object Storage Layer (GCP Best Practice: Files -> Object Storage)
 * -------------------------------------------------------------------------
 * 1. Primary Mode (GCS): When `GCS_BUCKET_NAME` is configured, uploads processed
 *    image binaries to Google Cloud Storage via `@google-cloud/storage`.
 * 2. Fallback Mode (Ephemeral In-Memory Object Store): When `GCS_BUCKET_NAME`
 *    is not set (or GCS credentials are unavailable in local/sandbox runs),
 *    seamlessly stores binary objects in a bounded FIFO in-memory map served
 *    via `/api/objects/:objectId` so the app runs 100% error-free everywhere.
 */

const MAX_EPHEMERAL_OBJECTS = 25;
const ephemeralObjectStore = new Map();

const configuredBucketName = (process.env.GCS_BUCKET_NAME || '').trim();
const configuredPublicBaseUrl = (process.env.GCS_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

let gcsClient = null;
let gcsInitError = null;

if (configuredBucketName) {
  try {
    gcsClient = new Storage();
  } catch (err) {
    gcsInitError = err.message;
    console.warn(`[StorageService] Failed to initialize GCS client (${err.message}). Ephemeral fallback enabled.`);
  }
}

function sanitizeFileName(rawName) {
  const base = path.basename(String(rawName || 'clearcut-image.png'));
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 96);
  return cleaned || 'clearcut-image.png';
}

function storeInEphemeralMap({ buffer, fileName, contentType }) {
  // Enforce bounded memory footprint on Cloud Run containers
  while (ephemeralObjectStore.size >= MAX_EPHEMERAL_OBJECTS) {
    const oldestKey = ephemeralObjectStore.keys().next().value;
    ephemeralObjectStore.delete(oldestKey);
  }

  const ext = contentType === 'image/jpeg' ? '.jpg' : contentType === 'image/webp' ? '.webp' : '.png';
  const objectId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

  ephemeralObjectStore.set(objectId, {
    objectId,
    fileName,
    contentType,
    size: buffer.length,
    buffer,
    createdAt: new Date().toISOString(),
  });

  return {
    fileUrl: `/api/objects/${objectId}`,
    objectId,
    mode: 'ephemeral-fallback',
    bucket: null,
  };
}

/**
 * Uploads a binary image buffer to Google Cloud Storage (if configured)
 * or seamlessly falls back to the ephemeral object store.
 */
async function uploadObject({ buffer, originalName, contentType = 'image/png' }) {
  const safeName = sanitizeFileName(originalName);

  if (configuredBucketName && gcsClient) {
    const objectKey = `processed/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName}`;
    try {
      const bucket = gcsClient.bucket(configuredBucketName);
      const file = bucket.file(objectKey);

      await file.save(buffer, {
        resumable: false,
        contentType,
        metadata: {
          cacheControl: 'public, max-age=3600',
          metadata: {
            sourceApp: 'ClearCut-Cloud',
            course: 'CSEB5233-2627S1',
          },
        },
      });

      const baseUrl = configuredPublicBaseUrl || `https://storage.googleapis.com/${configuredBucketName}`;
      return {
        fileUrl: `${baseUrl}/${objectKey}`,
        objectId: objectKey,
        mode: 'gcs',
        bucket: configuredBucketName,
        fallbackReason: null,
      };
    } catch (err) {
      console.warn(
        `[StorageService] GCS upload to bucket "${configuredBucketName}" failed (${err.message}). Falling back to ephemeral object store.`
      );
      const fallbackResult = storeInEphemeralMap({
        buffer,
        fileName: safeName,
        contentType,
      });
      return {
        ...fallbackResult,
        fallbackReason: `GCS unreachable (${err.code || err.message}); served via ephemeral fallback`,
      };
    }
  }

  const ephemeralResult = storeInEphemeralMap({
    buffer,
    fileName: safeName,
    contentType,
  });

  return {
    ...ephemeralResult,
    fallbackReason: configuredBucketName
      ? `GCS client unavailable (${gcsInitError || 'init error'})`
      : 'GCS_BUCKET_NAME not configured (ephemeral object URL fallback active)',
  };
}

/**
 * Retrieves an object stored in the ephemeral fallback store.
 */
function getEphemeralObject(objectId) {
  return ephemeralObjectStore.get(objectId) || null;
}

/**
 * Removes an object from the ephemeral fallback store when its metadata row is deleted.
 */
function deleteEphemeralObjectByUrl(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/api/objects/')) {
    return false;
  }
  const objectId = fileUrl.slice('/api/objects/'.length);
  return ephemeralObjectStore.delete(objectId);
}

/**
 * Reports current Object Storage configuration status for health/UI badges.
 */
function getStorageStatus() {
  const gcsConfigured = Boolean(configuredBucketName && gcsClient);
  return {
    driver: gcsConfigured ? 'google-cloud-storage' : 'ephemeral-object-fallback',
    gcsConfigured,
    bucketName: gcsConfigured ? configuredBucketName : null,
    ephemeralCachedObjects: ephemeralObjectStore.size,
    ephemeralMaxObjects: MAX_EPHEMERAL_OBJECTS,
    note: gcsConfigured
      ? `Connected to Google Cloud Storage bucket: ${configuredBucketName}`
      : 'Seamless ephemeral object URL fallback active (set GCS_BUCKET_NAME to persist objects to Google Cloud Storage)',
  };
}

module.exports = {
  uploadObject,
  getEphemeralObject,
  deleteEphemeralObjectByUrl,
  getStorageStatus,
  sanitizeFileName,
};
