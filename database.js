'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

/**
 * SQL Metadata Layer (GCP Best Practice: 0 BLOBs stored in SQL)
 * -------------------------------------------------------------------------
 * Only lightweight metadata columns are stored in `attachments_metadata`.
 * Binary image files are NEVER stored as BLOB/BYTEA/VARBINARY inside SQL.
 */
function initializeDatabase() {
  const configuredPath = process.env.DB_PATH || path.join(__dirname, 'data', 'clearcut_metadata.db');
  const resolvedPath = path.resolve(configuredPath);

  let db;
  let activePath = resolvedPath;

  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    db = new Database(resolvedPath);
  } catch (err) {
    // Graceful fallback to OS temp dir if container filesystem is read-only
    const fallbackPath = path.join(os.tmpdir(), 'clearcut_metadata.db');
    console.warn(`[Database] Failed to open ${resolvedPath} (${err.message}). Falling back to ${fallbackPath}`);
    activePath = fallbackPath;
    db = new Database(fallbackPath);
  }

  // Enable WAL mode for fast concurrent reads/writes
  db.pragma('journal_mode = WAL');

  // Strict zero-BLOB schema required by GCP Best Practices
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_url TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      resolution TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_attachments_created_at
    ON attachments_metadata (created_at DESC);
  `);

  return { db, activePath };
}

const { db, activePath: dbFilePath } = initializeDatabase();

const insertStmt = db.prepare(`
  INSERT INTO attachments_metadata (file_name, file_url, file_size, content_type, resolution)
  VALUES (@file_name, @file_url, @file_size, @content_type, @resolution)
`);

const selectByIdStmt = db.prepare(`
  SELECT id, file_name, file_url, file_size, content_type, resolution, created_at
  FROM attachments_metadata
  WHERE id = ?
`);

const selectRecentStmt = db.prepare(`
  SELECT id, file_name, file_url, file_size, content_type, resolution, created_at
  FROM attachments_metadata
  ORDER BY id DESC
  LIMIT ?
`);

const deleteByIdStmt = db.prepare(`
  DELETE FROM attachments_metadata
  WHERE id = ?
`);

const summaryStatsStmt = db.prepare(`
  SELECT
    COUNT(*) AS total_files,
    COALESCE(SUM(file_size), 0) AS total_object_bytes
  FROM attachments_metadata
`);

/**
 * Inserts a lightweight metadata record (strictly no binary/BLOB fields).
 */
function insertMetadata({ file_name, file_url, file_size, content_type, resolution }) {
  const result = insertStmt.run({
    file_name,
    file_url,
    file_size,
    content_type,
    resolution,
  });

  return selectByIdStmt.get(result.lastInsertRowid);
}

/**
 * Fetches the latest metadata rows ordered newest first.
 */
function getRecentMetadata(limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  return selectRecentStmt.all(safeLimit);
}

/**
 * Fetches a single metadata record by ID.
 */
function getMetadataById(id) {
  return selectByIdStmt.get(Number(id));
}

/**
 * Deletes a metadata record by ID and returns the removed record (if found).
 */
function deleteMetadataById(id) {
  const existing = getMetadataById(id);
  if (!existing) {
    return null;
  }
  deleteByIdStmt.run(Number(id));
  return existing;
}

/**
 * Inspects table schema via PRAGMA to verify 0 BLOB columns exist
 * and returns aggregate storage & SQL footprint statistics.
 */
function getSchemaAudit() {
  const columns = db.pragma('table_info(attachments_metadata)');
  const blobColumns = columns.filter((col) => {
    const type = String(col.type || '').toUpperCase();
    const name = String(col.name || '').toLowerCase();
    return type.includes('BLOB') || type.includes('BYTEA') || type.includes('VARBINARY') || name.includes('blob');
  });

  const stats = summaryStatsStmt.get();
  let sqliteFileBytes = 0;
  try {
    if (fs.existsSync(dbFilePath)) {
      sqliteFileBytes = fs.statSync(dbFilePath).size;
    }
  } catch {
    sqliteFileBytes = 0;
  }

  return {
    table: 'attachments_metadata',
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    blobColumnsCount: blobColumns.length,
    isZeroBlobCompliant: blobColumns.length === 0,
    totalFiles: stats.total_files,
    totalObjectBytes: stats.total_object_bytes,
    sqliteFileBytes,
    dbPath: path.basename(dbFilePath),
  };
}

module.exports = {
  db,
  dbFilePath,
  insertMetadata,
  getRecentMetadata,
  getMetadataById,
  deleteMetadataById,
  getSchemaAudit,
};
